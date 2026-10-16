// `#` 缩写的宿主无关核心：解析规则、递归展开并给出编辑区间。
// 各宿主适配器只负责把编辑区间落到自己的输入模型上（Codex 的 ProseMirror 事务、Claude Code 的提示文本）。

export interface HashRuleEntry {
  trigger: string;
  text: string;
}

export interface HashEdit {
  start: number;
  end: number;
  text: string;
}

export interface HashEditResult {
  edits: HashEdit[];
  /// 本段末尾仍未闭合的 Markdown 围栏，传给下一段以延续代码区判定。
  fence: string | null;
}

export interface HashMatch {
  0: string;
  index: number;
  rule: CompiledRule;
  values: Map<string, string>;
}

export interface CompiledHashRules {
  replace(text: string): string;
  matches(text: string): HashMatch[];
  edits(text: string, fence?: string | null): HashEditResult;
}

interface Argument {
  name: string | null;
  value: string;
}

interface Call {
  name: string;
  end: number;
  args: Argument[] | null;
}

interface CompiledRule {
  name: string;
  params: { name: string; value: string }[];
  text: string;
}

interface ExpansionState {
  visiting: Set<string>;
  memo: Map<string, string>;
  memoSize: number;
  steps: number;
  remaining: number;
}

const EXPANSION_LIMIT = 1024 * 1024;

/// 把展开的编辑区间按序应用到纯文本；用于以字符串承载提示的宿主。
export function applyHashEdits(text: string, edits: readonly HashEdit[]): string {
  let output = "";
  let end = 0;
  for (const edit of edits) {
    output += text.slice(end, edit.start) + edit.text;
    end = edit.end;
  }
  output += text.slice(end);
  if (output.length - text.length > EXPANSION_LIMIT) throw new Error("缩写展开超过 1 MiB");
  return output;
}

