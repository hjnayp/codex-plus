import fsPromises from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { buildPageScript } from "../../build/bundle.ts";
import { compileHashRules } from "../../core/hash-rules.ts";
import { CdpClient } from "./cdp.ts";
import type { CdpTarget } from "./cdp.ts";
import { PAGE_FEATURES } from "./page/features.ts";

// 源码检出时按需编译界面能力；打包产物已内联编译结果，不会走到这里。
const SOURCE_PACKAGE_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

// 旧版 stop 留下了可调用的回收闭包；升级已打开页面时先恢复旧适配并停止监听，再删除组件入口，不执行旧回收代码。
const RETIRED_CLEANUP = `(() => {
  for (const key of [
    "__CODEX_PLUS_REMOVE__", "__CODEX_PLUS_WEEKLY_USAGE_RING_CLEANUP__",
    "__CODEX_PLUS_STYLE_PERFORMANCE_CLEANUP__", "__CODEX_PLUS_TERMINAL_MEASURE_CLEANUP__",
    "__CODEX_PLUS_PORTRAITS_CLEANUP__", "__CODEX_PLUS_BROWSER_FAVORITES_CLEANUP__",
  ]) {
    try { window[key]?.(); } catch { /* 旧组件缺失或已清理。 */ }
  }
  for (const key of [
    "__CODEX_PLUS_PUSH__", "__CODEX_PLUS_CLEANUP__", "__CODEX_PLUS_REMOVE__",
    "__CODEX_PLUS_DEBUG__", "__codexPlusOnlyVersion",
    "__CODEX_PLUS_WEEKLY_USAGE_RING_REFRESH__", "__CODEX_PLUS_WEEKLY_USAGE_RING_CLEANUP__",
    "__CODEX_PLUS_HEADROOM_GENERATION_PUSH__", "__CODEX_PLUS_HEADROOM_REQUEST__",
    "__codexPlusWeeklyUsageRingVersion",
    "__CODEX_PLUS_STYLE_PERFORMANCE__", "__CODEX_PLUS_STYLE_PERFORMANCE_CLEANUP__",
    "__CODEX_PLUS_TERMINAL_MEASURE__", "__CODEX_PLUS_TERMINAL_MEASURE_CLEANUP__",
    "__CODEX_PLUS_PORTRAITS_CLEANUP__", "__CODEX_PLUS_BROWSER_FAVORITES_CLEANUP__",
  ]) delete window[key];
  document.querySelectorAll(".codex-plus-only-footer, #codex-plus-only-style, #codex-plus-weekly-usage-ring, #codex-plus-weekly-usage-ring-style")
    .forEach((node) => node.remove());
  document.querySelectorAll("#codex-plus-subagent-portraits, #codex-plus-browser-favorites-style, .codex-plus-browser-favorites, .codex-plus-browser-favorites-dialog")
    .forEach((node) => node.remove());
  document.querySelectorAll("[data-codex-plus-only-host], [data-codex-plus-footer]").forEach((node) => {
    for (const attribute of ["data-codex-plus-only-host", "data-codex-plus-footer", "data-codex-plus-session-id", "data-codex-plus-turn-id"])
      node.removeAttribute(attribute);
  });
  for (const key of [
    "__CODEX_PLUS_RUNTIME_GC__", "__CODEX_PLUS_RUNTIME_GC_CURRENT_THREAD_ID__",
    "__CODEX_PLUS_RUNTIME_GC_WARNING__", "__CODEX_PLUS_RUNTIME_GC_CLEANUP__",
    "__CODEX_PLUS_APP_SERVER_REQUEST__", "__codexPlusRuntimeGcVersion",
  ]) delete window[key];
  document.getElementById("codex-plus-runtime-gc-toast")?.remove();
  document.getElementById("codex-plus-runtime-gc-style")?.remove();
})();`;

const CLEANUP = `Promise.allSettled([${[...PAGE_FEATURES].reverse()
  .map(({ cleanup }) => `Promise.resolve().then(() => window.${cleanup}?.())`).join(",")}])`
  + ".then(() => { delete window.__CODEX_PLUS_HASH_RULES__; delete window.__CODEX_PLUS_COMPILE_HASH_RULES__; })";

export interface Renderers {
  /// 按登记键索引的各注入脚本源码。
  sources: Record<string, string>;
  /// 只推送缩写规则的脚本，供 reload 更新已打开页面。
  rulesSource: string;
  /// 完整注入脚本：退役清理、规则与全部界面能力。
  source: string;
  cleanup: string;
}

// 打包产物把注入脚本内联到 __CODEX_PLUS_BUNDLE__，源码检出现场编译；两种入口共用同一取值口径。
export async function readRendererSource(id: string): Promise<string> {
  const bundled = (globalThis as any).__CODEX_PLUS_BUNDLE__?.renderers;
  if (bundled) {
    const source = bundled[id];
    if (typeof source !== "string") throw new Error(`打包产物缺少注入脚本：${id}`);
    return source;
  }
  const feature = PAGE_FEATURES.find((candidate) => candidate.id === id);
  if (!feature) throw new Error(`未登记的界面能力：${id}`);
  return buildPageScript(SOURCE_PACKAGE_ROOT, feature);
}

/// 读取并校验缩写规则，组装注入脚本；规则无效时抛错，调用方保留旧注入。
export async function loadRenderers(rulesPath: string | URL = new URL("../../../hash-rules.toml", import.meta.url)): Promise<Renderers> {
  const rules = parseToml(await fsPromises.readFile(rulesPath, "utf8")).rules;
  compileHashRules(rules);
  const rulesSource = `window.__CODEX_PLUS_HASH_RULES__ = ${JSON.stringify(rules)};`;
  const sources = await Promise.all(PAGE_FEATURES.map(async ({ key, id }) => [key, await readRendererSource(id)] as const));
  return {
    sources: Object.fromEntries(sources),
    rulesSource,
    source: [RETIRED_CLEANUP, rulesSource, ...sources.map(([, source]) => source)].join("\n"),
    cleanup: CLEANUP,
  };
}

/// 连接页面，登记新文档注入脚本并在当前文档立即执行一次。
export async function attachRenderers(target: CdpTarget, renderers: Renderers): Promise<CdpClient> {
  const client = new CdpClient(target.webSocketDebuggerUrl);
  try {
    await client.connect();
    await client.send("Page.enable");
    await client.send("Runtime.enable");
    const script = await client.send("Page.addScriptToEvaluateOnNewDocument", { source: renderers.source });
    client.injectedScriptId = script.identifier;
    await client.send("Runtime.evaluate", { expression: renderers.source, awaitPromise: true });
    return client;
  } catch (error) {
    client.close();
    throw error;
  }
}

/// 把规则推给已打开页面，并替换之后导航使用的注入脚本。
export async function reinjectRenderers(client: CdpClient, renderers: Renderers): Promise<void> {
  const evaluated = await client.send("Runtime.evaluate", {
    expression: `${renderers.rulesSource}\nwindow.__CODEX_PLUS_HASH_HIGHLIGHTS_REFRESH__?.();`,
    awaitPromise: true,
  });
  if (evaluated.exceptionDetails) throw new Error("窗口加载规则失败");
  const script = await client.send("Page.addScriptToEvaluateOnNewDocument", { source: renderers.source });
  const oldScript = client.injectedScriptId;
  client.injectedScriptId = script.identifier;
  if (oldScript) await client.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: oldScript });
}
