// 本文件的函数都经 toString 注入 Codex 页面执行，不能引用模块作用域内的任何符号；
// 互相依赖的函数由调用方作为参数一并注入。类型只在编译期存在，不影响注入。

declare global {
  interface Window { __codexRoot?: any }
}

export type ThreadKind = "main" | "subagent" | "released" | "prewarm" | "ephemeral";
export type ThreadState = "waiting" | "running" | "viewing" | "idle";

export interface LoadedThread {
  id: string;
  title: string;
  cwd: string;
  kind: ThreadKind;
  source: string;
  tracked: boolean;
  state: ThreadState;
  idleMinutes: number | null;
  subagent: { nickname: string; role: string; parentId: string; parentTitle: string } | null;
}

export interface ReclaimedThread {
  title: string;
  idleMinutes: number;
}

export interface ReclaimResult {
  recent: number;
  guarded: number;
  backgroundTerminal: number;
  terminalCheckFailed: number;
  subagentListFailed: boolean;
  reclaimed: ReclaimedThread[];
  failed: ReclaimedThread[];
}

export interface ReclaimOptions {
  idleMs: number;
  dryRun: boolean;
  subagents?: boolean;
}

// 找出本机 App Server 的对话管理器。打开对话时它作为 manager prop 下传，其他页面只保存在
// hook state 的管理器数组里，所以两处都要找。云端与远程 SSH 主机的对话不占本机进程，不处理。
export function findLocalConversationManagerInPage(): any {
  const root = window.__codexRoot?._internalRoot?.current;
  if (!root) throw new Error("找不到 Codex React 根节点");
  const isLocal = (value: any) => Boolean(value?.inactiveThreadUnsubscriber) && value.hostId === "local";
  const fibers: any[] = [root];
  const visited = new Set();
  while (fibers.length) {
    const fiber = fibers.pop();
    if (!fiber || visited.has(fiber)) continue;
    visited.add(fiber);
    if (fiber.child) fibers.push(fiber.child);
    if (fiber.sibling) fibers.push(fiber.sibling);
    if (isLocal(fiber.memoizedProps?.manager)) return fiber.memoizedProps.manager;
    for (let hook = fiber.memoizedState, depth = 0; hook && typeof hook === "object" && depth < 64; hook = hook.next, depth += 1) {
      const state = hook.memoizedState;
      const found = Array.isArray(state) ? state.find(isLocal) : (isLocal(state) ? state : null);
      if (found) return found;
    }
  }
  throw new Error("当前 Codex Desktop 版本找不到本机对话管理器");
}