export function compileHashRules(entries: unknown): CompiledHashRules {
  const token = /(?<![A-Za-z0-9_#-])#[A-Za-z0-9_-]+/g;
  const parameter = /^[A-Za-z_][A-Za-z0-9_]*$/;
  const limit = EXPANSION_LIMIT;
  const rules = new Map<string, CompiledRule>();
  const defaults = new Map<string, string>();

  function quoteStarts(text: string, index: number): boolean {
    let before = index - 1;
    while (before >= 0 && /\s/.test(text[before])) before--;
    return before < 0 || /[=(,]/.test(text[before]);
  }

  // 返回括号外的分隔符位置。双引号使用 JSON 转义，单引号为字面值。
  function separators(text: string, separator: string): number[] | null {
    const positions: number[] = [];
    let quote: string | null = null;
    let depth = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (quote) {
        if (char === "\\" && quote === '"') i++;
        else if (char === quote) quote = null;
      } else if ((char === '"' || char === "'") && quoteStarts(text, i)) quote = char;
      else if (char === "(") depth++;
      else if (char === ")") { if (--depth < 0) return null; }
      else if (char === separator && depth === 0) positions.push(i);
    }
    return quote || depth ? null : positions;
  }

  function fields(text: string): Argument[] | null {
    if (!text.trim()) return [];
    const commas = separators(text, ",");
    if (!commas) return null;
    const result: Argument[] = [];
    let start = 0;
    for (const end of [...commas, text.length]) {
      const part = text.slice(start, end).trim();
      start = end + 1;
      const equal = separators(part, "=")?.[0];
      const name = equal === undefined ? null : part.slice(0, equal).trim();
      const raw = (equal === undefined ? part : part.slice(equal + 1)).trim();
      if (!raw || (name !== null && !parameter.test(name))) return null;
      let value: unknown = raw;
      if (raw[0] === '"') {
        try { value = JSON.parse(raw); } catch { return null; }
        if (typeof value !== "string") return null;
      } else if (raw[0] === "'") {
        if (raw.length < 2 || !raw.endsWith("'") || raw.slice(1, -1).includes("'")) return null;
        value = raw.slice(1, -1);
      } else if (/["'()]/.test(raw)) return null;
      result.push({ name, value: value as string });
    }
    return result;
  }

  function scanBudget(): (amount: number) => void {
    let remaining = 8 * limit;
    return (amount) => {
      remaining -= amount;
      if (remaining < 0) throw new Error("缩写参数解析工作量超出上限");
    };
  }

  function callAt(text: string, start: number, scan?: (amount: number) => void): Call | null {
    const base = /^#[A-Za-z0-9_-]+/.exec(text.slice(start));
    if (!base) return null;
    const open = start + base[0].length;
    if (text[open] !== "(") return { name: base[0], end: open, args: [] };
    let quote: string | null = null;
    let depth = 0;
    let scanned = 0;
    for (let i = open; i < text.length; i++) {
      if (scan && ++scanned === 1024) { scan(scanned); scanned = 0; }
      const char = text[i];
      if (quote) {
        if (char === "\\" && quote === '"') i++;
        else if (char === quote) quote = null;
      } else if ((char === '"' || char === "'") && quoteStarts(text, i)) quote = char;
      else if (char === "(") depth++;
      else if (char === ")" && --depth === 0) {
        scan?.(scanned);
        return { name: base[0], end: i + 1, args: fields(text.slice(open + 1, i)) };
      }
    }
    scan?.(scanned);
    // 未闭合调用只保留自己的片段，后续由空白分隔的缩写仍独立处理。
    const recovery = /\s+(#[A-Za-z0-9_-]+)/.exec(text.slice(open + 1));
    const end = recovery ? open + 1 + recovery.index + recovery[0].length - recovery[1].length : text.length;
    return { name: base[0], end, args: null };
  }

  if (!Array.isArray(entries)) throw new Error("缩写规则必须是数组");
  for (const entry of entries) {
    if (!entry || typeof entry.trigger !== "string" || typeof entry.text !== "string") throw new Error("无效的缩写规则");
    if (Object.keys(entry).some((key) => key !== "trigger" && key !== "text")) throw new Error(`缩写 ${entry.trigger} 只支持 trigger 和 text 字段`);
    const definition = callAt(entry.trigger, 0);
    if (!definition || definition.end !== entry.trigger.length || !definition.args) throw new Error(`无效的缩写规则：${entry.trigger}`);
    if (rules.has(definition.name)) throw new Error(`重复缩写：${definition.name}`);
    const names = new Set<string>();
    for (const arg of definition.args) {
      if (!arg.name || names.has(arg.name)) throw new Error(`默认参数必须具名且不能重复：${entry.trigger}`);
      names.add(arg.name);
    }
    rules.set(definition.name, {
      name: definition.name,
      params: definition.args as { name: string; value: string }[],
      text: entry.text,
    });
  }

  function bind(rule: CompiledRule, args: Argument[] | null): Map<string, string> | null {
    if (!args) return null;
    const values = new Map(rule.params.map((arg) => [arg.name, arg.value]));
    const assigned = new Set<string>();
    let index = 0;
    let named = false;
    for (const arg of args) {
      let name = arg.name;
      if (name === null) {
        if (named || index >= rule.params.length) return null;
        name = rule.params[index++].name;
      } else named = true;
      if (!values.has(name) || assigned.has(name)) return null;
      assigned.add(name);
      values.set(name, arg.value);
    }
    return values;
  }

  function urlRanges(text: string): RegExpExecArray[] {
    return Array.from(text.matchAll(/(?:https?|file|ftp):\/\/[^\s<>()，。；！？、（）【】《》「」『』]+/g)) as RegExpExecArray[];
  }

  function insideUrl(urls: RegExpExecArray[], index: number): boolean {
    return urls.some((url) => index >= url.index && index < url.index + url[0].length);
  }

  function matches(text: string): HashMatch[] {
    const urls = urlRanges(text);
    const scanner = new RegExp(token);
    const scan = scanBudget();
    const result: HashMatch[] = [];
    let match: RegExpExecArray | null;
    while ((match = scanner.exec(text))) {
      const call = callAt(text, match.index, scan) as Call;
      scanner.lastIndex = call.end; // 整体跳过未知、错误或未完成调用，禁止替换其中的子串。
      if (insideUrl(urls, match.index)) continue;
      const rule = rules.get(call.name);
      if (!rule) continue;
      const values = bind(rule, call.args);
      if (values) result.push({ 0: text.slice(match.index, call.end), index: match.index, rule, values });
    }
    return result;
  }

  // 返回 Markdown 围栏代码块与行内代码之外的展开；fence 为上一段未闭合的围栏，返回值延续给下一段。
  function edits(text: string, fence: string | null = null): HashEditResult {
    const code: [number, number][] = [];
    let lineStart = 0;
    for (const line of text.split("\n")) {
      const marker = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (fence) {
        code.push([lineStart, lineStart + line.length]);
        if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      } else if (marker) {
        fence = marker[1];
        code.push([lineStart, lineStart + line.length]);
      }
      lineStart += line.length + 1;
    }
    const backticks = (Array.from(text.matchAll(/`+/g)) as RegExpExecArray[]).filter((tick) =>
      !code.some(([from, to]) => tick.index >= from && tick.index < to));
    // 行内代码以等长反引号闭合；向后预先记录同长度的下一处，避免逐个回扫。
    const nextSame: (number | undefined)[] = [];
    const lastByLength = new Map<number, number>();
    for (let i = backticks.length - 1; i >= 0; i--) {
      nextSame[i] = lastByLength.get(backticks[i][0].length);
      lastByLength.set(backticks[i][0].length, i);
    }
    for (let i = 0; i < backticks.length; i++) {
      const close = nextSame[i];
      if (close === undefined) continue;
      code.push([backticks[i].index, backticks[close].index + backticks[close][0].length]);
      i = close;
    }
    const result: HashEdit[] = [];
    for (const match of matches(text)) {
      const start = match.index;
      const end = start + match[0].length;
      if (code.some(([from, to]) => start < to && end > from)) continue;
      const replacement = replaceInternal(match[0], context());
      if (replacement !== match[0]) result.push({ start, end, text: replacement });
    }
    return { edits: result, fence };
  }

  function append(output: string, text: string): string {
    if (output.length + text.length > limit) throw new Error("缩写展开超过 1 MiB");
    return output + text;
  }

  function render(rule: CompiledRule, values: Map<string, string>): string {
    function interpolate(text: string): string {
      let output = "";
      let end = 0;
      for (const match of text.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
        output = append(output, text.slice(end, match.index));
        output = append(output, values.get(match[1]) ?? match[0]);
        end = (match.index as number) + match[0].length;
      }
      return append(output, text.slice(end));
    }
    let output = "";
    let end = 0;
    const scanner = new RegExp(token);
    const scan = scanBudget();
    const urls = urlRanges(rule.text);
    let match: RegExpExecArray | null;
    while ((match = scanner.exec(rule.text))) {
      const call = callAt(rule.text, match.index, scan) as Call;
      scanner.lastIndex = call.end;
      const target = rules.get(call.name);
      if (!target || insideUrl(urls, match.index)) continue;
      if (!bind(target, call.args)) throw new Error(`规则 ${rule.name} 中的 ${call.name} 参数调用错误`);
      const args = call.args as Argument[];
      if (!args.length) continue;
      output = append(output, interpolate(rule.text.slice(end, match.index)));
      output = append(output, call.name + "(");
      for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (i) output = append(output, ",");
        // 内层参数作为字符串转发，值中的逗号、括号或引号不会变成调用语法。
        output = append(output, (arg.name === null ? "" : arg.name + "=") + JSON.stringify(interpolate(arg.value)));
      }
      output = append(output, ")");
      end = call.end;
    }
    return append(output, interpolate(rule.text.slice(end)));
  }

  function context(): ExpansionState {
    return { visiting: new Set(), memo: new Map(), memoSize: 0, steps: 10000, remaining: 8 * limit };
  }

  function charge(state: ExpansionState, amount: number): void {
    state.remaining -= amount;
    if (state.remaining < 0) throw new Error("缩写展开工作量超出上限");
  }

  function expand(rule: CompiledRule, values: Map<string, string>, state: ExpansionState): string {
    const ordered = rule.params.map((arg) => values.get(arg.name));
    const key = JSON.stringify([rule.name, ordered]);
    charge(state, key.length);
    if (--state.steps < 0) throw new Error("缩写展开次数超过 10000");
    if (state.visiting.has(key)) throw new Error(`缩写循环引用：${rule.name}`);
    if (state.visiting.size >= 64) throw new Error("缩写递归深度超过 64");
    const isDefault = rule.params.every((arg, i) => arg.value === ordered[i]);
    const cached = isDefault ? defaults.get(rule.name) : state.memo.get(key);
    if (cached !== undefined) return cached;
    state.visiting.add(key);
    try {
      const value = replaceInternal(render(rule, values), state);
      charge(state, value.length);
      // 跨次仅缓存固定默认调用；可变参数的临时缓存随本次展开释放。
      if (isDefault) defaults.set(rule.name, value);
      else if (state.memoSize + key.length + value.length <= limit) {
        state.memo.set(key, value);
        state.memoSize += key.length + value.length;
      }
      return value;
    } finally { state.visiting.delete(key); }
  }

  function replaceInternal(text: string, state: ExpansionState): string {
    charge(state, text.length);
    let output = "";
    let end = 0;
    for (const match of matches(text)) {
      output = append(output, text.slice(end, match.index));
      output = append(output, expand(match.rule, match.values, state));
      end = match.index + match[0].length;
    }
    return append(output, text.slice(end));
  }

  for (const rule of rules.values()) expand(rule, bind(rule, []) as Map<string, string>, context());
  return { replace: (text) => replaceInternal(text, context()), matches, edits };
}
