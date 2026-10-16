// 侧栏项目行显示各 Git 仓库的当前分支与工作区状态；只通过原生 Git worker 做只读查询。

import { appendStyle } from "../runtime/dom.ts";
import { installFeature } from "../runtime/feature.ts";
import { fiberFor } from "../runtime/react.ts";

const CLASS = "codex-plus-project-branches";
const STYLE_ID = `${CLASS}-style`;
const ROW = "[data-app-action-sidebar-project-row]";
const HOST = "data-codex-plus-project-branches-host";

interface View {
  label: string;
  state: string;
  description: string;
}

interface Native {
  worker: any;
  hostAtom: any;
}

interface Watch {
  controller: AbortController;
  off: Array<() => void>;
  ready: Promise<void>;
  cancel: () => void;
}

interface Entry {
  key: string;
  root: string;
  hostId: string;
  row: Element;
  view: View | null;
  nextRead: number;
  controller: AbortController | null;
  watch?: Watch | null;
}

installFeature({
  cleanupKey: "__CODEX_PLUS_PROJECT_BRANCHES_CLEANUP__",
  install() {
    let disposed = false;
    let nativePromise: Promise<Native> | null = null;
    let nativeController: AbortController | null = null;
    let frame: number | null = null;
    const entries = new Map<string, Entry>();

    function groupFor(row: Element): any {
      const id = row.getAttribute("data-app-action-sidebar-project-id");
      for (let fiber = fiberFor(row), depth = 0; fiber && depth < 40; fiber = fiber.return, depth++) {
        const group = fiber.memoizedProps?.group || fiber.memoizedProps?.project?.group;
        if (group?.projectId === id) return group;
      }
      return null;
    }

    function scopeFor(row: Element): any {
      for (let fiber = fiberFor(row), depth = 0; fiber && depth < 80; fiber = fiber.return, depth++) {
        for (let hook = fiber.memoizedState, count = 0; hook && count < 100; hook = hook.next, count++) {
          const scope = hook.memoizedState?.current;
          if (scope?.node && scope.chain && typeof scope.get === "function") return scope;
        }
      }
      return null;
    }

    async function nativeApi(signal: AbortSignal): Promise<Native> {
      const urls = [...document.querySelectorAll<HTMLLinkElement>("link[rel='modulepreload']")]
        .map((node) => node.href).filter((url) => /\/app-shared[^/]*\.js(?:$|\?)/.test(url));
      for (const url of urls) {
        const module = await import(url);
        signal.throwIfAborted();
        const accessor: any = Object.values(module).find((value) => typeof value === "function"
          && value.toString().includes("case`computer-use`") && value.toString().includes("case`git`"));
        if (!accessor) continue;
        // Resolve the host atom by its configuration keys, never a minified export name.
        const source = await (await fetch(url, { signal })).text();
        signal.throwIfAborted();
        const symbol = /(\w+)=\w+\(\w+,\(\w+,\{get:\w+\}\)=>\{let \w+=\w+\(\w+,`host_config`\)/.exec(source)?.[1];
        const exports = source.slice(source.lastIndexOf("export{"));
        const entry = exports.slice(7, exports.indexOf("}")).split(",")
          .map((value) => value.trim().split(/\s+as\s+/)).find(([name]) => name === symbol);
        return { worker: accessor("git"), hostAtom: entry && module[entry[1] || entry[0]] };
      }
      throw new Error("当前 Codex 版本没有可用的 Git 查询入口");
    }

    function loadNative(): Promise<Native> {
      if (nativePromise) return nativePromise;
      const controller = new AbortController();
      nativeController = controller;
      let onAbort!: () => void;
      const canceled = new Promise<never>((_, reject) => {
        onAbort = () => reject(new Error("Git 查询入口加载超时或已取消"));
        controller.signal.addEventListener("abort", onAbort, { once: true });
      });
      const timeout = setTimeout(() => controller.abort(), 8000);
      const pending: Promise<Native> = Promise.race([nativeApi(controller.signal), canceled]).catch((error) => {
        if (nativePromise === pending) nativePromise = null;
        throw error;
      }).finally(() => {
        clearTimeout(timeout);
        controller.signal.removeEventListener("abort", onAbort);
        if (nativeController === controller) nativeController = null;
      });
      nativePromise = pending;
      return nativePromise;
    }

    function statusView(branch: any, status: any): View | null {
      const label = branch.isDetached ? "HEAD" : branch.branch;
      if (!label) return null;
      if (status?.type !== "success") return { label, state: "unknown", description: "Git 状态读取失败" };
      const { stagedCount: staged, unstagedCount: unstaged, untrackedCount: untracked } = status;
      if (![staged, unstaged, untracked].every((value) => Number.isInteger(value) && value >= 0)) {
        return { label, state: "unknown", description: "Git 状态不完整" };
      }
      const state = unstaged || untracked ? "dirty" : staged ? "staged" : "clean";
      const description = state === "clean" ? "工作区干净"
        : `已暂存 ${staged} · 未暂存 ${unstaged} · 未跟踪 ${untracked}`;
      return { label, state, description: `${branch.isDetached ? "游离 HEAD · " : ""}${description}` };
    }

    function retainWatch(entry: Entry, native: Native, params: object): Watch {
      if (entry.watch) return entry.watch;
      const subscriptionId = crypto.randomUUID();
      let resolveReady!: () => void;
      let rejectReady!: (error: unknown) => void;
      const watch: Watch = {
        controller: new AbortController(),
        off: [],
        ready: new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; }),
        cancel: () => {
          watch.controller.abort();
          watch.off.splice(0).forEach((off) => off());
          rejectReady(new Error("Git 自动刷新订阅已取消"));
          if (entry.watch === watch) entry.watch = null;
        },
      };
      const fail = (error: any) => {
        rejectReady(error);
        watch.cancel();
        if (!disposed && entries.get(entry.key) === entry) {
          entry.view = { label: "Git ?", state: "unknown", description: String(error?.message || error) };
          entry.nextRead = Date.now() + 5000;
          schedule();
        }
      };
      entry.watch = watch;
      watch.off.push(native.worker.subscribe("git-live-query-updated", (event: any) => {
        if (event.subscriptionId !== subscriptionId || event.phase !== "complete") return;
        if (event.result?.type !== "success") { fail(new Error("Git 自动刷新状态读取失败")); return; }
        // The first snapshot is published only after the native watcher is ready.
        // Reading before this can cache a HEAD whose change is missed during setup.
        resolveReady(); entry.nextRead = 0; schedule();
      }));
      watch.off.push(native.worker.subscribe("git-live-query-failed", (event: any) => {
        if (event.subscriptionId === subscriptionId) fail(new Error("Git 自动刷新订阅失败"));
      }));
      void native.worker.request({ method: "subscribe-live-query", params: {
        ...params, subscriptionId,
        query: { method: "status-summary", params: { cwd: entry.root, includeUntrackedFiles: true } },
      }, signal: watch.controller.signal }).catch((error: unknown) => {
        if (!watch.controller.signal.aborted) fail(error);
      }).finally(() => watch.cancel());
      return watch;
    }

    async function refresh(entry: Entry): Promise<void> {
      if (disposed || entry.controller || Date.now() < entry.nextRead) return;
      const controller = new AbortController();
      entry.controller = controller;
      try {
        const native = await loadNative();
        if (disposed || controller.signal.aborted) return;
        const scope = scopeFor(entry.row);
        const hostConfig = native.hostAtom && scope ? scope.get(native.hostAtom, entry.hostId)
          : entry.hostId === "local" ? { id: "local" } : null;
        if (!hostConfig || hostConfig.id !== entry.hostId) throw new Error("项目主机配置不可用");
        const params = { hostConfig, operationSource: "sidebar_project_branch" };
        const request = (method: string, extra: object) => native.worker.request({ method, params: { ...params, ...extra }, signal: controller.signal });
        const watch = retainWatch(entry, native, params);
        const cancelWatch = () => watch.cancel();
        controller.signal.addEventListener("abort", cancelWatch, { once: true });
        const timeout = setTimeout(() => controller.abort(), 8000);
        try {
          await watch.ready;
          if (controller.signal.aborted) throw new Error("Git 查询已取消");
          const [branch, status] = await Promise.all([
            request("current-branch", { root: entry.root }),
            request("status-summary", { cwd: entry.root, includeUntrackedFiles: true }),
          ]);
          if (controller.signal.aborted) throw new Error("Git 查询超时");
          if (entry.watch !== watch) throw new Error("Git 自动刷新订阅已失效");
          entry.view = statusView(branch, status);
        } finally { clearTimeout(timeout); controller.signal.removeEventListener("abort", cancelWatch); }
      } catch (error) {
        entry.view = { label: "Git ?", state: "unknown", description: String((error as any)?.message || error) };
      } finally {
        entry.controller = null;
        entry.nextRead = Date.now() + 5000;
        if (!disposed && entries.get(entry.key) === entry) schedule();
      }
    }

    function render(): void {
      frame = null;
      if (disposed || document.hidden) return;
      const active = new Set<string>();
      const containers = new Set<HTMLElement>();
      for (const row of document.querySelectorAll(ROW)) {
        const group = groupFor(row);
        const host = document.getElementById(row.getAttribute("aria-labelledby") as string);
        if (!group || !host || !row.contains(host) || !["local", "remote"].includes(group.projectKind)) continue;
        const repos: string[] = [...new Set<string>((group.gitRepos || []).map((repo: any) => repo.root).filter((root: unknown) => typeof root === "string" && root))];
        if (!repos.length) continue;
        const hostId: string = group.projectKind === "remote" ? group.hostId : "local";
        let container = host.querySelector<HTMLElement>(`.${CLASS}`);
        if (!container) { container = document.createElement("span"); container.className = CLASS; host.append(container); }
        host.setAttribute(HOST, "");
        containers.add(container);
        const labels: HTMLElement[] = [];
        for (const root of repos) {
          const key = JSON.stringify([group.projectId, hostId, root]);
          active.add(key);
          let entry = entries.get(key);
          if (!entry) { entry = { key, root, hostId, row, view: null, nextRead: 0, controller: null }; entries.set(key, entry); }
          entry.row = row;
          void refresh(entry);
          if (!entry.view) continue;
          const badge = document.createElement("span");
          badge.className = `${CLASS}-badge`;
          badge.dataset.state = entry.view.state;
          const displayLabel = entry.view.label.slice(entry.view.label.lastIndexOf("/") + 1);
          badge.textContent = displayLabel;
          badge.setAttribute("aria-label", `${root} · ${entry.view.label} · ${entry.view.description}`);
          labels.push(badge);
        }
        // Avoid producing observer churn on unchanged native rows.
        const signature = labels.map((label) => `${label.dataset.state}:${label.getAttribute("aria-label")}`).join("\n");
        if (container.dataset.signature !== signature) { container.dataset.signature = signature; container.replaceChildren(...labels); }
      }
      for (const [key, entry] of entries) {
        if (active.has(key)) continue;
        entry.controller?.abort(); entry.watch?.cancel(); entries.delete(key);
      }
      document.querySelectorAll<HTMLElement>(`.${CLASS}`).forEach((container) => {
        if (!containers.has(container)) { container.parentElement?.removeAttribute(HOST); container.remove(); }
      });
    }

    function schedule(): void {
      if (!disposed && frame === null) frame = requestAnimationFrame(render);
    }
    function wake(): void {
      if (document.hidden) return;
      for (const entry of entries.values()) entry.nextRead = 0;
      schedule();
    }
    const style = appendStyle(STYLE_ID, `
    [${HOST}] > [data-marquee-text] { min-width:0; flex:1; }
    .${CLASS} { display:inline-flex; min-width:0; max-width:48%; gap:6px; margin-inline-start:6px; font-size:calc(1em - 2px); line-height:1.4; }
    .${CLASS}:empty { display:none; }
    .${CLASS}-badge { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--text-tertiary,#888); }
    .${CLASS}-badge[data-state=clean], .${CLASS}-badge[data-state=staged] { color:light-dark(#16803b,#59c878); }
    .${CLASS}-badge[data-state=dirty] { color:light-dark(#c53737,#f27777); }
  `);
    const observer = new MutationObserver((records) => {
      if (records.some((record) => record.type === "attributes" || [...record.addedNodes, ...record.removedNodes]
        .some((node) => node.nodeType === 1 && !(node as Element).classList.contains(`${CLASS}-badge`)
          && ((node as Element).matches(ROW) || (node as Element).querySelector(ROW) || (node as Element).closest(ROW))))) schedule();
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true,
      attributeFilter: ["data-app-action-sidebar-project-id", "aria-labelledby"] });
    const timer = setInterval(schedule, 1000);
    window.addEventListener("focus", wake);
    document.addEventListener("visibilitychange", wake);
    schedule();
    return () => {
      disposed = true; observer.disconnect(); clearInterval(timer); if (frame !== null) cancelAnimationFrame(frame);
      nativeController?.abort();
      window.removeEventListener("focus", wake); document.removeEventListener("visibilitychange", wake);
      for (const entry of entries.values()) { entry.controller?.abort(); entry.watch?.cancel(); }
      entries.clear(); style.remove();
      document.querySelectorAll(`.${CLASS}`).forEach((node) => node.remove());
      document.querySelectorAll(`[${HOST}]`).forEach((node) => node.removeAttribute(HOST));
    };
  },
});