// 以 App Server 的 thread/loaded/list 为准列出全部已加载对话，再叠加前端回收器看到的状态。
// 子代理、预热的空白新对话与临时线程同样加载了 MCP 等运行时，但前端不跟踪它们，官方回收器看不到。
export async function listLoadedThreadsInPage(manager: any): Promise<LoadedThread[]> {
  const tracker = manager.inactiveThreadUnsubscriber;
  const { threadStore, streamState, requestClient } = tracker.params || {};
  if (typeof requestClient?.sendRequest !== "function" || typeof threadStore?.getConversation !== "function") {
    throw new Error("对话管理器接口已变化");
  }
  const request = (method: string, params: object) => requestClient.sendRequest(method, params, { priority: "background", source: "thread" });

  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    const page = await request("thread/loaded/list", cursor ? { cursor } : {});
    if (!Array.isArray(page?.data)) throw new Error("thread/loaded/list 返回格式已变化");
    ids.push(...page.data);
    cursor = page.nextCursor || null;
  } while (cursor);

  const nowMs = Date.now();
  const titleOf = (id: string): string => {
    const title = threadStore.getConversation(id)?.title || threadStore.getThreadSummary?.(id)?.title;
    return title ? String(title) : "";
  };
  const threads: LoadedThread[] = [];
  for (const id of ids) {
    let thread: any = null;
    try {
      thread = (await request("thread/read", { threadId: id, includeTurns: false }))?.thread || null;
    } catch {
      // 读取失败时仍列出 ID，状态按前端已知信息推断。
    }
    const conversation = threadStore.getConversation(id);
    const tracked = conversation?.resumeState === "resumed"
      && streamState?.ownsConversationHistoryStream?.(id) === true;
    const runtime = thread?.status || conversation?.threadRuntimeStatus || null;
    const flags: unknown[] = Array.isArray(runtime?.activeFlags) ? runtime.activeFlags : [];
    const inactiveSinceMs = tracked
      ? tracker.inactiveOwnerConversationSinceById?.get(id)
      : (Number(thread?.updatedAt) > 0 ? Number(thread.updatedAt) * 1000 : undefined);
    let state: ThreadState;
    if (flags.some((flag) => /waiting/i.test(String(flag)))) state = "waiting";
    else if (runtime?.type === "active" || (tracked && tracker.shouldKeepConversationLoaded?.(conversation))) state = "running";
    else if (tracked && (tracker.hasActiveConversationView?.(id) || tracker.hasOwnedStreamFollowers?.(id))) state = "viewing";
    else state = inactiveSinceMs == null ? "viewing" : "idle";

    const parentId = thread?.parentThreadId || conversation?.parentThreadId || null;
    const cwd = thread?.cwd || conversation?.cwd || "";
    const title = (titleOf(id) || thread?.name || thread?.preview || "").replace(/\s+/g, " ").slice(0, 60);
    let kind: ThreadKind = "main";
    if (parentId) kind = "subagent";
    // 官方按工作目录预热空白新对话，供下次新建时直接使用。
    else if (!tracked && !title && manager.prewarmedThreadManager?.prewarmedThreadByCwd?.has?.(cwd)) kind = "prewarm";
    else if (!tracked && thread?.ephemeral) kind = "ephemeral";
    // 前端已取消订阅（官方回收或 gc）的主对话，App Server 会在空闲约 1 分钟后卸载。
    else if (!tracked && conversation?.resumeState === "needs_resume") kind = "released";
    threads.push({
      id,
      title,
      cwd,
      kind,
      source: thread?.threadSource || "",
      tracked,
      state,
      idleMinutes: state === "idle" ? Math.max(0, Math.floor((nowMs - (inactiveSinceMs as number)) / 60000)) : null,
      subagent: parentId ? {
        nickname: thread?.agentNickname || "",
        role: thread?.agentRole || "",
        parentId,
        parentTitle: titleOf(parentId).slice(0, 40) || parentId,
      } : null,
    });
  }
  return threads;
}

