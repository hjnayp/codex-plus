// 在每组连续消息的首条旁显示可自定义的角色头像；位置由原生 CSS 锚点驱动，图片只存本机。

import { appendStyle } from "../runtime/dom.ts";
import { installFeature } from "../runtime/feature.ts";

type Role = "assistant" | "user";

interface AvatarEntry {
  button: HTMLButtonElement;
  role: Role;
  viewport: HTMLDivElement;
  anchor: string;
  originalAnchor?: string;
  anchorPriority?: string;
  hadStyle?: boolean;
  installedAnchor?: string;
  timer?: number;
  deadline?: number | null;
  lastPosition?: { left: number; top: number };
  detached?: boolean;
}

const PREFIX = "codex-plus-message-avatar";
const KEY = "codex-plus.message-avatars.v1.";
const USER = '[data-local-conversation-user-anchor="true"],[data-message-author-role="user"],[data-user-message-bubble="true"]';
const ASSISTANT = '[data-local-conversation-final-assistant="true"],[data-message-author-role="assistant"],[data-response-annotation-conversation][data-response-annotation-target]';
const FREEZE_MS = 200;

installFeature({
  cleanupKey: "__CODEX_PLUS_MESSAGE_AVATARS_CLEANUP__",
  install() {
    const hosts = new Map<HTMLElement, AvatarEntry>();
    const frozen = new Set<AvatarEntry>();
    const images = new Map<Role, string>();
    let database: IDBDatabase | null = null;
    let disposed = false;
    let dialog: HTMLDialogElement | null = null;
    let returnFocus: HTMLElement | null = null;
    let releaseCrop: (() => void) | null = null;
    let frame: number | null = null;
    let anchorSequence = 0;
    let session = "";
    let navigation: { previous: string } | null = null;

    const style = appendStyle(`${PREFIX}-style`, `
      .${PREFIX}-layer { position: fixed; inset: 0; pointer-events: none; z-index: 10; overflow: hidden; }
      .${PREFIX}-viewport { position: fixed; inset: 0; pointer-events: none; }
      .${PREFIX} { position: fixed; top: anchor(top); position-visibility: anchors-visible;
        width: 88px; height: 88px; padding: 0;
        display: grid; place-items: center; border-radius: 50%; overflow: hidden; cursor: pointer;
        border: 1px solid var(--color-token-border-default, #8883); color: inherit;
        pointer-events: auto; background: var(--color-token-bg-secondary, #8881); }
      .${PREFIX}[data-role=assistant] { left: anchor(left); transform: translateX(calc(-100% - 12px)); }
      .${PREFIX}[data-role=user] { left: anchor(right); transform: translateX(12px); }
      .${PREFIX}[hidden] { display: none !important; }
      .${PREFIX}:focus-visible { outline: 2px solid #7c78dc; outline-offset: 3px; }
      .${PREFIX} img { width: 100%; height: 100%; object-fit: cover; }
      .${PREFIX} svg { width: 22px; height: 22px; }
      .${PREFIX}-dialog { color: var(--color-token-text-primary, inherit);
        background: var(--color-token-bg-primary, Canvas); border: 1px solid #8884;
        position: fixed; inset: 0; margin: auto; box-sizing: border-box;
        border-radius: 16px; padding: 24px; width: min(420px, calc(100vw - 32px)); max-height: calc(100vh - 32px); overflow-y: auto; }
      .${PREFIX}-dialog::backdrop { background: #0005; }
      .${PREFIX}-dialog h2 { font-size: 18px; font-weight: 600; margin: 0 0 12px; }
      .${PREFIX}-dialog p { font-size: 13px; margin: 12px 0; }
      .${PREFIX}-dialog button { border: 1px solid #8884; border-radius: 8px; padding: 6px 12px; cursor: pointer; }
      .${PREFIX}-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }
      .${PREFIX}-dialog input { max-width: 100%; }
      .${PREFIX}-crop { position: relative; width: min(280px, 100%); aspect-ratio: 1; margin: 20px auto 12px;
        overflow: hidden; background: repeating-conic-gradient(#bbb 0% 25%, #eee 0% 50%) 50% / 16px 16px; }
      .${PREFIX}-crop canvas { display: block; width: 100%; height: 100%; cursor: grab; touch-action: none; }
      .${PREFIX}-crop canvas:active { cursor: grabbing; }
      .${PREFIX}-mask { position: absolute; inset: 0; border-radius: 50%; pointer-events: none;
        box-shadow: 0 0 0 80px #0007; border: 1px solid #fff9; }
      .${PREFIX}-zoom { display: flex; align-items: center; gap: 12px; }
      .${PREFIX}-zoom input { flex: 1; min-width: 0; }
      .${PREFIX}-dialog [hidden] { display: none !important; }
    `);
    const layer = document.createElement("div");
    layer.className = `${PREFIX}-layer`;
    layer.dataset.codexPlusAvatarOwned = "true";
    document.body.append(layer);

    function saved(role: Role): string {
      if (images.has(role)) return images.get(role)!;
      try {
        const value = localStorage.getItem(KEY + role) || "";
        return value.length <= 500000 && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(value) ? value : "";
      } catch { return ""; }
    }

    // Image storage is separate from the app's nearly-full synchronous localStorage.
    const ready = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("codex-plus-message-avatars", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("images");
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("头像存储正在升级，请关闭其他 Codex 窗口后重试。"));
      request.onsuccess = () => {
        if (disposed) { request.result.close(); reject(new Error("头像组件已关闭")); return; }
        database = request.result;
        database.onversionchange = () => database!.close();
        resolve(database);
      };
    });
    async function loadImages(): Promise<void> {
      const db = await ready;
      const transaction = db.transaction("images", "readonly");
      for (const role of ["assistant", "user"] as const) {
        const request = transaction.objectStore("images").get(role);
        request.onsuccess = () => {
          if (disposed) return;
          if (typeof request.result === "string") images.set(role, request.result);
          refreshImages();
        };
      }
    }
    async function persist(role: Role, data: string): Promise<void> {
      const db = await ready;
      if (disposed) throw new Error("头像组件已关闭");
      await new Promise((resolve, reject) => {
        const transaction = db.transaction("images", "readwrite");
        transaction.objectStore("images").put(data, role);
        transaction.oncomplete = resolve;
        transaction.onabort = transaction.onerror = () => reject(transaction.error || new Error("头像存储写入失败"));
      });
      images.set(role, data);
      if (!disposed) { refreshImages(); channel?.postMessage({ role, data }); }
    }
    const channel = typeof BroadcastChannel === "function" ? new BroadcastChannel("codex-plus-message-avatars") : null;
    if (channel) channel.onmessage = (event: MessageEvent) => {
      const { role, data } = event.data || {};
      if (["assistant", "user"].includes(role) && typeof data === "string" && data.length <= 500000
        && (data === "" || /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(data))) {
        images.set(role, data); refreshImages();
      }
    };
    void loadImages().catch((error) => console.warn("Codex+ 头像存储不可用", error.name));

    function paint(button: HTMLButtonElement, role: Role): void {
      const src = saved(role);
      if (button.dataset.image === src && button.childElementCount) return;
      button.dataset.image = src;
      button.replaceChildren();
      if (src) {
        const img = document.createElement("img");
        img.src = src;
        img.alt = role === "assistant" ? "GPT 头像" : "我的头像";
        button.append(img);
      } else {
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("viewBox", "0 0 24 24");
        svg.setAttribute("fill", "none");
        svg.setAttribute("stroke", "currentColor");
        svg.setAttribute("stroke-width", "1.6");
        svg.setAttribute("aria-hidden", "true");
        const path = document.createElementNS(svg.namespaceURI, "path");
        path.setAttribute("d", role === "assistant"
          ? "M12 3l2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z"
          : "M16 8a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM4 21v-2a8 8 0 0 1 16 0v2");
        svg.append(path);
        button.append(svg);
      }
    }

    function refreshImages(): void {
      for (const { button, role } of [...hosts.values(), ...frozen]) paint(button, role);
    }

    async function readImage(file: File): Promise<ImageBitmap> {
      if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) throw new Error("请选择 PNG、JPEG、WebP 或 GIF 图片。");
      try { return await createImageBitmap(file); }
      catch { throw new Error("图片无法读取，请换一张图片重试。"); }
    }

    function closeDialog(): void {
      if (!dialog) return;
      releaseCrop?.();
      releaseCrop = null;
      dialog.close();
      dialog.remove();
      dialog = null;
      if (!disposed && returnFocus?.isConnected) returnFocus.focus();
      returnFocus = null;
    }

    function openDialog(role: Role, trigger: HTMLElement): void {
      closeDialog();
      returnFocus = trigger;
      const current = document.createElement("dialog");
      dialog = current;
      current.className = `${PREFIX}-dialog`;
      current.dataset.codexPlusAvatarOwned = "true";
      current.setAttribute("aria-labelledby", `${PREFIX}-title`);
      const heading = document.createElement("h2");
      heading.id = `${PREFIX}-title`;
      heading.textContent = role === "assistant" ? "设置 GPT 头像" : "设置我的头像";
      const hint = document.createElement("p");
      hint.textContent = "直接选择原图，拖动图片并缩放，调整圆形头像范围。仅保存在这台电脑，GIF 使用静态首帧。";
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/png,image/jpeg,image/webp,image/gif";
      input.setAttribute("aria-label", "上传头像");
      const status = document.createElement("p");
      status.setAttribute("role", "status");
      const editor = document.createElement("div");
      editor.hidden = true;
      const viewport = document.createElement("div");
      viewport.className = `${PREFIX}-crop`;
      const preview = document.createElement("canvas");
      preview.width = preview.height = 280;
      preview.tabIndex = 0;
      preview.setAttribute("role", "img");
      preview.setAttribute("aria-label", "头像裁剪预览，可拖动或使用方向键调整位置");
      const mask = document.createElement("div");
      mask.className = `${PREFIX}-mask`;
      viewport.append(preview, mask);
      const zoomRow = document.createElement("label");
      zoomRow.className = `${PREFIX}-zoom`;
      zoomRow.append("缩放");
      const zoom = document.createElement("input");
      zoom.type = "range"; zoom.min = "1"; zoom.max = "4"; zoom.step = "0.01"; zoom.value = "1";
      zoom.setAttribute("aria-label", "头像缩放");
      zoomRow.append(zoom);
      editor.append(viewport, zoomRow);
      let crop: { image: ImageBitmap; x: number; y: number } | null = null;
      let drag: { id: number; x: number; y: number } | null = null;
      releaseCrop = () => { crop?.image.close(); crop = null; drag = null; };
      function draw(target = preview): void {
        if (!crop) return;
        const side = Math.min(crop.image.width, crop.image.height) / Number(zoom.value);
        crop.x = Math.max(side / 2, Math.min(crop.image.width - side / 2, crop.x));
        crop.y = Math.max(side / 2, Math.min(crop.image.height - side / 2, crop.y));
        const context = target.getContext("2d")!;
        context.clearRect(0, 0, target.width, target.height);
        context.drawImage(crop.image, crop.x - side / 2, crop.y - side / 2, side, side, 0, 0, target.width, target.height);
      }
      zoom.oninput = () => draw();
      preview.onpointerdown = (event) => {
        if (!crop || event.button !== 0) return;
        event.preventDefault();
        preview.setPointerCapture(event.pointerId);
        preview.focus();
        drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
      };
      preview.onpointermove = (event) => {
        if (!crop || drag?.id !== event.pointerId) return;
        const factor = Math.min(crop.image.width, crop.image.height) / Number(zoom.value) / preview.getBoundingClientRect().width;
        crop.x -= (event.clientX - drag.x) * factor;
        crop.y -= (event.clientY - drag.y) * factor;
        drag.x = event.clientX; drag.y = event.clientY;
        draw();
      };
      preview.onpointerup = preview.onpointercancel = preview.onlostpointercapture = () => { drag = null; };
      const actions = document.createElement("div");
      actions.className = `${PREFIX}-actions`;
      const reset = document.createElement("button");
      reset.type = "button";
      reset.textContent = "恢复默认";
      reset.onclick = async () => {
        reset.disabled = input.disabled = save.disabled = true;
        try { await persist(role, ""); if (dialog !== current) return; releaseCrop!(); editor.hidden = true; status.textContent = "已恢复默认头像。"; }
        catch (error) { status.textContent = `恢复失败：${(error as Error).message}`; }
        finally { reset.disabled = input.disabled = false; save.disabled = !crop; }
      };
      const done = document.createElement("button");
      done.type = "button";
      done.textContent = "取消";
      done.onclick = closeDialog;
      const save = document.createElement("button");
      save.type = "button";
      save.textContent = "保存";
      save.disabled = true;
      save.onclick = async () => {
        if (!crop) return;
        save.disabled = reset.disabled = input.disabled = true;
        try {
          const output = document.createElement("canvas");
          output.width = output.height = 256;
          draw(output);
          await persist(role, output.toDataURL("image/png"));
          if (dialog === current) closeDialog();
        } catch (error) { status.textContent = `保存失败，原头像已保留：${(error as Error).message}`; }
        finally { save.disabled = !crop; reset.disabled = input.disabled = false; }
      };
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return;
        input.disabled = reset.disabled = save.disabled = true;
        status.textContent = "正在处理图片…";
        try {
          const image = await readImage(file);
          if (disposed || dialog !== current) { image.close(); return; }
          crop?.image.close();
          crop = { image, x: image.width / 2, y: image.height / 2 };
          zoom.value = "1";
          editor.hidden = false;
          draw();
          status.textContent = "拖动图片或调整缩放，满意后点击保存。";
        } catch (error) {
          if (!disposed && dialog === current) status.textContent = (error as Error).name === "QuotaExceededError"
            ? "存储空间不足，原头像已保留。" : ((error as Error).message || "图片无法读取，请换一张图片重试。");
        } finally { input.disabled = reset.disabled = false; save.disabled = !crop; input.value = ""; }
      };
      current.addEventListener("cancel", (event) => { event.preventDefault(); closeDialog(); });
      actions.append(reset, done, save);
      current.append(heading, hint, input, editor, status, actions);
      document.body.append(current);
      current.showModal();
    }

    function unbind(host: HTMLElement, entry: AvatarEntry): void {
      if (host.style.getPropertyValue("anchor-name") === entry.installedAnchor) {
        if (entry.originalAnchor) host.style.setProperty("anchor-name", entry.originalAnchor, entry.anchorPriority);
        else host.style.removeProperty("anchor-name");
      }
      if (!entry.hadStyle && host.style.length === 0) host.removeAttribute("style");
      resizeObserver.unobserve(host);
      hosts.delete(host);
    }

    function bind(host: HTMLElement, entry: AvatarEntry): void {
      thaw(entry);
      entry.originalAnchor = host.style.getPropertyValue("anchor-name");
      entry.anchorPriority = host.style.getPropertyPriority("anchor-name");
      entry.hadStyle = host.hasAttribute("style");
      const existingAnchor = getComputedStyle(host).getPropertyValue("anchor-name").trim();
      entry.installedAnchor = existingAnchor && existingAnchor !== "none" ? `${existingAnchor}, ${entry.anchor}` : entry.anchor;
      host.style.setProperty("anchor-name", entry.installedAnchor, "important");
      hosts.set(host, entry);
      resizeObserver.observe(host);
    }

    function remove(host: HTMLElement, entry: AvatarEntry): void {
      unbind(host, entry);
      entry.viewport.remove();
    }

    function thaw(entry: AvatarEntry): void {
      window.clearTimeout(entry.timer);
      frozen.delete(entry);
      entry.deadline = null;
      for (const property of ["top", "left", "transform", "position-visibility"])
        entry.button.style.removeProperty(property);
      entry.button.style.setProperty("position-anchor", entry.anchor);
    }

    function discard(entry: AvatarEntry): void {
      window.clearTimeout(entry.timer);
      frozen.delete(entry);
      entry.viewport.remove();
    }

    function freeze(entry: AvatarEntry): void {
      if (!entry.lastPosition) { discard(entry); return; }
      const { left, top } = entry.lastPosition;
      entry.button.style.setProperty("position-anchor", "none");
      entry.button.style.setProperty("position-visibility", "always");
      entry.button.style.top = `${top}px`;
      entry.button.style.left = `${left}px`;
      entry.button.style.transform = "none";
      entry.deadline = performance.now() + FREEZE_MS;
      frozen.add(entry);
      entry.timer = window.setTimeout(() => discard(entry), FREEZE_MS);
    }

    function clearAvatars(): void {
      for (const [host, entry] of hosts) remove(host, entry);
      for (const entry of frozen) discard(entry);
    }

    function normalizeSession(value: string | null | undefined): string {
      return (value || "").replace(/^(?:local|cloud):/, "");
    }

    function rendered(node: Element): boolean {
      // Cached tabs remain connected under display:none. Offscreen messages in
      // the active scroller still have client rects and must retain their group.
      return node.getClientRects().length > 0 && getComputedStyle(node).visibility !== "hidden";
    }

    function currentSession(): string {
      // Composer identity is authoritative; the sidebar may retain a temporary
      // row identity even after the message view has a permanent conversation ID.
      const composer = [...document.querySelectorAll("[data-above-composer-conversation-id]")].find(rendered);
      if (composer) return normalizeSession(composer.getAttribute("data-above-composer-conversation-id"));
      const annotation = [...document.querySelectorAll("[data-response-annotation-conversation]")].find(rendered);
      return normalizeSession(annotation?.getAttribute("data-response-annotation-conversation"));
    }

    function checkSession(): boolean {
      const next = currentSession();
      if (navigation) {
        if (!next || next === navigation.previous) return false;
        navigation = null;
      }
      const promoted = /^client-new-thread:/.test(session) && !/^client-new-thread:/.test(next);
      if (next && session && next !== session && !promoted) clearAvatars();
      if (next) session = next;
      return true;
    }

    function position(): void {
      frame = null;
      if (disposed) return;
      const bounds = layer.getBoundingClientRect();
      const scale = bounds.width / layer.clientWidth || 1;
      for (const [host, entry] of hosts) {
        const { button, role, viewport } = entry;
        if (!host.isConnected) continue;
        const rect = host.getBoundingClientRect();
        const size = 64 * scale;
        const x = role === "assistant" ? rect.left - 76 * scale : rect.right + 12 * scale;
        let left = bounds.left, right = bounds.right, top = bounds.top, bottom = bounds.bottom;
        for (let parent = host.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
          const css = getComputedStyle(parent);
          if (/(auto|scroll|hidden|clip)/.test(css.overflowX + css.overflowY)) {
            const clip = parent.getBoundingClientRect();
            if (/(auto|scroll|hidden|clip)/.test(css.overflowX)) { left = Math.max(left, clip.left); right = Math.min(right, clip.right); }
            if (/(auto|scroll|hidden|clip)/.test(css.overflowY)) { top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom); }
          }
        }
        const hidden = rect.width === 0 || rect.height === 0 || x < left || x + size > right;
        if (button.hidden !== hidden) button.hidden = hidden;
        const clipPath = `inset(${Math.max(0, top - bounds.top) / scale}px ${Math.max(0, bounds.right - right) / scale}px ${Math.max(0, bounds.bottom - bottom) / scale}px ${Math.max(0, left - bounds.left) / scale}px)`;
        if (viewport.style.clipPath !== clipPath) viewport.style.clipPath = clipPath;
        // CSS anchor layout can still report the previous scroll position in a
        // frame callback. Cache the resolved anchor geometry from the live host
        // and actual avatar width before that host can be disconnected.
        const avatar = button.getBoundingClientRect();
        const width = avatar.width || parseFloat(getComputedStyle(button).width) * scale;
        const avatarLeft = role === "assistant" ? rect.left - width - 12 * scale : rect.right + 12 * scale;
        entry.lastPosition = { left: (avatarLeft - bounds.left) / scale, top: (rect.top - bounds.top) / scale };
      }
    }

    function schedulePosition(): void {
      if (!disposed && frame === null) frame = requestAnimationFrame(position);
    }
    const resizeObserver = new ResizeObserver(schedulePosition);
    resizeObserver.observe(layer);

    function scan(): void {
      if (disposed) return;
      if (!checkSession()) return;
      const candidates = new Map<HTMLElement, Role>();
      document.querySelectorAll<HTMLElement>(USER).forEach((node) => candidates.set(node.querySelector<HTMLElement>('[data-user-message-bubble="true"]') || node, "user"));
      document.querySelectorAll<HTMLElement>(ASSISTANT).forEach((node) => {
        if (node.closest(USER)) return;
        const final = node.closest<HTMLElement>('[data-local-conversation-final-assistant="true"]');
        const host = final && final.parentElement?.matches(".flex.flex-col.gap-0") && !final.parentElement.querySelector(USER)
          ? final.parentElement : (final || node);
        candidates.set(host, "assistant");
      });
      for (const host of candidates.keys()) if (!rendered(host)) candidates.delete(host);
      // Keep the outer message host when annotation and final-answer selectors overlap.
      for (const host of candidates.keys()) {
        for (let parent = host.parentElement; parent; parent = parent.parentElement) {
          if (candidates.has(parent)) { candidates.delete(host); break; }
        }
      }
      const ordered = [...candidates].sort(([a], [b]) =>
        a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
      // Group by message order, not viewport visibility: only the first message
      // of each consecutive run owns an avatar, even when it scrolls out of view.
      candidates.clear();
      let previousRole: Role | null = null;
      for (const [host, role] of ordered) {
        if (role !== previousRole) candidates.set(host, role);
        previousRole = role;
      }
      // Avatars are per role, so an obsolete binding can supply the same button
      // and decoded image to a replacement host in this scan.
      for (const entry of frozen) if (performance.now() >= entry.deadline!) discard(entry);
      const reusable: Record<Role, AvatarEntry[]> = { user: [], assistant: [] };
      for (const entry of frozen) reusable[entry.role].push(entry);
      for (const [host, entry] of hosts) {
        if (!host.isConnected || candidates.get(host) !== entry.role) {
          unbind(host, entry);
          entry.detached = !host.isConnected;
          reusable[entry.role].push(entry);
        }
      }
      let nextViewport = layer.firstElementChild;
      for (const [host, role] of candidates) {
        let entry = hosts.get(host);
        if (!entry) {
          entry = reusable[role].shift();
          if (!entry) {
            const button = document.createElement("button");
            button.type = "button";
            button.className = PREFIX;
            button.dataset.role = role;
            button.dataset.codexPlusAvatarOwned = "true";
            button.setAttribute("aria-label", role === "assistant" ? "设置 GPT 头像" : "设置我的头像");
            button.title = button.getAttribute("aria-label")!;
            button.onclick = (event) => { event.stopPropagation(); openDialog(role, button); };
            const viewport = document.createElement("div");
            viewport.className = `${PREFIX}-viewport`;
            viewport.dataset.codexPlusAvatarOwned = "true";
            viewport.append(button);
            const anchor = `--codex-plus-avatar-${++anchorSequence}`;
            button.style.setProperty("position-anchor", anchor);
            entry = { button, role, viewport, anchor };
            paint(button, role);
          }
          bind(host, entry);
        }
        if (entry.viewport !== nextViewport) layer.insertBefore(entry.viewport, nextViewport);
        nextViewport = entry.viewport.nextElementSibling;
      }
      for (const entry of [...reusable.user, ...reusable.assistant]) {
        if (frozen.has(entry)) continue;
        if (entry.detached) freeze(entry);
        else discard(entry);
      }
      position();
    }

    const observer = new MutationObserver((records) => {
      if (records.some((record) => !(record.target as Element).closest?.("[data-codex-plus-avatar-owned]")
        && (record.type !== "attributes" || !["class", "style", "hidden", "aria-hidden"].includes(record.attributeName!)
          || (record.target as Element).matches(`${USER},${ASSISTANT},[data-above-composer-conversation-id]`)
          || (record.target as Element).querySelector(`${USER},${ASSISTANT},[data-above-composer-conversation-id]`))
        && (record.type === "attributes" || [...record.addedNodes, ...record.removedNodes].some((node) =>
          node.nodeType === 1 && !(node as Element).matches?.("[data-codex-plus-avatar-owned]"))))) {
        // Mutation observers run after the DOM commit and before painting. A
        // timer or the next animation frame leaves disconnected anchors visible
        // to at least one paint during native message remounts.
        scan();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true,
      attributeFilter: ["data-message-author-role", "data-local-conversation-final-assistant", "data-local-conversation-user-anchor", "data-response-annotation-target", "data-user-message-bubble", "data-above-composer-conversation-id", "data-response-annotation-conversation", "class", "style", "hidden", "aria-hidden"] });
    const onNavigate = (event: MouseEvent) => {
      const row = (event.target as Element).closest?.("[data-app-action-sidebar-thread-id]");
      const control = (event.target as Element).closest?.("button,[role='button'],a,input,[aria-haspopup]");
      // Thread rows also contain pin/archive/menu controls that do not navigate.
      if (row && control && control !== row && row.contains(control)) return;
      if (row?.matches("[data-app-action-sidebar-thread-active='true'],[data-app-action-sidebar-thread-selected='true']")) return;
      const next = normalizeSession(row?.getAttribute("data-app-action-sidebar-thread-id"));
      if (!next || next === session) return;
      navigation = { previous: currentSession() || session };
      clearAvatars();
    };
    document.addEventListener("click", onNavigate, true);
    const onStorage = (event: StorageEvent) => { if (event.key === null || event.key.startsWith(KEY)) refreshImages(); };
    window.addEventListener("storage", onStorage);
    // Only refresh clipping when a containing viewport moves. Avatar coordinates remain native CSS anchors.
    document.addEventListener("scroll", schedulePosition, true);
    window.addEventListener("resize", schedulePosition);
    scan();
    return () => {
      disposed = true;
      if (frame !== null) cancelAnimationFrame(frame);
      observer.disconnect();
      resizeObserver.disconnect();
      window.removeEventListener("storage", onStorage);
      document.removeEventListener("scroll", schedulePosition, true);
      window.removeEventListener("resize", schedulePosition);
      document.removeEventListener("click", onNavigate, true);
      channel?.close();
      database?.close();
      closeDialog();
      clearAvatars();
      style.remove();
      layer.remove();
    };
  },
});
