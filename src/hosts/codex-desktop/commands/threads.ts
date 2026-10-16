import { evaluateInPage } from "../cdp.ts";
import type { CdpTarget } from "../cdp.ts";
import {
  findLocalConversationManagerInPage, listLoadedThreadsInPage, reclaimIdleThreadsInPage,
} from "../page/threads.ts";
import type { LoadedThread, ReclaimResult, ThreadKind, ThreadState } from "../page/threads.ts";
import type { CommandContext } from "./context.ts";

export const GC_DEFAULT_IDLE_MINUTES = 60;
const PAGE_TIMEOUT_MS = 60000;

const THREAD_STATE_ORDER: ThreadState[] = ["waiting", "running", "viewing", "idle"];
const THREAD_STATE_LABELS: Record<ThreadState, string> = {
  waiting: "等待审批或输入",
  running: "进行中",
  viewing: "查看中",
  idle: "闲置",
};
const THREAD_KIND_ORDER: ThreadKind[] = ["main", "subagent", "released", "prewarm", "ephemeral"];

export interface GcOptions {
  dryRun: boolean;
  idleMinutes: number;
}

// 逐页执行并汇总；单页失败不丢弃其它页的结果，全部失败时抛出第一条错误。
async function eachPage<T>(targets: CdpTarget[], run: (target: CdpTarget) => Promise<T>): Promise<{ results: T[]; pageErrors: string[] }> {
  const results: T[] = [];
  const pageErrors: string[] = [];
  for (const target of targets) {
    try {
      results.push(await run(target));
    } catch (error) {
      pageErrors.push((error as Error).message);
    }
  }
  if (pageErrors.length === targets.length) throw new Error(pageErrors[0]);
  return { results, pageErrors };
}

// 已加载列表来自共享的 App Server，前端跟踪状态按窗口区分；多窗口时取跟踪了该对话的窗口所见状态。
export async function listLoadedThreads(targets: CdpTarget[]): Promise<LoadedThread[]> {
  const expression = `(${listLoadedThreadsInPage})((${findLocalConversationManagerInPage})())`;
  const { results } = await eachPage(targets, (target) => evaluateInPage(target, expression, PAGE_TIMEOUT_MS));
  const merged = new Map<string, LoadedThread>();
  for (const thread of results.flat() as LoadedThread[]) {
    const known = merged.get(thread.id);
    if (!known || (!known.tracked && thread.tracked)) merged.set(thread.id, thread);
  }
  return [...merged.values()];
}

function threadKindTag(thread: LoadedThread): string {
  if (thread.kind === "subagent" && thread.subagent) {
    const agent = [thread.subagent.nickname, thread.subagent.role && `(${thread.subagent.role})`].filter(Boolean).join(" ");
    return `[子代理 ${agent || "?"} ← ${thread.subagent.parentTitle}]`;
  }
  if (thread.kind === "released") return "[已回收，等待卸载]";
  if (thread.kind === "prewarm") return "[预热的空白新对话]";
  if (thread.kind === "ephemeral") return `[临时线程${thread.source ? ` ${thread.source}` : ""}]`;
  if (!thread.tracked) return `[前端未跟踪${thread.source ? ` ${thread.source}` : ""}]`;
  return "";
}

export function formatLoadedThreads(threads: LoadedThread[], { commandName, userHome }: { commandName: string; userHome: string }): string {
  const sorted = [...threads].sort((left, right) => (
    THREAD_KIND_ORDER.indexOf(left.kind) - THREAD_KIND_ORDER.indexOf(right.kind)
    || THREAD_STATE_ORDER.indexOf(left.state) - THREAD_STATE_ORDER.indexOf(right.state)
    || (right.idleMinutes ?? 0) - (left.idleMinutes ?? 0)
  ));
  const count = (predicate: (thread: LoadedThread) => boolean) => threads.filter(predicate).length;
  const counts = THREAD_STATE_ORDER
    .map((state): [string, number] => [THREAD_STATE_LABELS[state], count((thread) => thread.state === state)])
    .concat([
      ["其中子代理", count((thread) => thread.kind === "subagent")],
      ["等待卸载", count((thread) => thread.kind === "released")],
      ["预热", count((thread) => thread.kind === "prewarm")],
      ["临时", count((thread) => thread.kind === "ephemeral")],
    ])
    .filter(([, value]) => value)
    .map(([label, value]) => `${label} ${value}`);
  const lines = [`已加载对话: ${threads.length}${counts.length ? `（${counts.join(" · ")}）` : ""}`];
  for (const thread of sorted) {
    const state = thread.state === "idle" ? `闲置 ${thread.idleMinutes} 分钟` : THREAD_STATE_LABELS[thread.state];
    const title = [threadKindTag(thread), thread.title || (["main", "released"].includes(thread.kind) ? thread.id : "")].filter(Boolean).join(" ");
    const cwd = thread.cwd ? `  ${thread.cwd.replace(userHome, "~")}` : "";
    lines.push(`  - ${state}｜${title}${cwd}`);
  }
  if (threads.some((thread) => thread.state === "idle" && (thread.kind === "main" || thread.kind === "subagent"))) {
    lines.push(`  闲置的对话与子代理可用 \`${commandName} gc\` 回收`);
  }
  return lines.join("\n");
}

