import { parse } from "smol-toml";
import { applyHashEdits, compileHashRules } from "../../core/hash-rules.ts";
import type { CompiledHashRules } from "../../core/hash-rules.ts";

// `#` 缩写的 Claude Code 宿主适配器：核心给出编辑区间，本模块把它落到 prompt.submit 的文本与 prompt.edit 的着色上。
// 由 `codex+ update` 打包为 claude/hooks/hash-rules.mjs；运行环境没有 Node，文件经 $.fs 读取。

// 以下只声明本适配器用到的 Claude Code 函数 hook 接口。
interface HookApi {
  plugin: { root: string };
  fs: {
    stat(file: string): Promise<{ kind: string; mtimeMs: number; size: number }>;
    read(file: string): Promise<string>;
  };
  ui: { toast(message: string): void };
  prompt: { fill(prompt: { text: string }): Promise<unknown> };
}

interface Decoration {
  start: number;
  end: number;
  color?: string;
  underline?: boolean;
}

interface EditEvent {
  text: string;
  decorations?: Decoration[];
}

interface SubmitEvent {
  text: string;
  command?: unknown;
  isMeta?: boolean;
  origin: { kind: string };
}

type Next<E, R> = ((event: E) => Promise<R>) & { called?: boolean };
type Handler<E, R> = ($: HookApi, event: E, next: Next<E, R>) => Promise<R> | R;
type Register = {
  (event: "prompt.edit", handler: Handler<EditEvent, EditEvent>): unknown;
  (event: "prompt.submit", handler: Handler<SubmitEvent, unknown>): { catch(handler: Handler<SubmitEvent, unknown>): unknown };
};

const RULES_FILE = "../hash-rules.toml";
const CHECK_INTERVAL_MS = 1000;
const HIGHLIGHT = { color: "warning", underline: true };
// 只改写人直接输入的提示；通知、其他会话和定时任务的文本保持原样。
const TYPED_ORIGINS = new Set(["composer", "bridge", "sdk"]);

export function hashDecorations(rules: CompiledHashRules, text: string): Decoration[] {
  return rules.edits(text).edits.map(({ start, end }) => ({ start, end, ...HIGHLIGHT }));
}

let current: { version: string | null; rules: CompiledHashRules | null; error: string | null } = {
  version: null, rules: null, error: null,
};
let checkedAt = -Infinity;

// 规则文件按修改时间与大小判断是否需要重新编译；无效规则保留旧版本，同一版本只提示一次。
async function loadRules($: HookApi, force: boolean): Promise<CompiledHashRules | null> {
  const now = Date.now();
  if (!force && now - checkedAt < CHECK_INTERVAL_MS) return current.rules;
  checkedAt = now;
  const file = `${$.plugin.root}/${RULES_FILE}`;
  let version: string | undefined;
  try {
    const stat = await $.fs.stat(file);
    version = `${stat.kind}:${stat.mtimeMs}:${stat.size}`;
    if (version === current.version) return current.rules;
    const rules = compileHashRules(parse(await $.fs.read(file)).rules);
    current = { version, rules, error: null };
  } catch (error) {
    const message = `Codex+ 缩写规则无效，${current.rules ? "继续使用旧规则" : "暂不展开"}：${(error as Error).message}`;
    if (message !== current.error) $.ui.toast(message);
    current = { ...current, version: version ?? null, error: message };
  }
  return current.rules;
}

// 展开失败不发送原文：放回草稿并说明原因，与 Codex+ 保留草稿的语义一致。
function refuse($: HookApi, e: SubmitEvent, reason: string) {
  if (e.origin.kind === "composer") void $.prompt.fill({ text: e.text });
  return { drop: `Codex+ 缩写展开失败，未发送消息：${reason}` };
}

export function register(on: Register): void {
  on("prompt.edit", async ($, e, next) => {
    const box = await next(e);
    const rules = await loadRules($, false);
    if (!rules) return box;
    let decorations;
    try { decorations = hashDecorations(rules, box.text); } catch { return box; } // 超限调用由发送入口提示。
    if (!decorations.length) return box;
    return { ...box, decorations: [...(box.decorations ?? []), ...decorations] };
  });

  on("prompt.submit", async ($, e, next) => {
    if (e.command || e.isMeta || !TYPED_ORIGINS.has(e.origin.kind)) return next(e);
    const rules = await loadRules($, true);
    if (!rules) return next(e);
    let text;
    try {
      text = applyHashEdits(e.text, rules.edits(e.text).edits);
    } catch (error) {
      return refuse($, e, (error as Error).message);
    }
    return next(text === e.text ? e : { ...e, text });
  }).catch(($, e, next) => (next.called ? next(e) : refuse($, e, "处理超时或出错")));
}
