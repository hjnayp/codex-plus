// 输入框内给发送时会生效的缩写与首段指令着色；只用 CSS Highlight，不改草稿或撤销历史。

import { controllerFor, directivesFor, hashEditsFor } from "../composer.ts";
import type { DocRange } from "../composer.ts";
import { appendStyle } from "../runtime/dom.ts";
import { installFeature } from "../runtime/feature.ts";

const HIGHLIGHT = "codex-plus-hash";
const COMPOSER = "[data-codex-composer]";

declare global {
  interface Window { __CODEX_PLUS_HASH_HIGHLIGHTS_REFRESH__?: () => void }
}

if (window.CSS?.highlights && typeof Highlight === "function") {
  installFeature({
    cleanupKey: "__CODEX_PLUS_HASH_HIGHLIGHTS_CLEANUP__",
    waitForDom: true,
    install() {
      const style = appendStyle("codex-plus-hash-highlights-style",
        `::highlight(${HIGHLIGHT}) { background-color: rgba(230, 170, 45, .28); text-decoration: underline; }`);
      let frame: number | null = null;
      let disposed = false;

      function refresh(): void {
        frame = null;
        if (disposed) return;
        const ranges: Range[] = [];
        for (const input of document.querySelectorAll(COMPOSER)) {
          const controller = controllerFor(input);
          if (!controller?.view?.domAtPos || !input.isConnected) continue;
          try {
            const directives = directivesFor(controller);
            const marked: DocRange[] = [...hashEditsFor(controller, directives), ...(directives?.ranges || [])];
            for (const { from, to } of marked) {
              const start = controller.view.domAtPos(from);
              const end = controller.view.domAtPos(to);
              const range = document.createRange();
              range.setStart(start.node, start.offset);
              range.setEnd(end.node, end.offset);
              ranges.push(range);
            }
          } catch { /* 无效配置由 reload/发送入口提示；高亮不影响编辑。 */ }
        }
        CSS.highlights.set(HIGHLIGHT, new Highlight(...ranges));
      }

      function schedule(): void {
        if (!disposed && frame === null) frame = window.requestAnimationFrame(refresh);
      }

      const observer = new MutationObserver((records) => {
        if (records.some((record) => {
          const target = record.target.nodeType === Node.ELEMENT_NODE ? record.target as Element : record.target.parentElement;
          if (target?.closest(COMPOSER)) return true;
          return [...record.addedNodes, ...record.removedNodes].some((node) =>
            node instanceof Element && (node.matches(COMPOSER) || node.querySelector(COMPOSER)));
        })) schedule();
      });
      observer.observe(document.body, { childList: true, characterData: true, subtree: true });
      window.addEventListener("input", schedule, true);
      schedule();
      window.__CODEX_PLUS_HASH_HIGHLIGHTS_REFRESH__ = schedule;
      return () => {
        disposed = true;
        if (frame !== null) window.cancelAnimationFrame(frame);
        observer.disconnect();
        window.removeEventListener("input", schedule, true);
        CSS.highlights.delete(HIGHLIGHT);
        style.remove();
        delete window.__CODEX_PLUS_HASH_HIGHLIGHTS_REFRESH__;
      };
    },
  });
}
