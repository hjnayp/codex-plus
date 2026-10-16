import { installFeature } from "../runtime/feature.ts";
import { propsFor } from "../runtime/react.ts";

interface ModelChoice {
  slug?: string;
  label?: string;
  direction?: number;
}

const VERSION = "1.1.0";
const MODEL_TIERS: ModelChoice[] = [
  { slug: "gpt-6-astra", label: "6 Astra" },
  { slug: "gpt-6.1-sol", label: "6.1 Sol" },
  { slug: "gpt-6-luna", label: "6 Luna" },
];
const MODEL_LABELS = new Set([
  ...MODEL_TIERS.map((model) => model.label),
  "5.6 Sol", "5.6 Terra", "5.6 Luna",
]);

declare global {
  interface Window {
    __CODEX_PLUS_MODEL_SHORTCUTS_DEBUG__?: {
      version: string;
      currentThreadId: () => string;
      selectModel: (model: ModelChoice) => Promise<void>;
      syncModelTriggerLabel: () => void;
    };
  }
}

installFeature({
  cleanupKey: "__CODEX_PLUS_MODEL_SHORTCUTS_CLEANUP__",
  version: { key: "__codexPlusModelShortcutsVersion", value: VERSION },
  install() {
    const selectedModelsByThread = new Map<string, ModelChoice>();
    const selectedModelsByComposer = new WeakMap<Element, ModelChoice>();
    let syncTimer = 0;
    let busy = false;
    let pendingModel: ModelChoice | null = null;
    let drainingModels = false;

    function normalizeText(value: unknown): string {
      return String(value || "").trim().replace(/\s+/g, " ");
    }

    function composerInput(): HTMLElement | null {
      return document.querySelector<HTMLElement>("[data-codex-composer='true'],[data-codex-composer]");
    }

    function composerRoot(input = composerInput()): Element | null {
      return input?.closest?.("[data-codex-composer-root]") || null;
    }

    function isCanonicalThreadId(value: unknown): boolean {
      return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        .test(String(value || ""));
    }

    function currentThreadId(): string {
      const candidates = Array.from(document.querySelectorAll("[data-above-composer-conversation-id]"))
        .filter((candidate) => (
          candidate !== document.body
          && !candidate.matches("[data-codex-composer],[data-codex-composer-root]")
          && isCanonicalThreadId(candidate.getAttribute("data-above-composer-conversation-id"))
        ));
      const root = composerRoot();
      const node = candidates.find((candidate) => (
        root != null && candidate.closest("[data-codex-composer-root]") === root
      )) || candidates.find((candidate) => !candidate.closest("[data-codex-composer-root]"));
      return node?.getAttribute("data-above-composer-conversation-id") || "";
    }

    function isVisible(node: Element | null | undefined): node is Element {
      if (!node || node.getClientRects().length === 0) return false;
      if (node.closest("[hidden], [inert], [aria-hidden='true']")) return false;
      const style = getComputedStyle(node);
      return style.display !== "none" && style.visibility !== "hidden";
    }

    function normalizeModelLabel(value: unknown): string {
      return normalizeText(value).replace(/^GPT(?:-|\s)+/i, "");
    }

    function selectedModel(): ModelChoice | null {
      const threadId = currentThreadId();
      if (threadId) return selectedModelsByThread.get(threadId) || null;
      const root = composerRoot();
      return root ? selectedModelsByComposer.get(root) || null : null;
    }

    function rememberSelectedModel(model: ModelChoice): void {
      const threadId = currentThreadId();
      if (threadId) selectedModelsByThread.set(threadId, model);
      else {
        const root = composerRoot();
        if (root) selectedModelsByComposer.set(root, model);
      }
      syncModelTriggerLabel();
    }

    function clearRememberedModel(): void {
      const threadId = currentThreadId();
      if (threadId) selectedModelsByThread.delete(threadId);
      else {
        const root = composerRoot();
        if (root) selectedModelsByComposer.delete(root);
      }
    }

    function syncModelTriggerLabel(): void {
      const model = selectedModel();
      if (!model) return;
      const triggers = Array.from(document.querySelectorAll("[data-codex-intelligence-trigger='true']"))
        .filter(isVisible);
      for (const trigger of triggers) {
        const labels = Array.from(trigger.querySelectorAll("[class*='ModelPickerTriggerModelText']"))
          .filter(isVisible);
        for (const label of labels) {
          if (normalizeText(label.textContent) !== model.label) label.textContent = model.label ?? null;
        }
      }
    }

    function scheduleSync(): void {
      if (syncTimer) return;
      syncTimer = window.setTimeout(() => {
        syncTimer = 0;
        syncModelTriggerLabel();
      }, 40);
    }

    function focusComposer(): void {
      const focus = () => {
        const input = composerInput();
        if (!input?.isConnected) return;
        input.focus({ preventScroll: true });
      };
      focus();
      // 原生菜单关闭时会在下一轮事件循环把焦点还给触发按钮；延迟后再确认一次。
      window.setTimeout(focus, 0);
      window.setTimeout(focus, 80);
    }

    function waitFor<T>(predicate: () => T | null | undefined, timeout = 10000): Promise<T> {
      const started = Date.now();
      return new Promise((resolve, reject) => {
        const poll = (): void => {
          const value = predicate();
          if (value) return resolve(value);
          if (Date.now() - started >= timeout) return reject(new Error("等待 Codex 页面更新超时"));
          window.setTimeout(poll, 60);
        };
        poll();
      });
    }

    function reactHandler(node: Element, name: string): (event: Event) => void {
      const handler = propsFor(node)?.[name];
      if (typeof handler !== "function") {
        throw new Error(`当前 Codex Desktop 没有可用的原生模型菜单 ${name} 处理器`);
      }
      return handler;
    }

    function invokeReactHandler(node: Element, name: string, event: Event): void {
      Object.defineProperty(event, "currentTarget", { value: node });
      reactHandler(node, name)(event);
    }

    function pointerDownEvent(): PointerEvent {
      return new PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        composed: true,
        button: 0,
        buttons: 1,
        pointerType: "mouse",
      });
    }

    function clickEvent(): MouseEvent {
      return new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        composed: true,
        button: 0,
      });
    }

    function visibleModelItem(label: string | undefined): Element | undefined {
      return Array.from(document.querySelectorAll("[role='menuitem'], [role='menuitemradio']")).find((item) => (
        normalizeModelLabel(item.textContent) === normalizeModelLabel(label) && isVisible(item)
      ));
    }

    async function nativeModelItem(model: ModelChoice): Promise<Element> {
      const trigger = Array.from(document.querySelectorAll("[data-codex-intelligence-trigger='true']"))
        .find(isVisible);
      if (!trigger) throw new Error("找不到 Codex 原生模型菜单按钮");
      invokeReactHandler(trigger, "onPointerDown", pointerDownEvent());
      let item = await waitFor(() => (
        visibleModelItem(model.label)
        || Array.from(document.querySelectorAll("[role='menuitem'], [role='menuitemradio']")).find((candidate) => (
          (candidate.hasAttribute("data-model-picker-view-toggle")
            || /^(?:模型|Select model)(?:\s|$)/i.test(normalizeText(candidate.getAttribute("aria-label"))))
          && isVisible(candidate)
        ))
      ));
      if (normalizeModelLabel(item.textContent) !== normalizeModelLabel(model.label)) {
        invokeReactHandler(item, "onClick", clickEvent());
        item = await waitFor(() => visibleModelItem(model.label));
      }
      return item;
    }

    function closeModelMenu(): void {
      document.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Escape",
        code: "Escape",
        bubbles: true,
        cancelable: true,
      }));
    }

    function delay(ms: number): Promise<void> {
      return new Promise((resolve) => window.setTimeout(resolve, ms));
    }

    async function applyModel(model: ModelChoice): Promise<boolean> {
      try {
        if (model.direction) model = tierModel(model.direction);
        const modelItem = await nativeModelItem(model);
        invokeReactHandler(modelItem, "onPointerDown", pointerDownEvent());
        invokeReactHandler(modelItem, "onClick", clickEvent());
        rememberSelectedModel(model);
        closeModelMenu();
        focusComposer();
        return true;
      } catch (error: any) {
        closeModelMenu();
        focusComposer();
        console.error(`[codex+] 切换至 ${model.label} 失败：${error?.message || error}`);
        return false;
      } finally {
        // Let Desktop commit the native selection before a newer pending shortcut
        // opens the model picker again.
        await delay(80);
      }
    }

    async function selectModel(model: ModelChoice): Promise<void> {
      pendingModel = model;
      if (drainingModels) return;
      drainingModels = true;
      try {
        while (pendingModel) {
          while (busy) await delay(20);
          const nextModel: ModelChoice = pendingModel;
          pendingModel = null;
          busy = true;
          try {
            await applyModel(nextModel);
          } finally {
            busy = false;
          }
        }
      } finally {
        drainingModels = false;
      }
    }

    function interceptModelShortcut(event: KeyboardEvent): void {
      if (event.type !== "keydown" || event.repeat || event.isComposing
        || (!event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      const direction = event.code === "Equal" || event.key === "=" ? -1
        : event.code === "Minus" || event.key === "-" ? 1 : 0;
      if (!direction) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      void selectModel({ direction });
    }

    function tierModel(direction: number): ModelChoice {
      const trigger = Array.from(document.querySelectorAll("[data-codex-intelligence-trigger='true']"))
        .find(isVisible);
      if (!trigger) throw new Error("找不到 Codex 原生模型菜单按钮");
      const label = trigger.querySelector("[class*='ModelPickerTriggerModelText']");
      const current = MODEL_TIERS.findIndex((model) => model.label === normalizeModelLabel(label?.textContent));
      const next = current < 0 ? (direction < 0 ? 0 : MODEL_TIERS.length - 1)
        : (current + direction + MODEL_TIERS.length) % MODEL_TIERS.length;
      return MODEL_TIERS[next];
    }

    function clearRememberedModelOnNativeSelection(event: MouseEvent): void {
      if (event.type !== "click") return;
      const item = (event.target as Element | null)?.closest?.("[role='menuitem'], [role='menuitemradio']");
      if (!item || !MODEL_LABELS.has(normalizeModelLabel(item.textContent))) return;
      clearRememberedModel();
    }

    window.addEventListener("keydown", interceptModelShortcut, true);
    document.addEventListener("keydown", interceptModelShortcut, true);
    document.addEventListener("click", clearRememberedModelOnNativeSelection, true);

    const observer = new MutationObserver(scheduleSync);
    const startObserver = (): void => {
      if (!document.body) {
        window.setTimeout(startObserver, 50);
        return;
      }
      observer.observe(document.body, { childList: true, subtree: true });
    };
    startObserver();

    window.__CODEX_PLUS_MODEL_SHORTCUTS_DEBUG__ = {
      version: VERSION,
      currentThreadId,
      selectModel,
      syncModelTriggerLabel,
    };

    return () => {
      clearTimeout(syncTimer);
      observer.disconnect();
      selectedModelsByThread.clear();
      window.removeEventListener("keydown", interceptModelShortcut, true);
      document.removeEventListener("keydown", interceptModelShortcut, true);
      document.removeEventListener("click", clearRememberedModelOnNativeSelection, true);
    };
  },
});
