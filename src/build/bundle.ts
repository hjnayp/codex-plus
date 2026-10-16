import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import type * as Esbuild from "esbuild";
import { PAGE_FEATURES } from "../hosts/codex-desktop/page/features.ts";
import type { PageFeatureEntry } from "../hosts/codex-desktop/page/features.ts";

const GENERATED_NOTICE = "// 由 `codex+ update` 从 src 打包生成；不要手改，改源码后重新执行 update。";
const PAGE_FEATURE_DIR = "src/hosts/codex-desktop/page/features";

// esbuild 只在打包时按包目录加载：运行中的单文件产物不内联它，也不依赖 node_modules。
function loadEsbuild(packageRoot: string): typeof Esbuild {
  return createRequire(path.join(packageRoot, "package.json"))("esbuild");
}

async function bundleEntry(packageRoot: string, entry: string, options: Esbuild.BuildOptions): Promise<string> {
  const result = await loadEsbuild(packageRoot).build({
    entryPoints: [path.join(packageRoot, entry)], absWorkingDir: packageRoot,
    bundle: true, write: false, charset: "utf8", legalComments: "inline", logLevel: "silent", ...options,
  });
  const [output] = result.outputFiles ?? [];
  if (!output) throw new Error(`esbuild 未产出 ${entry}`);
  return output.text;
}

/// 把界面能力编译成可直接注入页面的独立 IIFE。
export function buildPageScript(packageRoot: string, { entry }: PageFeatureEntry): Promise<string> {
  return bundleEntry(packageRoot, `${PAGE_FEATURE_DIR}/${entry}`, { platform: "browser", format: "iife", target: "es2024" });
}

/// 编译全部界面能力，按能力 id 索引。
export async function buildPageScripts(packageRoot: string): Promise<Record<string, string>> {
  const scripts: Record<string, string> = {};
  for (const feature of PAGE_FEATURES) scripts[feature.id] = await buildPageScript(packageRoot, feature);
  return scripts;
}

/// 把 CLI 打包成单文件产物，并内联注入脚本；对同一份源码确定性，只写入源码指纹。
export async function buildBundle(packageRoot: string): Promise<{ source: string; revision: string }> {
  const code = (await bundleEntry(packageRoot, "src/hosts/codex-desktop/main.ts", { platform: "node", format: "esm" }))
    .replace(/^#!.*\n/, "");
  const renderers = await buildPageScripts(packageRoot);
  const digest = createHash("sha256").update(code);
  for (const id of Object.keys(renderers).sort()) digest.update(renderers[id]);
  const revision = digest.digest("hex").slice(0, 12);
  const source = [
    "#!/usr/bin/env node",
    GENERATED_NOTICE,
    `globalThis.__CODEX_PLUS_BUNDLE__ = ${JSON.stringify({ revision, renderers })};`,
    code,
  ].join("\n");
  return { source, revision };
}

/// Claude Code 函数 hook 只允许导入插件内相对路径，所以依赖全部内联成单文件。
export async function buildClaudeHooks(packageRoot: string): Promise<string> {
  return bundleEntry(packageRoot, "src/hosts/claude-code/hooks.ts", {
    platform: "neutral", format: "esm",
    banner: { js: GENERATED_NOTICE },
  });
}
