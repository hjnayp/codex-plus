// Codex 输入框（ProseMirror）适配器：把文档投影成核心能处理的纯文本，再把核心的结果映射回文档位置与事务。
// 与 hosts/claude-code/hooks.ts 是同一核心的两个宿主适配器。

import { compileHashRules } from "../../../core/hash-rules.ts";
import type { CompiledHashRules } from "../../../core/hash-rules.ts";
import { parsePromptDirectives } from "../../../core/prompt-directives.ts";
import { ancestorProps } from "./runtime/react.ts";

declare global {
  interface Window {
    /// 守护进程推送的缩写规则原始条目；reload 时整体替换。
    __CODEX_PLUS_HASH_RULES__?: unknown;
  }
}

// ProseMirror 的结构类型只声明适配器用到的部分，实际对象来自 Codex 内置的编辑器。
export type PmNode = any;
export type ComposerController = {
  view: {
    dom: Element;
    state: { doc: PmNode; tr: any; schema: any };
    isDestroyed?: boolean;
    dispatch(transaction: unknown): void;
    domAtPos(position: number): { node: Node; offset: number };
  };
  getEnterBehavior(): string;
};

export interface DocRange {
  from: number;
  to: number;
}

export interface ComposerDirectives {
  model: string | null;
  effort: string | null;
  length: number;
  ranges: DocRange[];
  /// 指令独占首段且后面还有内容时，整段删除。
  block: boolean;
}

export interface ComposerEdit extends DocRange {
  text: string;
  marks: unknown;
}

const OBJECT_REPLACEMENT = "\uFFFC";

function isCodeMark(mark: any): boolean {
  return Boolean(mark.type.spec?.code) || mark.type.name === "code";
}

export function controllerFor(input: Element | null | undefined): ComposerController | null {
  return ancestorProps(input, (props) => props?.composerController?.view?.dom === input)?.composerController ?? null;
}

export function conversationFor(input: Element | null | undefined): string {
  return ancestorProps(input, (props) => typeof props?.conversationId === "string")?.conversationId || "";
}

/// 只把首段开头的独立 token 当作指令，不处理代码块、标题或正文中的 hashtag。
export function directivesFor(controller: ComposerController | null): ComposerDirectives | null {
  const doc = controller?.view?.state?.doc;
  const first = doc?.firstChild;
  if (first?.type?.name !== "paragraph" || !first.firstChild?.isText) return null;
  let firstText = first.textContent;
  if (first.forEach) {
    firstText = "";
    let stopped = false;
    first.forEach((child: PmNode) => {
      if (stopped) return;
      if (!child.isText || child.marks.some(isCodeMark)) {
        stopped = true;
        firstText += OBJECT_REPLACEMENT; // 不能把 mention/代码边界误当作段落结尾。
      } else firstText += child.text;
    });
  }
  const parsed = parsePromptDirectives(firstText);
  if (!parsed) return null;
  // 段落内容从文档位置 1 开始。
  return {
    model: parsed.model,
    effort: parsed.effort,
    length: parsed.length,
    ranges: parsed.tokens.map(({ start, end }) => ({ from: 1 + start, to: 1 + end })),
    block: parsed.length === first.textContent.length && first.nodeSize === parsed.length + 2 && doc.childCount > 1,
  };
}

let compiledEntries: unknown;
let compiledRules: CompiledHashRules | null = null;

// 规则条目整体替换时才重新编译。
function currentHashRules(): CompiledHashRules | null {
  const entries = window.__CODEX_PLUS_HASH_RULES__;
  if (entries === undefined) return null;
  if (entries !== compiledEntries) {
    compiledRules = compileHashRules(entries);
    compiledEntries = entries;
  }
  return compiledRules;
}

/// 逐个文本块把文本与换行拼成连续片段交给核心；代码块、行内代码和 mention 等非文本节点作为边界。
export function hashEditsFor(controller: ComposerController, directives: ComposerDirectives | null): ComposerEdit[] {
  const rules = currentHashRules();
  if (!rules) return [];
  const edits: ComposerEdit[] = [];
  let fence: string | null = null;
  controller.view.state.doc.descendants((node: PmNode, pos: number) => {
    if (node.type?.spec?.code || node.type?.name === "code_block") return false;
    if (!node.isTextblock) return;
    let run = "";
    let pieces: { start: number; end: number; pos: number; marks: unknown; code: boolean }[] = [];
    const flush = () => {
      const result = rules.edits(run, fence);
      fence = result.fence;
      for (const { start, end, text } of result.edits) {
        const overlaps = pieces.filter((piece) => piece.end > start && piece.start < end);
        if (overlaps.some((piece) => piece.code)) continue;
        const from = overlaps[0].pos + start - overlaps[0].start;
        // 原生模型/强度指令优先，不让同名自定义规则破坏其删除范围。
        if (directives && from < 1 + directives.length) continue;
        edits.push({ from, to: from + end - start, text, marks: overlaps[0].marks });
      }
      run = "";
      pieces = [];
    };
    node.forEach((child: PmNode, offset: number) => {
      const lineBreak = child.type.name === "hard_break" || child.type.name === "hardBreak" || child.type.spec.linebreakReplacement;
      if (!child.isText && !lineBreak) { flush(); return; }
      const start = run.length;
      run += lineBreak ? "\n" : child.text;
      pieces.push({ start, end: run.length, pos: pos + 1 + offset, marks: child.marks, code: child.marks.some(isCodeMark) });
    });
    flush();
    return false;
  });
  const total = edits.reduce((size, edit) => size + edit.text.length, 0);
  if (total > 1024 * 1024) throw new Error("缩写展开超过 1 MiB");
  return edits;
}

/// 用一个编辑器事务替换缩写并删除指令；正文的 marks、mention 与附件沿用原生状态。
export function applyComposerEdits(controller: ComposerController, edits: ComposerEdit[], directives: ComposerDirectives | null): void {
  const { state } = controller.view;
  let transaction = state.tr;
  // 从后往前替换，原始文档位置不受前面展开长度影响。
  for (const edit of edits.slice().reverse()) {
    transaction = edit.text
      ? transaction.replaceWith(edit.from, edit.to, state.schema.text(edit.text, edit.marks))
      : transaction.delete(edit.from, edit.to);
  }
  if (directives) {
    transaction = directives.block
      ? transaction.delete(0, state.doc.firstChild.nodeSize)
      : transaction.delete(1, 1 + directives.length);
  }
  controller.view.dispatch(transaction);
}