export function formatGcReport(result: ReclaimResult, { dryRun, idleMinutes }: GcOptions): string {
  const list = (items: ReclaimResult["reclaimed"]) => items.map(({ title, idleMinutes: idle }) => `    - ${title}（闲置 ${idle} 分钟）`);
  const lines = [`闲置对话回收${dryRun ? "（dry-run）" : ""}：闲置 ≥ ${idleMinutes} 分钟`];
  lines.push(`  ${dryRun ? "将回收" : "已回收"} ${result.reclaimed.length}`, ...list(result.reclaimed));
  if (result.failed.length) lines.push(`  失败 ${result.failed.length}`, ...list(result.failed));
  if (result.subagentListFailed) lines.push("  子代理盘点失败，本次只处理前端跟踪的对话");
  if (!dryRun && result.reclaimed.length) lines.push("  App Server 约 1 分钟后卸载这些对话并结束其 MCP 等进程");
  lines.push(`  跳过    未满 ${idleMinutes} 分钟 ${result.recent} · 受官方保护 ${result.guarded} · 后台终端 ${result.backgroundTerminal} · 终端盘点失败 ${result.terminalCheckFailed}`);
  return lines.join("\n");
}

export function parseGcOptions(args: string[]): GcOptions {
  const options: GcOptions = { dryRun: false, idleMinutes: GC_DEFAULT_IDLE_MINUTES };
  let thresholdSet = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "-t") {
      const raw = args[++index];
      const minutes = Number(raw);
      if (thresholdSet) throw new Error("gc 的 -t 只能指定一次");
      if (raw == null || !raw.trim() || !Number.isFinite(minutes) || minutes < 0) {
        throw new Error("gc 的 -t 需要非负分钟数");
      }
      options.idleMinutes = minutes;
      thresholdSet = true;
    } else {
      throw new Error(`gc 不支持参数：${arg}`);
    }
  }
  return options;
}

// 每个窗口各自持有订阅，只回收本窗口拥有的对话，所以逐页执行再汇总。
// 子代理由共享的 App Server 统一列出，只在第一个成功的窗口处理一次，避免重复取消订阅。
export async function reclaimIdleThreads(targets: CdpTarget[], { dryRun, idleMinutes }: GcOptions): Promise<{ total: ReclaimResult; pageErrors: string[] }> {
  const total: ReclaimResult = {
    recent: 0, guarded: 0, backgroundTerminal: 0, terminalCheckFailed: 0,
    subagentListFailed: false, reclaimed: [], failed: [],
  };
  let subagentsHandled = false;
  const { pageErrors } = await eachPage(targets, async (target) => {
    const options = JSON.stringify({ idleMs: idleMinutes * 60000, dryRun, subagents: !subagentsHandled });
    const result: ReclaimResult = await evaluateInPage(target,
      `(${reclaimIdleThreadsInPage})(${options}, ${findLocalConversationManagerInPage}, ${listLoadedThreadsInPage})`,
      PAGE_TIMEOUT_MS);
    for (const key of ["recent", "guarded", "backgroundTerminal", "terminalCheckFailed"] as const) total[key] += result[key];
    total.reclaimed.push(...result.reclaimed);
    total.failed.push(...result.failed);
    if (!subagentsHandled) total.subagentListFailed = result.subagentListFailed;
    subagentsHandled = true;
  });
  return { total, pageErrors };
}

export async function gcCommand({ config, cdp }: CommandContext, args: string[]): Promise<void> {
  const options = parseGcOptions(args);
  const targets = await cdp.targets().catch(() => []);
  if (!targets.length) throw new Error(`gc 需要 Codex+ 模式；请先执行 \`${config.commandName} start\``);
  const { total, pageErrors } = await reclaimIdleThreads(targets, options);
  console.log(formatGcReport(total, options));
  for (const message of pageErrors) console.error(`${config.commandName}: 部分窗口回收失败：${message}`);
  if (total.failed.length || pageErrors.length) process.exitCode = 1;
}
