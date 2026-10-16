// 发送前处理：先按首段指令切换原生模型与思考强度，再展开 # 缩写并删除指令，最后交回原生提交。

import {
  applyComposerEdits, controllerFor, conversationFor, directivesFor, hashEditsFor,
} from "../composer.ts";
import type { ComposerController, ComposerDirectives, ComposerEdit } from "../composer.ts";
import { visible } from "../runtime/dom.ts";
import { installFeature } from "../runtime/feature.ts";
import { ancestorProps } from "../runtime/react.ts";

const ERROR_ATTRIBUTE = "data-codex-plus-reasoning-error";
const SEND_LABEL = /^(?:发送(?:消息)?|提交|加入队列|排队(?:发送)?|Send(?: message)?|Submit|Queue(?: message)?)$/i;

interface Operation {
  controller: ComposerController;
  doc: unknown;
  scope: string;
  canceled: boolean;
}

installFeature({
  cleanupKey: "__CODEX_PLUS_REASONING_PREFIX_CLEANUP__",
  version: { key: "__codexPlusReasoningPrefixVersion", value: "1.1.0" },
  install() {
    const pending = new Map<Element, Operation>();
    let disposed = false;
    let replaying: Element | null = null;

    function triggerFor(root: Element): Element | undefined {
      return Array.from(root.querySelectorAll("[data-codex-intelligence-trigger]")).find(visible);
    }

    function selectionFor(root: Element): any {
      return ancestorProps(triggerFor(root), (props) => (
        typeof props?.onSelectModel === "function" && Array.isArray(props.models)
        && typeof props.model === "string" && "reasoningEffort" in props
      ));
    }

    function warn(root: Element, message: string): void {
      let node = root.querySelector(`[${ERROR_ATTRIBUTE}]`);
      if (!node) {
        node = document.createElement("div");
        node.setAttribute(ERROR_ATTRIBUTE, "");
        node.setAttribute("role", "alert");
        root.append(node);
      }
      node.textContent = `Codex+：${message}；未发送消息。`;
    }

    // 同时监视取消和期限，不能让一个未结束的原生 Promise 永久锁住输入框。
    async function selectModel(root: Element, directives: ComposerDirectives, current: () => boolean): Promise<void> {
      const selection = selectionFor(root);
      const targetModel = directives.model || selection?.model;
      const targetEffort = directives.effort || selection?.reasoningEffort;
      const model = selection?.models.find((option: any) => option.model === targetModel);
      if (!selection || selection.disabled || selection.reasoningEffortDisabled
        || !model?.supportedReasoningEfforts?.some((option: any) => option.reasoningEffort === targetEffort)) {
        throw new Error(`${targetModel || "当前模型"} 无法切换到 ${targetEffort}`);
      }
      const deadline = Date.now() + 5000;
      const needsSelection = selection.model !== targetModel || selection.reasoningEffort !== targetEffort;
      let settled = !needsSelection;
      let failure: unknown = null;
      if (needsSelection) {
        Promise.resolve().then(() => {
          if (current()) return selection.onSelectModel(targetModel, targetEffort);
        }).then(() => { settled = true; }, (error) => { failure = error; settled = true; });
      }
      while (current() && (!settled
        || selectionFor(root)?.model !== targetModel
        || triggerFor(root)?.getAttribute("data-selected-reasoning-effort") !== targetEffort)) {
        if (failure) throw failure;
        if (Date.now() >= deadline) throw new Error("等待原生模型或思考强度切换超时");
        await new Promise((resolve) => window.setTimeout(resolve, 20));
      }
      if (failure) throw failure;
    }

    async function submit(root: Element, input: Element, controller: ComposerController,
      directives: ComposerDirectives | null, edits: ComposerEdit[], resume: () => void): Promise<void> {
      const operation: Operation = { controller, doc: controller.view.state.doc, scope: conversationFor(input), canceled: false };
      pending.set(root, operation);
      root.querySelector(`[${ERROR_ATTRIBUTE}]`)?.remove();
      const current = () => !disposed && !operation.canceled && visible(root)
        && controllerFor(input) === controller && !controller.view.isDestroyed
        && conversationFor(input) === operation.scope
        && controller.view.state.doc === operation.doc;
      try {
        if (directives) await selectModel(root, directives, current);
        if (!current()) return;
        applyComposerEdits(controller, edits, directives);
        operation.doc = controller.view.state.doc;
        // 给 React 提交新的草稿与档位，随后重新走原生提交入口。
        await new Promise((resolve) => window.setTimeout(resolve, 0));
        if (!current()) return;
        replaying = root;
        try { resume(); } finally { replaying = null; }
      } catch (error) {
        if (current()) warn(root, (error as Error)?.message || "发送前处理失败");
      } finally {
        if (pending.get(root) === operation) pending.delete(root);
      }
    }

    function isSendButton(button: Element | null | undefined): button is HTMLButtonElement {
      return Boolean(button) && SEND_LABEL.test(button!.getAttribute("aria-label") || "");
    }

    function cancelPending(): void {
      for (const operation of pending.values()) operation.canceled = true;
      pending.clear();
    }

    function intercept(event: Event): void {
      if (disposed) return;
      const target = event.target as Element | null;
      const root = target?.closest?.("[data-codex-composer-root]") ?? null;
      if (replaying && replaying === root) return;
      // 用户离开输入框、编辑或重新选择设置后，旧提交永久取消，即使随后回到原聊天。
      if (event.type === "click" && (!root || !isSendButton(target?.closest?.("button")))) cancelPending();
      if (!visible(root)) return;
      const input = root.querySelector("[data-codex-composer]");
      const controller = controllerFor(input);
      if (!input || !controller) return;
      let resume: () => void;
      if (event instanceof KeyboardEvent && event.type === "keydown") {
        if (event.key !== "Enter" || event.isComposing || event.keyCode === 229
          || event.shiftKey || event.altKey || !input.contains(target)) return;
        const modifier = event.metaKey || event.ctrlKey;
        if (controller.getEnterBehavior() === "enter" ? modifier : !modifier) return;
        const { ctrlKey, metaKey } = event;
        resume = () => input.dispatchEvent(new KeyboardEvent("keydown", {
          key: "Enter", code: "Enter", keyCode: 13, which: 13, ctrlKey, metaKey,
          bubbles: true, cancelable: true, composed: true,
        }));
      } else {
        const button = target?.closest?.("button");
        if (!isSendButton(button) || button.disabled || button.getAttribute("aria-disabled") === "true") return;
        resume = () => {
          // 原生按钮可能随草稿更新被替换，不能点击过期节点。
          const label = button.getAttribute("aria-label");
          Array.from(root.querySelectorAll("button"))
            .find((candidate) => visible(candidate) && candidate.getAttribute("aria-label") === label)?.click();
        };
      }
      const directives = directivesFor(controller);
      let edits: ComposerEdit[];
      try {
        edits = hashEditsFor(controller, directives);
      } catch (error) {
        event.preventDefault();
        event.stopImmediatePropagation();
        warn(root, (error as Error).message);
        return;
      }
      if (!directives && !edits.length && !pending.has(root)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (pending.has(root) || (event as KeyboardEvent).repeat) return;
      void submit(root, input, controller, directives, edits, resume);
    }

    function cancelOnEdit(event: Event): void {
      if ((event.target as Element | null)?.closest?.("[data-codex-composer]")) cancelPending();
    }

    window.addEventListener("keydown", intercept, true);
    window.addEventListener("click", intercept, true);
    window.addEventListener("input", cancelOnEdit, true);
    return () => {
      disposed = true;
      cancelPending();
      window.removeEventListener("keydown", intercept, true);
      window.removeEventListener("click", intercept, true);
      window.removeEventListener("input", cancelOnEdit, true);
      document.querySelectorAll(`[${ERROR_ATTRIBUTE}]`).forEach((node) => node.remove());
    };
  },
});