// 主对话复用官方闲置对话回收器，只把它的 3 小时阈值换成本次阈值；官方回收器负责 thread/unsubscribe
// 与前端状态（needs_resume），再次打开对话时正常 resume。
// 前端不跟踪的子代理线程由本函数直接 thread/unsubscribe；App Server 在没有订阅者且空闲时自行卸载，
// 父对话再次需要时由官方按父对话恢复。预热对话与临时线程归官方或扩展宿主管理，不回收。
export async function reclaimIdleThreadsInPage(
  { idleMs, dryRun, subagents = true }: ReclaimOptions,
  findManager: () => any,
  listLoaded: (manager: any) => Promise<LoadedThread[]>,
): Promise<ReclaimResult> {
  const manager = findManager();
  const result: ReclaimResult = {
    recent: 0, guarded: 0, backgroundTerminal: 0,
    terminalCheckFailed: 0, subagentListFailed: false, reclaimed: [], failed: [],
  };
  const tracker = manager.inactiveThreadUnsubscriber;
  const { threadStore, streamState, requestClient } = tracker.params || {};
  const required = [
    tracker.inactiveOwnerConversationSinceById instanceof Map,
    tracker.unsubscribingConversationIds instanceof Set,
    typeof threadStore?.getConversation === "function",
    typeof streamState?.ownsConversationHistoryStream === "function",
    typeof tracker.hasActiveConversationView === "function",
    typeof tracker.hasOwnedStreamFollowers === "function",
    typeof tracker.shouldKeepConversationLoaded === "function",
    typeof requestClient?.sendRequest === "function",
    typeof manager.unsubscribeInactiveConversation === "function",
  ];
  if (required.includes(false)) throw new Error("官方闲置对话回收器接口已变化，拒绝回收");
  const request = (method: string, params: object) => requestClient.sendRequest(method, params, { priority: "background", source: "thread" });

  const nowMs = Date.now();
  const candidates: { threadId: string; subagent: boolean; title: string; idleMinutes: number }[] = [];
  for (const [threadId, inactiveSinceMs] of tracker.inactiveOwnerConversationSinceById) {
    const conversation = threadStore.getConversation(threadId);
    const retryAtMs = tracker.inactiveOwnerConversationRetryAtById?.get(threadId) ?? null;
    // 与官方 getInactiveOwnerConversationIdsToUnsubscribe 的保护条件一致。
    if (tracker.unsubscribingConversationIds.has(threadId)
      || conversation?.resumeState !== "resumed"
      || !streamState.ownsConversationHistoryStream(threadId)
      || tracker.hasActiveConversationView(threadId)
      || tracker.hasOwnedStreamFollowers(threadId)
      || tracker.shouldKeepConversationLoaded(conversation)
      || (retryAtMs != null && retryAtMs > nowMs)) {
      result.guarded += 1;
      continue;
    }
    if (nowMs - inactiveSinceMs < idleMs) {
      result.recent += 1;
      continue;
    }
    candidates.push({
      threadId,
      subagent: false,
      title: String(conversation.title || threadId).slice(0, 60),
      idleMinutes: Math.floor((nowMs - inactiveSinceMs) / 60000),
    });
  }

  if (subagents) {
    let threads: LoadedThread[] | null = null;
    try {
      threads = await listLoaded(manager);
    } catch {
      result.subagentListFailed = true;
    }
    const byId = new Map((threads || []).map((thread) => [thread.id, thread] as const));
    for (const thread of threads || []) {
      if (thread.kind !== "subagent" || thread.tracked) continue;
      const subagent = thread.subagent as NonNullable<LoadedThread["subagent"]>;
      const parent = byId.get(subagent.parentId);
      // 子代理或其父对话仍在运行、等待审批或输入时，父对话可能继续与子代理通信。
      if (thread.state !== "idle" || parent?.state === "running" || parent?.state === "waiting") {
        result.guarded += 1;
        continue;
      }
      const idleMinutes = thread.idleMinutes as number;
      if (idleMinutes * 60000 < idleMs) {
        result.recent += 1;
        continue;
      }
      const agent = [subagent.nickname, subagent.role && `(${subagent.role})`].filter(Boolean).join(" ");
      candidates.push({
        threadId: thread.id,
        subagent: true,
        title: `子代理 ${agent || thread.id} ← ${subagent.parentTitle}`,
        idleMinutes,
      });
    }
  }

  // 官方回收不看后台终端；开发服务器等仍在运行的对话保留，盘点失败同样跳过。
  for (const { threadId, subagent, title, idleMinutes } of candidates) {
    let terminals: any;
    try {
      terminals = await request("thread/backgroundTerminals/list", { threadId, limit: 1 });
    } catch {
      result.terminalCheckFailed += 1;
      continue;
    }
    if (!Array.isArray(terminals?.data)) {
      result.terminalCheckFailed += 1;
      continue;
    }
    if (terminals.data.length) {
      result.backgroundTerminal += 1;
      continue;
    }
    if (dryRun) {
      result.reclaimed.push({ title, idleMinutes });
      continue;
    }
    let reclaimed: boolean;
    if (subagent) {
      try {
        const response = await request("thread/unsubscribe", { threadId });
        reclaimed = response?.status === "unsubscribed" || response?.status === "notLoaded";
      } catch {
        reclaimed = false;
      }
    } else {
      // 官方实现自行捕获失败并安排重试，失败时对话仍是 resumed，因此按前端状态判定结果。
      await manager.unsubscribeInactiveConversation(threadId);
      reclaimed = threadStore.getConversation(threadId)?.resumeState !== "resumed";
    }
    result[reclaimed ? "reclaimed" : "failed"].push({ title, idleMinutes });
  }
  return result;
}
