import { appendStyle } from "../runtime/dom.ts";
import { installFeature } from "../runtime/feature.ts";
import { fiberFor, propsFor } from "../runtime/react.ts";

const VERSION = "1.1.0";
const CLASS = "codex-plus-pending-input";
const STYLE_ID = "codex-plus-pending-input-style";

interface Question {
  id: string;
  kind: "async" | "native";
  title: string;
  hostId?: unknown;
  entityKey?: unknown;
  threadId: string;
  itemId: any;
  turnId: string | null;
  node: Element;
}

interface Turn {
  props: any;
  node: Element;
}

interface NativeApi {
  open: (scope: any, key: unknown) => void;
  questionState: unknown;
  questionIds: unknown;
}

type PendingInputWindow = Window & { __CODEX_PLUS_PENDING_INPUT_STATUS__?: () => unknown };

installFeature({
  cleanupKey: "__CODEX_PLUS_PENDING_INPUT_CLEANUP__",
  waitForDom: true,
  install() {
    const page = window as PendingInputWindow;
    let disposed = false;
    let timer: number | undefined;
    let row: HTMLElement | null = null;
    let current: Question[] = [];
    let expanded = false;
    let signature = "";
    let nativePromise: Promise<NativeApi> | null = null;
    let nativeApi: NativeApi | null = null;
    let nativeUnavailable = false;
    let openSequence = 0;
    let openError = "";
    let renderedThread: string | null | undefined = null;

    function composer(): Element | undefined {
      return [...document.querySelectorAll("[data-codex-composer-root]")]
        .find((node) => node.getClientRects().length > 0 && node.querySelector("[data-codex-composer]"));
    }

    // Host props are refreshed by React on every commit. Reading them avoids RPC,
    // transcript copies, and depending on minified component/export names.
    function turnProps(node: Element): any {
      const stack: any[] = [propsFor(node)?.children];
      let visited = 0;
      while (stack.length && visited++ < 40) {
        const element = stack.pop();
        if (!element || typeof element !== "object") continue;
        if (Array.isArray(element)) { stack.push(...element); continue; }
        const props = element.props;
        if (props?.turn && Array.isArray(props.turn.items) && props.conversationId) return props;
        if (props?.children) stack.push(props.children);
      }
      return null;
    }

    function userText(item: any): string {
      return (item.content || item.input || []).filter((part: any) => part.type === "text")
        .map((part: any) => part.text || "").join("\n");
    }

    function replies(text: string): any[] {
      const answers: any[] = [];
      for (const match of text.matchAll(/<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>/g)) {
        try {
          const value = JSON.parse(match[1]);
          if (Array.isArray(value)) answers.push(...value.filter((reply) => typeof reply.questionItemId === "string"));
        } catch { /* An incomplete reply is not an answer. */ }
      }
      return answers;
    }

    function pending(turns: Turn[]): Question[] {
      const questions = new Map<string, Question>();
      const requests = new Map<string, Question>();
      for (const { props, node } of turns) {
        const turn = props.turn;
        const turnId = turn.turnId || node.getAttribute("data-content-search-turn-key");
        for (const item of turn.items) {
          if (item.type === "userMessage" || item.type === "steeringUserMessage") {
            if (item.type === "steeringUserMessage" && item.status !== "accepted") continue;
            const text = userText(item);
            for (const answer of replies(text)) questions.delete(answer.questionItemId);
          } else if (item.type === "agentMessage") {
            (turn.status === "inProgress" ? item.questions || [] : []).forEach((question: any, index: number) => {
              if (typeof question.title !== "string" || !question.title.trim()) return;
              const id = JSON.stringify(["request_user_input_async", item.id, index]);
              questions.set(id, { id, kind: "async", title: question.title,
                hostId: props.hostId, entityKey: props.historyEntityKey,
                threadId: props.conversationId, itemId: id, turnId, node });
            });
          }
        }
        for (const request of props.turnRequests || []) {
          if (turn.status !== "inProgress" || request.method !== "item/tool/requestUserInput") continue;
          (request.params?.questions || []).forEach((question: any, index: number) => {
            const id = `request:${request.id}:${index}`;
            requests.set(id, { id, kind: "native", title: question.question || question.header || "有一个问题需要你回答。",
              threadId: props.conversationId, itemId: request.params?.itemId, turnId, node });
          });
        }
      }
      return [...[...questions.values()].reverse(), ...[...requests.values()].reverse()];
    }

    function locate(question: Question): void {
      const unitKey = `${question.turnId}:${question.itemId}`;
      const targets = [...document.querySelectorAll("[data-content-search-unit-key]")];
      const target = targets
        .find((node) => node.getAttribute("data-content-search-unit-key") === unitKey)
        || question.node;
      target?.scrollIntoView({ behavior: "instant", block: "center" });
    }

    function activeThread(): string | null | undefined {
      return composer()?.querySelector("[data-above-composer-conversation-id]")
        ?.getAttribute("data-above-composer-conversation-id");
    }

    function activeScope(): any {
      const root = composer();
      for (let node: Element | null | undefined = root; node; node = node.parentElement) {
        for (let fiber = fiberFor(node), depth = 0; fiber && depth < 80; fiber = fiber.return, depth++) {
          for (let hook = fiber.memoizedState, count = 0; hook && count < 100; hook = hook.next, count++) {
            const scope = hook.memoizedState?.current;
            if (scope && typeof scope.get === "function" && typeof scope.set === "function"
              && scope.node && scope.chain && scope.value?.conversationId === activeThread()) return scope;
          }
        }
      }
      throw new Error("找不到当前对话的原生提问面板");
    }

    async function nativeOpener(): Promise<NativeApi> {
      const urls = [...new Set([...document.querySelectorAll<HTMLLinkElement>("link[rel='modulepreload']")]
        .map((node) => node.href).filter((url) => /\/app-(?:initial|shared)[^/]*\.js(?:$|\?)/.test(url)))];
      for (const url of urls) {
        const module = await import(url);
        for (const value of Object.values(module)) {
          if (typeof value !== "function") continue;
          let source: string;
          try { source = Function.prototype.toString.call(value); } catch { continue; }
          // Identify the native opening action by its state transition, not the
          // bundled export name. It cancels the deadline and selects one question.
          if (/selectedQuestionKey:\w+,questionIds:\[\w+\.itemId\]/.test(source)
            && source.includes("deadlineMs:null") && source.includes(".get(")) {
            // Also read the same native question state before opening. Native skip
            // or submission can resolve it without a new transcript DOM node.
            const atom = /\.get\((\w+),/.exec(source)?.[1];
            const bundle = await (await fetch(url)).text();
            const exports = bundle.slice(bundle.lastIndexOf("export{"));
            const entry = exports.slice(7, exports.indexOf("}")).split(",")
              .map((entry) => entry.trim().split(/\s+as\s+/)).find(([name]) => name === atom);
            const questionState = entry && module[entry[1] || entry[0]];
            if (!questionState) continue;
            const idsSymbol = new RegExp(`\\w+\\((\\w+),\\w+\\)\\.some\\(\\w+=>\\w+\\(${atom},`).exec(bundle)?.[1];
            const idsEntry = exports.slice(7, exports.indexOf("}")).split(",")
              .map((entry) => entry.trim().split(/\s+as\s+/)).find(([name]) => name === idsSymbol);
            const questionIds = idsEntry && module[idsEntry[1] || idsEntry[0]];
            if (!questionIds) continue;
            return { open: value as NativeApi["open"], questionState, questionIds };
          }
        }
      }
      throw new Error("当前 Codex 版本没有可用的原生提问入口");
    }

    async function openQuestion(question: Question): Promise<void> {
      const sequence = ++openSequence;
      openError = "";
      if (question.kind !== "async") {
        render();
        const fresh = current.find((item) => item.id === question.id);
        if (!disposed && activeThread() === question.threadId && fresh) locate(fresh);
        return;
      }
      try {
        const native = await loadNative();
        if (disposed || sequence !== openSequence || activeThread() !== question.threadId) return;
        nativeApi = native;
        // Loading a module can finish after a chat switch, resolution, or cleanup.
        render();
        const fresh = current.find((item) => item.id === question.id);
        if (disposed || sequence !== openSequence || activeThread() !== question.threadId || !fresh) return;
        const scope = activeScope();
        const key = { hostId: fresh.hostId, threadId: fresh.threadId,
          entityKey: fresh.entityKey, itemId: fresh.itemId };
        const state = scope.get(native.questionState, key);
        if (!state || state.isSkipped || state.lastSubmission != null || state.isSubmitting) {
          throw new Error("这个问题已不再等待回答");
        }
        native.open(scope, key);
      } catch (error: any) {
        if (disposed || sequence !== openSequence || activeThread() !== question.threadId) return;
        openError = String(error?.message || error); signature = ""; render();
      }
    }

    function loadNative(): Promise<NativeApi> {
      nativePromise ||= nativeOpener().then((native) => {
        if (!disposed) { nativeApi = native; schedule(); }
        return native;
      }).catch((error) => { nativeUnavailable = true; throw error; });
      return nativePromise;
    }

    function createRow(): HTMLElement {
      const element = document.createElement("section");
      element.className = CLASS;
      element.setAttribute("aria-label", "待你回答的问题");
      const button = document.createElement("button");
      button.type = "button";
      button.className = `${CLASS}-summary`;
      button.innerHTML = '<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M5 15.5 2.5 18v-5A7.5 7.5 0 1 1 5 15.5Z"/><path d="M8 7a2 2 0 0 1 4 0c0 1.5-2 1.5-2 3"/><circle cx="10" cy="13" r=".65" fill="currentColor" stroke="none"/></svg><strong></strong><span></span><small>查看问题 ↗</small>';
      button.addEventListener("click", () => {
        expanded = !expanded; signature = ""; render();
      });
      element.append(button);
      return element;
    }

    function render(): void {
      timer = undefined;
      if (disposed || document.hidden) return;
      const root = composer();
      const threadId = root?.querySelector("[data-above-composer-conversation-id]")?.getAttribute("data-above-composer-conversation-id");
      if (threadId !== renderedThread) {
        openSequence++; openError = ""; expanded = false; renderedThread = threadId;
      }
      const turns: Turn[] = [];
      if (threadId) {
        for (const node of document.querySelectorAll("[data-content-search-turn-key]")) {
          const props = turnProps(node);
          if (props?.conversationId === threadId) turns.push({ props, node });
        }
      }
      current = pending(turns);
      if (!nativeApi && current.some((question) => question.kind === "async")) {
        if (!nativeUnavailable) loadNative().catch(() => {});
        // Native availability, including feature gates, determines whether an
        // asynchronous question can actually be answered in this surface.
        current = current.filter((question) => question.kind !== "async");
      }
      if (nativeApi && current.some((question) => question.kind === "async")) {
        const api = nativeApi;
        try {
          const scope = activeScope();
          current = current.filter((question) => {
            if (question.kind !== "async") return true;
            // A continuing turn can be displayed under a different history entity
            // after steering. Let the native entity observer initialize its state.
            scope.get(api.questionIds, { hostId: question.hostId,
              threadId: question.threadId, entityKey: question.entityKey });
            const state = scope.get(api.questionState, { hostId: question.hostId,
              threadId: question.threadId, entityKey: question.entityKey, itemId: question.itemId });
            return state && !state.isSkipped && state.lastSubmission == null && !state.isSubmitting;
          });
        } catch {
          // The route's native scope can be absent briefly during mounting.
          current = current.filter((question) => question.kind !== "async");
        }
      }
      if (!root || !current.length) {
        row?.remove(); row = null; signature = ""; expanded = false; return;
      }
      const nextSignature = JSON.stringify([threadId, expanded, openError, current.map(({ id, title }) => [id, title])]);
      if (!row?.isConnected || row.parentElement !== root) {
        row?.remove(); row = createRow(); expanded = false; signature = "";
      }
      // Own a sibling of the native rail; React retains exclusive ownership of its children.
      const rail = root.querySelector(":scope > [data-composer-rail-placement='above']");
      const surface = [...root.children].find((node) => node.querySelector("[data-codex-composer]"));
      if (rail) { if (row.nextElementSibling !== rail) rail.before(row); }
      else if (surface && row.nextElementSibling !== surface) surface.before(row);
      if (signature === nextSignature) return;
      signature = nextSignature;
      const button = row.firstElementChild as HTMLButtonElement;
      button.querySelector("strong")!.textContent = current.length > 1 ? `待你回答 · ${current.length} 个问题` : "待你回答";
      button.querySelector("span")!.textContent = current[0].title.replace(/\s+/g, " ");
      button.title = current[0].title;
      button.setAttribute("aria-expanded", `${expanded}`);
      row.querySelector(`.${CLASS}-list`)?.remove();
      row.querySelector(`.${CLASS}-error`)?.remove();
      if (openError) {
        const error = document.createElement("p"); error.className = `${CLASS}-error`;
        error.setAttribute("role", "alert"); error.textContent = openError; row.append(error);
      }
      if (expanded) {
        const list = document.createElement("div");
        list.className = `${CLASS}-list`;
        current.forEach((question, index) => {
          const link = document.createElement("button");
          link.type = "button"; link.textContent = `${index + 1}. ${question.title}`;
          link.addEventListener("click", () => openQuestion(question)); list.append(link);
        });
        row.append(list);
      }
    }

    function schedule(): void {
      if (!disposed && timer == null && !document.hidden) timer = window.setTimeout(render, 250);
    }

    const observer = new MutationObserver((records) => {
      if (records.some((record) => !row?.contains(record.target)
        && [...record.addedNodes, ...record.removedNodes].some((node) => node !== row))) schedule();
    });
    const style = appendStyle(STYLE_ID, `.${CLASS}{color:var(--color-text-primary,inherit);background:var(--color-surface-elevated-secondary,rgba(127,127,127,.06));border:1px solid var(--color-border,rgba(127,127,127,.2));border-radius:16px;margin:0 0 6px;overflow:hidden;font-size:13px}
    .${CLASS} button{font:inherit;color:inherit;cursor:pointer;background:none;border:0;text-align:start}
    .${CLASS} button:hover{background:rgba(127,127,127,.08)}.${CLASS} button:focus-visible{outline:2px solid var(--color-ring,#6487d8);outline-offset:-3px}
    .${CLASS}-summary{display:flex;align-items:center;gap:8px;width:100%;min-height:36px;padding:6px 12px}
    .${CLASS}-summary svg{flex-shrink:0;opacity:.65}.${CLASS}-summary strong{font-weight:550;white-space:nowrap}
    .${CLASS}-summary span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.7}
    .${CLASS}-summary small{flex-shrink:0;opacity:.65;font-size:11px}.${CLASS}-list{max-height:200px;overflow:auto;border-top:1px solid rgba(127,127,127,.15)}
    .${CLASS}-list button{display:block;width:100%;padding:9px 12px;white-space:pre-wrap;overflow-wrap:anywhere}
    .${CLASS}-error{margin:8px 12px;color:var(--color-text-danger,#c66);font-size:12px}`);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    // Pending native requests can change React props without adding transcript nodes.
    const interval = window.setInterval(schedule, 1500);
    document.addEventListener("visibilitychange", schedule);
    page.__CODEX_PLUS_PENDING_INPUT_STATUS__ = () => ({ version: VERSION, mounted: !!row?.isConnected, count: current.length });
    render();

    return () => {
      disposed = true;
      clearTimeout(timer); clearInterval(interval); observer.disconnect();
      document.removeEventListener("visibilitychange", schedule);
      openSequence++; nativePromise = null; nativeApi = null; row?.remove(); style.remove(); current = [];
      delete page.__CODEX_PLUS_PENDING_INPUT_STATUS__;
    };
  },
});
