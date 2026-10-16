// 提示开头的模型与思考强度指令（#sol、#h、#sol-h），与宿主输入模型无关。

export const DIRECTIVE_MODELS = { astra: "gpt-6-astra", sol: "gpt-6.1-sol", luna: "gpt-6-luna" } as const;
export const DIRECTIVE_EFFORTS = { l: "low", m: "medium", h: "high", x: "xhigh" } as const;

export interface PromptDirectives {
  /// 未指定时为 null，表示沿用宿主当前设置。
  model: string | null;
  effort: string | null;
  /// 指令及其后分隔空白占用的长度，删除指令时从开头删去这么多字符。
  length: number;
  /// 每个指令 token（不含分隔空白）在文本中的区间，供高亮使用。
  tokens: { start: number; end: number }[];
}

const DIRECTIVE = /^#(?:(astra|sol|luna)(?:-([lmhx]))?|([lmhx]))(?:[ \t]+|$)/;

/// 解析文本开头连续的独立指令；同一项重复指定时以后面的为准，没有指令时返回 null。
export function parsePromptDirectives(text: string): PromptDirectives | null {
  let model: string | null = null;
  let effort: string | null = null;
  let length = 0;
  const tokens: PromptDirectives["tokens"] = [];
  let match: RegExpExecArray | null;
  while ((match = DIRECTIVE.exec(text.slice(length)))) {
    if (match[1]) model = DIRECTIVE_MODELS[match[1] as keyof typeof DIRECTIVE_MODELS];
    const effortKey = match[2] || match[3];
    if (effortKey) effort = DIRECTIVE_EFFORTS[effortKey as keyof typeof DIRECTIVE_EFFORTS];
    tokens.push({ start: length, end: length + match[0].trimEnd().length });
    length += match[0].length;
  }
  return length ? { model, effort, length, tokens } : null;
}
