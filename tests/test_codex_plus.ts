import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import type {
  ChildProcess,
  ChildProcessByStdio,
  SpawnOptions,
  SpawnSyncOptionsWithStringEncoding,
  SpawnSyncReturns,
} from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildBundle } from "../src/build/bundle.ts";
import { CdpClient } from "../src/hosts/codex-desktop/cdp.ts";
import type { CdpTarget } from "../src/hosts/codex-desktop/cdp.ts";
import type { LoadedThread, ReclaimOptions, ReclaimResult } from "../src/hosts/codex-desktop/page/threads.ts";
import { readRendererSource } from "../src/hosts/codex-desktop/renderers.ts";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(TEST_DIR, "..");
const SOURCE_DIR = path.join(PACKAGE_ROOT, "src");
const HOST_DIR = path.join(SOURCE_DIR, "hosts", "codex-desktop");
const PAGE_DIR = path.join(HOST_DIR, "page");
const MAIN = path.join(HOST_DIR, "main.ts");

interface AsyncCommandResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function runCommand(args: string[], options: SpawnSyncOptionsWithStringEncoding): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [MAIN, ...args], {
    ...options,
    env: options.env || process.env,
  });
}

function runCommandAsync(args: string[], options: SpawnOptions = {}): Promise<AsyncCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MAIN, ...args], {
      ...options,
      env: options.env || process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

function restoreKeybindings(env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [
    "--input-type=module",
    "-e",
    `import { pathToFileURL } from "node:url";
     const { createContext } = await import(pathToFileURL(process.env.CODEX_PLUS_TEST_CONTEXT).href);
     await createContext().keybindings.restore();`,
  ], { encoding: "utf8", env: { ...env, CODEX_PLUS_TEST_CONTEXT: path.join(HOST_DIR, "commands", "context.ts") } });
}

function findTestBrowser() {
  const candidates = [
    process.env.CODEX_PLUS_TEST_CHROME,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter((candidate): candidate is string => Boolean(candidate));
  return candidates.find((candidate) => fs.existsSync(candidate)) || "";
}

async function stopTestBrowser(child: ChildProcess, profile: string) {
  if (child.exitCode == null && child.signalCode == null) {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
    if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL");
  }
}

function removeTestProfile(profile: string) {
  fs.rmSync(profile, {
    recursive: true,
    force: true,
  });
}

function assertNoRuntimeException(response: any, context: string) {
  assert.equal(response?.exceptionDetails, undefined,
    `${context}: ${response?.exceptionDetails?.exception?.description || response?.exceptionDetails?.text || "Runtime.evaluate failed"}`);
}

test("SC-CODEX-PLUS-029: 默认 CDP 端口冲突时选择并记住安全端口", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-plus-port-fallback-"));
  const codexHome = path.join(stateDir, "codex-home");
  const testEnv = { ...process.env };
  delete testEnv.CODEX_PLUS_CDP_PORT;
  const occupied = net.createServer();
  const ownsDefaultPort = await new Promise<boolean>((resolve, reject) => {
    occupied.once("error", (error: NodeJS.ErrnoException) => {
      if (error?.code === "EADDRINUSE") resolve(false);
      else reject(error);
    });
    occupied.listen(57331, "127.0.0.1", () => resolve(true));
  });
  try {
    const result = runCommand(["start"], {
      encoding: "utf8",
      env: {
        ...testEnv,
        CODEX_PLUS_STATE_DIR: stateDir,
        CODEX_PLUS_CODEX_HOME: codexHome,
        CODEX_PLUS_SKIP_APP: "1",
        CODEX_PLUS_CHATGPT_APP: path.join(stateDir, "missing-app"),
        CODEX_PLUS_STARTUP_TIMEOUT_MS: "500",
      },
    });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /本机端口 57331 已被占用，已切换到安全端口/);
    const allocation = JSON.parse(fs.readFileSync(path.join(stateDir, "cdp-port.json"), "utf8"));
    assert.equal(allocation.port === 57331, false);
    assert.equal(Number.isInteger(allocation.port), true);

    const status = runCommand(["status"], {
      encoding: "utf8",
      env: {
        ...testEnv,
        CODEX_PLUS_STATE_DIR: stateDir,
        CODEX_PLUS_CODEX_HOME: codexHome,
        CODEX_PLUS_SKIP_APP: "1",
      },
    });
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, new RegExp(`本地 CDP: 未就绪（127\\.0\\.0\\.1:${allocation.port}）`));
  } finally {
    if (ownsDefaultPort) await new Promise((resolve) => occupied.close(resolve));
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("CDP 可为单次命令扩展超时", async () => {
  const client = new CdpClient("ws://unused");
  client.socket = {
    readyState: WebSocket.OPEN,
    send(payload: string) {
      const { id } = JSON.parse(payload);
      setTimeout(() => {
        const pending = client.pending.get(id);
        client.pending.delete(id);
        pending?.resolve({ ok: true });
      }, 20);
    },
  } as unknown as WebSocket;
  await assert.rejects(
    client.send("Runtime.evaluate", {}, { timeoutMs: 5 }),
    /CDP command timed out: Runtime\.evaluate/,
  );
  assert.deepEqual(
    await client.send("Runtime.evaluate", {}, { timeoutMs: 100 }),
    { ok: true },
  );
});

// threads 是前端回收器跟踪的主对话；loaded 是只在 App Server 加载、前端不跟踪的线程（thread/read 的返回）。
interface FakeThreadState {
  status?: { type: string; activeFlags: string[] };
  inProgress?: boolean;
  backgroundTerminal?: boolean;
  terminalError?: boolean;
}

interface FakeThread extends FakeThreadState {
  id: string;
  title?: string;
  idleMinutes: number;
  viewing?: boolean;
  resumeState?: string;
}

interface FakeLoadedThread extends FakeThreadState {
  parentThreadId?: string;
  updatedAt?: number;
  agentNickname?: string;
  agentRole?: string;
  threadSource?: string;
  ephemeral?: boolean;
  cwd?: string;
  preview?: string;
}

interface FakeCodexPageOptions {
  unsubscribeFails?: boolean;
  loaded?: Record<string, FakeLoadedThread>;
  managerInHook?: boolean;
}

function fakeCodexPage(threads: FakeThread[], { unsubscribeFails = false, loaded = {}, managerInHook = false }: FakeCodexPageOptions = {}) {
  const calls: { unsubscribe: string[]; terminals: string[]; appServerUnsubscribe: string[] } = { unsubscribe: [], terminals: [], appServerUnsubscribe: [] };
  const conversations = new Map(threads.map((thread) => [thread.id, {
    id: thread.id, title: thread.title || thread.id, resumeState: thread.resumeState || "resumed",
  }]));
  const remote = { ...loaded };
  const find = (id: string): FakeThread | FakeLoadedThread | undefined => threads.find((item) => item.id === id) || remote[id];
  const tracker = {
    inactiveOwnerConversationSinceById: new Map(threads.map((thread) => [thread.id, Date.now() - thread.idleMinutes * 60000])),
    inactiveOwnerConversationRetryAtById: new Map(),
    unsubscribingConversationIds: new Set(),
    params: {
      threadStore: { getConversation: (id: string) => conversations.get(id) },
      streamState: { ownsConversationHistoryStream: (id: string) => conversations.get(id)?.resumeState === "resumed" },
      requestClient: {
        async sendRequest(method: string, params: { threadId: string; cursor?: string }) {
          if (method === "thread/backgroundTerminals/list") {
            calls.terminals.push(params.threadId);
            const thread = find(params.threadId)!;
            if (thread.terminalError) throw new Error("terminal list failed");
            return { data: thread.backgroundTerminal ? [{ id: "dev-server" }] : [] };
          }
          if (method === "thread/loaded/list") {
            // 分两页返回，验证游标翻页。
            const ids = [...conversations.keys()].filter((id) => conversations.get(id)!.resumeState === "resumed")
              .concat(Object.keys(remote));
            const half = Math.ceil(ids.length / 2);
            return params.cursor ? { data: ids.slice(half), nextCursor: null } : { data: ids.slice(0, half), nextCursor: "page-2" };
          }
          if (method === "thread/read") {
            const thread = find(params.threadId)!;
            const status = thread.status || (thread.inProgress ? { type: "active", activeFlags: [] } : { type: "idle" });
            return { thread: { id: params.threadId, cwd: "/w/a", ...thread, status } };
          }
          assert.equal(method, "thread/unsubscribe");
          calls.appServerUnsubscribe.push(params.threadId);
          if (unsubscribeFails) throw new Error("unsubscribe failed");
          delete remote[params.threadId];
          return { status: "unsubscribed" };
        },
      },
    },
    hasActiveConversationView: (id: string) => threads.find((item) => item.id === id)?.viewing === true,
    hasOwnedStreamFollowers: () => false,
    shouldKeepConversationLoaded: (conversation: { id: string }) => threads.find((item) => item.id === conversation.id)?.inProgress === true,
  };
  // 测试会删除管理器上的成员以模拟 Codex 接口变化，所以按 any 处理。
  const manager: any = {
    hostId: "local",
    inactiveThreadUnsubscriber: tracker,
    prewarmedThreadManager: { prewarmedThreadByCwd: new Map([["/w/a", {}]]) },
    async unsubscribeInactiveConversation(id: string) {
      calls.unsubscribe.push(id);
      if (!unsubscribeFails) conversations.get(id)!.resumeState = "needs_resume";
    },
  };
  // 打开对话时管理器作为 manager prop 下传；停在其他页面时只在 hook state 的管理器数组里，且混有云端主机。
  const cloud = { hostId: "durable", inactiveThreadUnsubscriber: {} };
  const fiber = managerInHook
    ? { memoizedState: { memoizedState: null, next: { memoizedState: [cloud, manager], next: null } } }
    : { memoizedProps: { manager } };
  const window = { __codexRoot: { _internalRoot: { current: { child: fiber } } } };
  return { window, manager, calls };
}

type FakeCodexPage = ReturnType<typeof fakeCodexPage>;

async function runPageGc(page: FakeCodexPage, options: ReclaimOptions): Promise<ReclaimResult> {
  const { findLocalConversationManagerInPage, listLoadedThreadsInPage, reclaimIdleThreadsInPage } = await import("../src/hosts/codex-desktop/page/threads.ts");
  // 与 gc 命令一样经 toString 注入，确保页面函数不依赖模块作用域。
  const run = new Function("window", `return (${reclaimIdleThreadsInPage})(${JSON.stringify(options)}, ${findLocalConversationManagerInPage}, ${listLoadedThreadsInPage});`);
  return run(page.window);
}

async function runPageList(page: FakeCodexPage): Promise<Record<string, LoadedThread>> {
  const { findLocalConversationManagerInPage, listLoadedThreadsInPage } = await import("../src/hosts/codex-desktop/page/threads.ts");
  const run = new Function("window", `return (${listLoadedThreadsInPage})((${findLocalConversationManagerInPage})());`);
  return Object.fromEntries((await run(page.window)).map((thread: LoadedThread) => [thread.id, thread]));
}

const minutesAgo = (minutes: number) => Math.floor((Date.now() - minutes * 60000) / 1000);

test("gc 只回收闲置满阈值且不受保护的对话，dry-run 不取消订阅", async () => {
  const threads = [
    { id: "old", title: "旧对话", idleMinutes: 75 },
    { id: "recent", idleMinutes: 59 },
    { id: "viewing", idleMinutes: 120, viewing: true },
    { id: "running", idleMinutes: 120, inProgress: true },
    { id: "dev-server", idleMinutes: 120, backgroundTerminal: true },
    { id: "terminal-unknown", idleMinutes: 120, terminalError: true },
  ];
  const options = { idleMs: 60 * 60000 };

  const preview = fakeCodexPage(threads);
  const planned = await runPageGc(preview, { ...options, dryRun: true });
  assert.deepEqual(planned.reclaimed, [{ title: "旧对话", idleMinutes: 75 }]);
  assert.deepEqual(preview.calls.unsubscribe, []);

  const page = fakeCodexPage(threads);
  const result = await runPageGc(page, { ...options, dryRun: false });
  assert.deepEqual(page.calls.unsubscribe, ["old"]);
  assert.deepEqual(result.reclaimed, [{ title: "旧对话", idleMinutes: 75 }]);
  assert.deepEqual(result.failed, []);
  assert.equal(result.recent, 1);
  assert.equal(result.guarded, 2);
  assert.equal(result.backgroundTerminal, 1);
  assert.equal(result.terminalCheckFailed, 1);
  assert.deepEqual(page.calls.terminals.sort(), ["dev-server", "old", "terminal-unknown"]);

  // -t 0 放开时间阈值，但保护条件不变。
  const zero = fakeCodexPage(threads);
  const all = await runPageGc(zero, { idleMs: 0, dryRun: false });
  assert.deepEqual(zero.calls.unsubscribe.sort(), ["old", "recent"]);
  assert.equal(all.recent, 0);
  assert.equal(all.guarded, 2);
  assert.equal(all.backgroundTerminal, 1);
});

test("gc 在官方回收失败时报告失败，接口变化时拒绝回收", async () => {
  const failing = fakeCodexPage([{ id: "old", idleMinutes: 90 }], { unsubscribeFails: true });
  const result = await runPageGc(failing, { idleMs: 60 * 60000, dryRun: false });
  assert.deepEqual(result.reclaimed, []);
  assert.deepEqual(result.failed, [{ title: "old", idleMinutes: 90 }]);

  const changed = fakeCodexPage([{ id: "old", idleMinutes: 90 }]);
  delete changed.manager.unsubscribeInactiveConversation;
  await assert.rejects(runPageGc(changed, { idleMs: 60 * 60000, dryRun: false }), /接口已变化，拒绝回收/);
  assert.deepEqual(changed.calls.unsubscribe, []);
});

test("gc 回收前端不跟踪的闲置子代理，保护运行中的子代理与父对话，不动预热与临时线程", async () => {
  const subagent = (parentThreadId: string, minutes: number, extra: FakeLoadedThread = {}): FakeLoadedThread => ({
    parentThreadId, updatedAt: minutesAgo(minutes), agentNickname: "Kant", agentRole: "reviewer", ...extra,
  });
  const threads = [
    { id: "parent-idle", title: "空闲父对话", idleMinutes: 5 },
    { id: "parent-busy", title: "忙碌父对话", idleMinutes: 0, inProgress: true },
  ];
  const loaded = {
    "sub-old": subagent("parent-idle", 90),
    "sub-young": subagent("parent-idle", 10),
    "sub-busy-parent": subagent("parent-busy", 90),
    "sub-running": subagent("parent-idle", 90, { status: { type: "active", activeFlags: [] } }),
    "sub-orphan": subagent("unloaded-parent", 90, { agentNickname: "", agentRole: "" }),
    "sub-terminal": subagent("parent-idle", 90, { backgroundTerminal: true }),
    prewarm: { threadSource: "user", updatedAt: minutesAgo(600) },
    ephemeral: { threadSource: "mcp_extension_host", ephemeral: true, cwd: "/app", updatedAt: minutesAgo(600) },
  };
  // 管理器只在 hook state 里时同样可用。
  const page = fakeCodexPage(threads, { loaded, managerInHook: true });
  const result = await runPageGc(page, { idleMs: 60 * 60000, dryRun: false });
  assert.deepEqual(page.calls.appServerUnsubscribe.sort(), ["sub-old", "sub-orphan"]);
  assert.deepEqual(page.calls.unsubscribe, []);
  assert.deepEqual(result.reclaimed.map(({ title }) => title).sort(), [
    "子代理 Kant (reviewer) ← 空闲父对话",
    "子代理 sub-orphan ← unloaded-parent",
  ]);
  // 受保护：忙碌父对话本身、父对话忙碌的子代理、运行中的子代理；未满阈值：空闲父对话与年轻子代理。
  assert.equal(result.guarded, 3);
  assert.equal(result.recent, 2);
  assert.equal(result.backgroundTerminal, 1);
  assert.equal(result.subagentListFailed, false);

  // subagents: false 时只处理前端跟踪的对话；App Server 失败时报告失败。
  const skipped = fakeCodexPage(threads, { loaded });
  await runPageGc(skipped, { idleMs: 60 * 60000, dryRun: false, subagents: false });
  assert.deepEqual(skipped.calls.appServerUnsubscribe, []);
  const failing = fakeCodexPage([], { loaded: { "sub-old": subagent("x", 90) }, unsubscribeFails: true });
  const failed = await runPageGc(failing, { idleMs: 0, dryRun: false });
  assert.deepEqual(failed.failed.map(({ title }) => title), ["子代理 Kant (reviewer) ← x"]);
});

test("status 以 App Server 已加载列表为准，按类别标出子代理、预热与临时线程", async () => {
  const threads = [
    { id: "viewing", title: "正在看", idleMinutes: 0, viewing: true },
    { id: "idle", title: "闲置对话", idleMinutes: 42 },
    { id: "running", title: "跑着的", idleMinutes: 90, inProgress: true },
    { id: "released", title: "刚回收", idleMinutes: 30, resumeState: "needs_resume" },
  ];
  const loaded = {
    released: { updatedAt: minutesAgo(30) },
    waiting: { status: { type: "active", activeFlags: ["waitingOnApproval"] }, preview: "等批准", updatedAt: minutesAgo(3) },
    sub: { parentThreadId: "idle", agentNickname: "Kant", agentRole: "reviewer", updatedAt: minutesAgo(20) },
    prewarm: { threadSource: "user", updatedAt: minutesAgo(1) },
    ephemeral: { threadSource: "mcp_extension_host", ephemeral: true, cwd: "/app", updatedAt: minutesAgo(1) },
  };
  const page = fakeCodexPage(threads, { loaded });
  const listed = await runPageList(page);

  assert.deepEqual(Object.keys(listed).sort(), ["ephemeral", "idle", "prewarm", "released", "running", "sub", "viewing", "waiting"]);
  assert.deepEqual([listed.released.kind, listed.released.tracked, listed.released.title], ["released", false, "刚回收"]);
  assert.equal(listed.viewing.state, "viewing");
  assert.deepEqual([listed.idle.state, listed.idle.idleMinutes, listed.idle.tracked], ["idle", 42, true]);
  assert.equal(listed.running.state, "running");
  assert.deepEqual([listed.waiting.state, listed.waiting.title, listed.waiting.tracked], ["waiting", "等批准", false]);
  assert.deepEqual([listed.sub.kind, listed.sub.state, listed.sub.idleMinutes], ["subagent", "idle", 20]);
  assert.deepEqual(listed.sub.subagent, { nickname: "Kant", role: "reviewer", parentId: "idle", parentTitle: "闲置对话" });
  assert.equal(listed.prewarm.kind, "prewarm");
  assert.deepEqual([listed.ephemeral.kind, listed.ephemeral.source], ["ephemeral", "mcp_extension_host"]);

  delete page.manager.inactiveThreadUnsubscriber.params.requestClient;
  await assert.rejects(runPageList(page), /接口已变化/);
  page.manager.hostId = "remote-ssh-discovered:macmini";
  await assert.rejects(runPageList(page), /找不到本机对话管理器/);
});

test("gc 需要 Codex+ 模式，旧 GC 环境变量与状态不影响现有命令", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-plus-gc-"));
  const stateFile = path.join(stateDir, "runtime-gc.json");
  const legacyState = JSON.stringify({ source: "scheduled", error: "legacy-gc-state" });
  const env = {
    ...process.env,
    CODEX_PLUS_STATE_DIR: stateDir,
    CODEX_PLUS_CDP_PORT: String(await freePort()),
    CODEX_PLUS_SKIP_APP: "1",
    CODEX_PLUS_RUNTIME_GC_ENABLED: "1",
    CODEX_PLUS_RUNTIME_GC_IDLE_MS: "invalid-legacy-value",
    CODEX_PLUS_MEMORY_WARN_MB: "invalid-legacy-value",
  };
  try {
    fs.writeFileSync(stateFile, legacyState);
    for (const args of [["gc"], ["gc", "--dry-run"]]) {
      const offline = runCommand(args, { encoding: "utf8", env });
      assert.equal(offline.status, 1);
      assert.match(offline.stderr, /gc 需要 Codex\+ 模式/);
    }
    const invalid = runCommand(["gc", "--idle-minutes", "0"], { encoding: "utf8", env });
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /gc 不支持参数：--idle-minutes/);
    for (const args of [["gc", "-t"], ["gc", "-t", "-5"], ["gc", "-t", "abc"], ["gc", "-t", "1", "-t", "2"]]) {
      const badThreshold = runCommand(args, { encoding: "utf8", env });
      assert.equal(badThreshold.status, 1);
      assert.match(badThreshold.stderr, /gc 的 -t/);
    }
    const custom = runCommand(["gc", "-t", "0", "--dry-run"], { encoding: "utf8", env });
    assert.equal(custom.status, 1);
    assert.match(custom.stderr, /gc 需要 Codex\+ 模式/);
    const manual = runCommand(["--man"], { encoding: "utf8", env });
    assert.equal(manual.status, 0, manual.stderr);
    assert.match(manual.stdout, /gc \[-t <分钟>\] \[--dry-run\]/);
    assert.doesNotMatch(manual.stdout, /CODEX_PLUS_RUNTIME_GC|CODEX_PLUS_MEMORY_WARN/);
    const status = runCommand(["status"], { encoding: "utf8", env });
    assert.equal(status.status, 0, status.stderr);
    assert.doesNotMatch(status.stdout, /GC|核心 Codex 内存|legacy-gc-state/);
    assert.equal(fs.readFileSync(stateFile, "utf8"), legacyState);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("SC-CODEX-PLUS-019: stop 会收敛未响应的守护进程并清理状态", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-plus-stop-"));
  const child = spawn(process.execPath, ["-e", [
    'process.on("SIGTERM", () => {});',
    "setInterval(() => {}, 1000);",
  ].join("")], { detached: true, stdio: "ignore" });
  child.unref();
  let stopped = false;
  try {
    fs.writeFileSync(path.join(stateDir, "daemon.pid"), `${child.pid}\n`);
    fs.writeFileSync(path.join(stateDir, "daemon.instance.json"), `${JSON.stringify({
      pid: child.pid,
      instance_id: "force-stop-test",
    })}\n`);
    fs.writeFileSync(path.join(stateDir, "ready.json"), "{}\n");
    const result = runCommand(["stop"], {
      encoding: "utf8",
      env: {
        ...process.env,
        CODEX_PLUS_STATE_DIR: stateDir,
        CODEX_PLUS_SKIP_APP: "1",
        CODEX_PLUS_STOP_TIMEOUT_MS: "100",
        CODEX_PLUS_FORCE_STOP_TIMEOUT_MS: "1000",
        CODEX_PLUS_TEST_ALLOW_FORCE_STOP: "1",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /已停止/);
    stopped = true;
    assert.equal(fs.existsSync(path.join(stateDir, "daemon.pid")), false);
    assert.equal(fs.existsSync(path.join(stateDir, "ready.json")), false);
    assert.equal(fs.existsSync(path.join(stateDir, "daemon.instance.json")), false);
  } finally {
    if (!stopped) child.kill("SIGKILL");
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});


test("SC-CODEX-PLUS-019/021: stop 先请求守护进程协作清理", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-plus-cooperative-stop-"));
  const sentinel = path.join(stateDir, "cleanup-complete");
  const child = spawn(process.execPath, ["-e", [
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    "const state = process.argv[1];",
    'const instanceId = "cooperative-stop-test";',
    'fs.writeFileSync(path.join(state, "daemon.pid"), `${process.pid}\\n`);',
    'fs.writeFileSync(path.join(state, "daemon.instance.json"), `${JSON.stringify({ pid: process.pid, instance_id: instanceId })}\\n`);',
    'fs.writeFileSync(path.join(state, "ready.json"), `${JSON.stringify({ instance_id: instanceId })}\\n`);',
    'process.on("SIGTERM", () => {});',
    "setInterval(() => {",
    '  const requestPath = path.join(state, "stop.request");',
    "  if (!fs.existsSync(requestPath)) return;",
    "  const request = JSON.parse(fs.readFileSync(requestPath, \"utf8\"));",
    "  if (request.pid !== process.pid || request.instance_id !== instanceId) return;",
    '  fs.writeFileSync(path.join(state, "cleanup-complete"), "ok\\n");',
    "  process.exit(0);",
    "}, 20);",
  ].join(""), stateDir], { detached: true, stdio: "ignore" });
  child.unref();
  try {
    const readyDeadline = Date.now() + 3000;
    while (!fs.existsSync(path.join(stateDir, "ready.json")) && Date.now() < readyDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(fs.existsSync(path.join(stateDir, "ready.json")), true);
    const result = runCommand(["stop"], {
      encoding: "utf8",
      env: {
        ...process.env,
        CODEX_PLUS_STATE_DIR: stateDir,
        CODEX_PLUS_SKIP_APP: "1",
        CODEX_PLUS_STOP_TIMEOUT_MS: "2000",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(sentinel), true);
    assert.equal(fs.existsSync(path.join(stateDir, "daemon.pid")), false);
    assert.equal(fs.existsSync(path.join(stateDir, "ready.json")), false);
    assert.equal(fs.existsSync(path.join(stateDir, "stop.request")), false);
    assert.equal(fs.existsSync(path.join(stateDir, "daemon.instance.json")), false);
  } finally {
    try { process.kill(child.pid!, "SIGKILL"); } catch {}
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

async function startCodexTargetProxy(sourcePort: number) {
  const server = http.createServer(async (request, response) => {
    if (request.url === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><html><head></head><body></body></html>");
      return;
    }
    if (request.url !== "/json/list") {
      response.writeHead(404);
      response.end();
      return;
    }
    try {
      const source = await fetch("http://127.0.0.1:" + sourcePort + "/json/list");
      if (!source.ok) throw new Error("CDP HTTP " + source.status);
      const targets = await source.json();
      const rewritten = Array.isArray(targets)
        ? targets.map((target) => (
          target?.type === "page"
            ? { ...target, url: "app://-/index.html" }
            : target
        ))
        : [];
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(rewritten));
    } catch (error) {
      response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      response.end(String((error as Error)?.message || error));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo | null;
  return {
    port: Number(address?.port),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function waitForTargets(port: number): Promise<CdpTarget> {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find((target: CdpTarget) => target.type === "page" && target.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      // Chrome 仍在启动。
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Chrome CDP 未在 10 秒内就绪");
}

test("守护进程移除已退役增强，保留快捷键、提醒、消息头像及历史数据", { timeout: 20000 }, async (t) => {
  const chrome = findTestBrowser();
  if (!chrome) return t.skip("本机未安装可测试的 Chromium 浏览器");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-plus-without-gc-"));
  const profile = path.join(root, "browser");
  const stateDir = path.join(root, "state");
  const sessionRoot = path.join(root, "sessions");
  fs.mkdirSync(stateDir);
  fs.mkdirSync(sessionRoot);
  const legacyStateFile = path.join(stateDir, "runtime-gc.json");
  const legacyState = "legacy state must remain untouched\n";
  fs.writeFileSync(legacyStateFile, legacyState);
  const legacyDatabase = path.join(root, "usage.sqlite");
  fs.writeFileSync(legacyDatabase, "historical usage must remain untouched");
  const port = await freePort();
  const browser = spawn(chrome, [
    "--headless=new", "--disable-breakpad", "--disable-background-mode", "--disable-crash-reporter",
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "about:blank",
  ], { stdio: "ignore" });
  let client: CdpClient | undefined;
  let proxy;
  let daemon: ChildProcessByStdio<null, null, Readable> | undefined;
  let daemonExit;
  let stderr = "";
  try {
    const target = await waitForTargets(port);
    client = new CdpClient(target.webSocketDebuggerUrl);
    await client.connect();
    await client.send("Runtime.enable");
    proxy = await startCodexTargetProxy(port);
    await client.send("Page.enable");
    await client.send("Page.navigate", { url: `http://127.0.0.1:${proxy.port}/` });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await client.send("Runtime.evaluate", {
      expression: `(() => {
        window.__retiredGcCalls = [];
        window.__retiredGcKeys = [
          "__CODEX_PLUS_RUNTIME_GC__", "__CODEX_PLUS_RUNTIME_GC_CURRENT_THREAD_ID__",
          "__CODEX_PLUS_RUNTIME_GC_WARNING__", "__CODEX_PLUS_RUNTIME_GC_CLEANUP__",
          "__CODEX_PLUS_APP_SERVER_REQUEST__", "__codexPlusRuntimeGcVersion",
        ];
        for (const key of window.__retiredGcKeys) window[key] = () => {
          window.__retiredGcCalls.push(key);
          throw new Error("retired GC must never run");
        };
        window.__removedStatsCalls = [];
        const footerHost = document.createElement("div");
        footerHost.id = "answer";
        footerHost.setAttribute("data-codex-plus-only-host", "true");
        footerHost.setAttribute("data-codex-plus-footer", "turn-1");
        footerHost.setAttribute("data-codex-plus-session-id", "session-1");
        footerHost.setAttribute("data-codex-plus-turn-id", "turn-1");
        footerHost.innerHTML = '<p>回答正文</p><div class="codex-plus-only-footer">旧统计</div>';
        document.body.append(footerHost);
        for (const id of ["codex-plus-only-style", "codex-plus-weekly-usage-ring", "codex-plus-weekly-usage-ring-style"]) {
          const node = document.createElement("div");
          node.id = id;
          document.body.append(node);
        }
        window.__statsTimer = setInterval(() => {
          if (!document.getElementById("codex-plus-weekly-usage-ring")) {
            const node = document.createElement("div");
            node.id = "codex-plus-weekly-usage-ring";
            document.body.append(node);
          }
        }, 50);
        window.__CODEX_PLUS_REMOVE__ = () => { window.__removedStatsCalls.push("footer"); };
        window.__CODEX_PLUS_WEEKLY_USAGE_RING_CLEANUP__ = () => {
          window.__removedStatsCalls.push("quota-tps");
          clearInterval(window.__statsTimer);
        };
        for (const key of ["__CODEX_PLUS_PUSH__", "__CODEX_PLUS_CLEANUP__", "__CODEX_PLUS_DEBUG__", "__CODEX_PLUS_WEEKLY_USAGE_RING_REFRESH__", "__CODEX_PLUS_HEADROOM_GENERATION_PUSH__", "__CODEX_PLUS_HEADROOM_REQUEST__"])
          window[key] = () => {};
        window.__extrasCalls = [];
        window.__retiredExtrasKeys = ["__CODEX_PLUS_STYLE_PERFORMANCE_CLEANUP__", "__CODEX_PLUS_TERMINAL_MEASURE_CLEANUP__", "__CODEX_PLUS_PORTRAITS_CLEANUP__", "__CODEX_PLUS_BROWSER_FAVORITES_CLEANUP__"];
        for (const key of window.__retiredExtrasKeys) window[key] = () => { window.__extrasCalls.push(key); };
        window.__CODEX_PLUS_STYLE_PERFORMANCE__ = { version: "old" };
        window.__CODEX_PLUS_TERMINAL_MEASURE__ = { version: "old" };
        for (const id of ["codex-plus-subagent-portraits", "codex-plus-browser-favorites-style"]) {
          const node = document.createElement("style"); node.id = id; document.head.append(node);
        }
        for (const name of ["codex-plus-browser-favorites", "codex-plus-browser-favorites-dialog"]) {
          const node = document.createElement("div"); node.className = name; document.body.append(node);
        }
        window.__savedFavorites = JSON.stringify({ version: 1, items: [{ name: "示例", url: "https://example.com/" }] });
        localStorage.setItem("codex-plus.browser-favorites", window.__savedFavorites);
        const style = document.createElement("style");
        style.id = "codex-plus-runtime-gc-style";
        document.head.append(style);
        const toast = document.createElement("div");
        toast.id = "codex-plus-runtime-gc-toast";
        document.body.append(toast);
      })()`,
    });
    const hashRulesPath = path.join(root, "hash-rules.toml");
    fs.writeFileSync(hashRulesPath, '# 允许注释\n[[rules]]\ntrigger = "#ap"\ntext = "old rules" # 行尾注释\n' );
    daemon = spawn(process.execPath, [MAIN, "daemon"], {
      env: {
        ...process.env,
        CODEX_PLUS_HASH_RULES_FILE: hashRulesPath,
        CODEX_PLUS_STATE_DIR: stateDir,
        CODEX_PLUS_SESSION_ROOT: sessionRoot,
        CODEX_PLUS_USAGE_DB_PATH: path.join(root, "usage.sqlite"),
        CODEX_PLUS_CDP_PORT: String(proxy.port),
        CODEX_PLUS_SKIP_APP: "1",
        CODEX_PLUS_RUNTIME_GC_ENABLED: "1",
        CODEX_PLUS_RUNTIME_GC_INTERVAL_MS: "1",
        CODEX_PLUS_RUNTIME_GC_IDLE_MS: "1",
        CODEX_PLUS_MEMORY_WARN_MB: "1",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    daemon.stderr.setEncoding("utf8");
    daemon.stderr.on("data", (chunk) => { stderr += chunk; });
    daemonExit = new Promise((resolve) => daemon!.once("exit", resolve));
    const readyFile = path.join(stateDir, "ready.json");
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(readyFile) && daemon.exitCode == null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(fs.existsSync(readyFile), true, stderr);
    const ready = JSON.parse(fs.readFileSync(readyFile, "utf8"));
    assert.equal(ready.cdp_ready, true);
    assert.equal(Object.keys(ready).some((key) => /runtime_gc|memory_warning/.test(key)), false);
    await new Promise((resolve) => setTimeout(resolve, 700));
    const result = await client.send("Runtime.evaluate", {
      expression: `({
        footer: typeof window.__CODEX_PLUS_PUSH__,
        statsCalls: window.__removedStatsCalls,
        extrasCalls: window.__extrasCalls,
        extrasKeys: [...window.__retiredExtrasKeys, "__CODEX_PLUS_STYLE_PERFORMANCE__", "__CODEX_PLUS_TERMINAL_MEASURE__"].filter(key => Object.hasOwn(window, key)),
        extrasNodes: document.querySelectorAll('#codex-plus-subagent-portraits, #codex-plus-browser-favorites-style, .codex-plus-browser-favorites, .codex-plus-browser-favorites-dialog').length,
        favoritesSaved: localStorage.getItem("codex-plus.browser-favorites") === window.__savedFavorites,
        statsNodes: document.querySelectorAll('.codex-plus-only-footer, #codex-plus-only-style, #codex-plus-weekly-usage-ring, #codex-plus-weekly-usage-ring-style').length,
        statsAttrs: document.querySelector('#answer').attributes.length,
        answer: document.querySelector('#answer').textContent,
        statsGlobals: ["__CODEX_PLUS_REMOVE__", "__CODEX_PLUS_WEEKLY_USAGE_RING_REFRESH__", "__CODEX_PLUS_HEADROOM_GENERATION_PUSH__", "__CODEX_PLUS_HEADROOM_REQUEST__"].filter(key => Object.hasOwn(window, key)),
        kept: [typeof window.__CODEX_PLUS_MODEL_SHORTCUTS_CLEANUP__, typeof window.__CODEX_PLUS_PENDING_INPUT_CLEANUP__, typeof window.__CODEX_PLUS_MESSAGE_AVATARS_CLEANUP__],
        gc: typeof window.__CODEX_PLUS_RUNTIME_GC__,
        warning: typeof window.__CODEX_PLUS_RUNTIME_GC_WARNING__,
        request: typeof window.__CODEX_PLUS_APP_SERVER_REQUEST__,
        retainedKeys: window.__retiredGcKeys.filter(key => Object.hasOwn(window, key)),
        calls: window.__retiredGcCalls,
        toast: Boolean(document.getElementById("codex-plus-runtime-gc-toast")),
        style: Boolean(document.getElementById("codex-plus-runtime-gc-style")),
      })`,
      returnByValue: true,
    });
    assertNoRuntimeException(result, "daemon injection");
    assert.deepEqual(result.result.value, {
      footer: "undefined", gc: "undefined", warning: "undefined", request: "undefined",
      statsCalls: ["footer", "quota-tps"], statsNodes: 0, statsAttrs: 1, answer: "回答正文", statsGlobals: [],
      kept: ["function", "function", "function"],
      extrasCalls: ["__CODEX_PLUS_STYLE_PERFORMANCE_CLEANUP__", "__CODEX_PLUS_TERMINAL_MEASURE_CLEANUP__", "__CODEX_PLUS_PORTRAITS_CLEANUP__", "__CODEX_PLUS_BROWSER_FAVORITES_CLEANUP__"],
      extrasKeys: [], extrasNodes: 0, favoritesSaved: true,
      retainedKeys: [], calls: [], toast: false, style: false,
    });
    const reloadEnv = { ...process.env, CODEX_PLUS_STATE_DIR: stateDir, CODEX_PLUS_HASH_RULES_FILE: hashRulesPath, CODEX_PLUS_SKIP_APP: "1", CODEX_PLUS_CDP_PORT: String(proxy.port) };
    fs.writeFileSync(hashRulesPath, '# 新规则\n[[rules]]\ntrigger = "#ap"\ntext = "new rules" # 注释\n' );
    await client.send("Runtime.evaluate", { expression: "window.preReloadCleanup = window.__CODEX_PLUS_MODEL_SHORTCUTS_CLEANUP__" });
    const reload = await runCommandAsync(["reload"], { env: reloadEnv });
    assert.equal(reload.status, 0, reload.stderr);
    assert.equal((await client.send("Runtime.evaluate", { expression: "window.preReloadCleanup === window.__CODEX_PLUS_MODEL_SHORTCUTS_CLEANUP__", returnByValue: true })).result.value, true);
    const loadedRules = await client.send("Runtime.evaluate", { expression: "window.__CODEX_PLUS_HASH_RULES__", returnByValue: true });
    assert.deepEqual(loadedRules.result.value, [{ trigger: "#ap", text: "new rules" }]);
    const readRules = async () => (await client!.send("Runtime.evaluate", { expression: "window.__CODEX_PLUS_HASH_RULES__", returnByValue: true })).result.value;
    for (const invalid of ["{", '[[rules]]\ntrigger = "#ap"\ntext = "#ap"\n' ]) {
      fs.writeFileSync(hashRulesPath, invalid);
      const failedReload = await runCommandAsync(["reload"], { env: reloadEnv });
      assert.equal(failedReload.status, 1);
      for (const command of ["start", "restart", "launch"]) {
        const failedStart = await runCommandAsync([command], { env: reloadEnv });
        assert.equal(failedStart.status, 1, command);
        assert.equal(daemon.exitCode, null, command + " must preserve existing daemon");
      }
      assert.deepEqual(await readRules(), [{ trigger: "#ap", text: "new rules" }]);
      assert.equal(daemon.exitCode, null);
    }
    await client.send("Page.enable");
    await client.send("Page.reload");
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.deepEqual(await readRules(), [{ trigger: "#ap", text: "new rules" }]);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const reloaded = await client.send("Runtime.evaluate", {
      expression: `({ stats: document.querySelectorAll('.codex-plus-only-footer, #codex-plus-weekly-usage-ring').length, footer: typeof window.__CODEX_PLUS_PUSH__, quota: typeof window.__CODEX_PLUS_WEEKLY_USAGE_RING_REFRESH__, shortcuts: typeof window.__CODEX_PLUS_MODEL_SHORTCUTS_CLEANUP__, extras: [typeof window.__CODEX_PLUS_STYLE_PERFORMANCE_CLEANUP__, typeof window.__CODEX_PLUS_TERMINAL_MEASURE_CLEANUP__, typeof window.__CODEX_PLUS_PORTRAITS_CLEANUP__, typeof window.__CODEX_PLUS_BROWSER_FAVORITES_CLEANUP__] })`,
      returnByValue: true,
    });
    assertNoRuntimeException(reloaded, "刷新后不恢复已移除组件");
    assert.deepEqual(reloaded.result.value, { stats: 0, footer: "undefined", quota: "undefined", shortcuts: "function", extras: ["undefined", "undefined", "undefined", "undefined"] });
    assert.equal(fs.readFileSync(legacyStateFile, "utf8"), legacyState);
    assert.doesNotMatch(stderr, /运行时 GC|核心 Codex 内存/);
    assert.equal(daemon.exitCode, null, stderr);
    assert.equal(fs.readFileSync(legacyDatabase, "utf8"), "historical usage must remain untouched");
    assert.equal(fs.existsSync(`${legacyDatabase}-wal`), false);
    assert.equal(fs.existsSync(`${legacyDatabase}-shm`), false);
  } finally {
    if (daemon && daemon.exitCode == null) {
      daemon.kill("SIGTERM");
      await Promise.race([daemonExit, new Promise((resolve) => setTimeout(resolve, 3000))]);
      if (daemon.exitCode == null && daemon.signalCode == null) {
        daemon.kill("SIGKILL");
        await daemonExit;
      }
    }
    client?.close();
    await proxy?.close();
    await stopTestBrowser(browser, profile);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("SC-CODEX-PLUS-064: 仅保留升降档，其他快捷键透传且不产生副作用", { timeout: 20_000 }, async (t) => {
  const chrome = findTestBrowser();
  if (!fs.existsSync(chrome)) return t.skip("本机未安装可测试的 Chromium 浏览器");
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "codex-plus-model-and-effort-"));
  const port = await freePort();
  const child = spawn(chrome, [
    "--headless=new",
    "--disable-breakpad",
    "--disable-background-mode",
    "--disable-crash-reporter",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ], { stdio: "ignore" });
  let client;
  try {
    const target = await waitForTargets(port);
    client = new CdpClient(target.webSocketDebuggerUrl);
    await client.connect();
    await client.send("Runtime.enable");
    const setup = await client.send("Runtime.evaluate", {
      expression: `(() => {
        document.body.innerHTML = \`
          <div data-codex-composer-root>
            <div id="draft" data-codex-composer="true" contenteditable="true">保留当前草稿</div>
            <button id="model-trigger" data-codex-intelligence-trigger="true" data-selected-reasoning-effort="medium">
              <span class="_ModelPickerTriggerModelText_test">5.6 Terra</span>
            </button>
          </div>
          <button id="model-chooser" role="menuitem" aria-label="模型 5.6 Terra" hidden>模型 5.6 Terra</button>
          <button id="model-astra" role="menuitem" hidden>6 Astra</button>
          <button id="model-sol" role="menuitem" hidden>6.1 Sol</button>
          <button id="model-terra" role="menuitem" hidden>5.6 Terra</button>
          <button id="model-luna" role="menuitem" hidden>6 Luna</button>
          <button id="effort-medium" role="menuitem" hidden>Medium</button>
          <button id="effort-high" role="menuitem" hidden>High</button>
          <button id="effort-xhigh" role="menuitem" hidden>Extra High</button>
          <button id="effort-max" role="menuitem" hidden>Max</button>
        \`;
        window.__codexPlusModelAndEffortTest = { models: [], efforts: [], events: [] };
        const trigger = document.querySelector("#model-trigger");
        trigger.__reactProps$codexPlusTest = {
          onPointerDown: () => {
            document.querySelector("#model-chooser").hidden = false;
          },
        };
        document.querySelector("#model-chooser").__reactProps$codexPlusTest = {
          onClick: () => {
            for (const item of document.querySelectorAll("[id^='model-']:not(#model-trigger):not(#model-chooser), [id^='effort-']")) {
              item.hidden = false;
            }
          },
        };
        for (const [id, slug, label] of [
          ["model-astra", "gpt-6-astra", "6 Astra"],
          ["model-sol", "gpt-6.1-sol", "6.1 Sol"],
          ["model-terra", "gpt-5.6-terra", "5.6 Terra"],
          ["model-luna", "gpt-6-luna", "6 Luna"],
        ]) {
          const item = document.querySelector("#" + id);
          item.__reactProps$codexPlusTest = {
            onPointerDown: () => {},
            onClick: () => {
              document.querySelector("[class*='ModelPickerTriggerModelText']").textContent = label;
              window.__codexPlusModelAndEffortTest.models.push({ slug, label });
          },
        };
      }
      for (const [id, effort] of [
        ["effort-medium", "medium"], ["effort-high", "high"], ["effort-xhigh", "xhigh"], ["effort-max", "max"],
      ]) {
          const item = document.querySelector("#" + id);
          item.__reactProps$codexPlusTest = {
            onPointerDown: () => {},
            onClick: () => {
              trigger.setAttribute("data-selected-reasoning-effort", effort);
              window.__codexPlusModelAndEffortTest.efforts.push(effort);
            },
          };
        }
      })()`,
    });
    assertNoRuntimeException(setup, "模型与思考强度测试页初始化");
    const shortcuts = await readRendererSource("model-shortcuts");
    await client.send("Runtime.evaluate", { expression: shortcuts });
    // 已删除快捷键必须透传：不消费事件、不切换模型、不改写草稿、不发送消息。
    const removed = await client.send("Runtime.evaluate", {
      expression: `JSON.stringify((() => {
        window.removedShortcutMessages = [];
        window.addEventListener("message", event => removedShortcutMessages.push(event.data));
        const combinations = [
          ...["1", "2", "3", "4"].flatMap(key => [
            {key, code: "Digit" + key, ctrlKey: true},
            {key, code: "Numpad" + key, ctrlKey: true},
          ]),
          {key:"9",code:"Digit9",metaKey:true},
          {key:"9",code:"Numpad9",metaKey:true},
          {key:")",code:"Digit0",metaKey:true,shiftKey:true},
          {key:"0",code:"Numpad0",metaKey:true,shiftKey:true},
          {key:"k",code:"KeyK",metaKey:true,shiftKey:true},
          {key:"i",code:"KeyI",metaKey:true},
          {key:"+",code:"Equal",ctrlKey:true,shiftKey:true},
          {key:"+",code:"NumpadAdd",ctrlKey:true},
          {key:"Enter"}, {key:" "},
          ...["ArrowLeft","ArrowRight","ArrowUp","ArrowDown"].map(key=>({key})),
        ];
        let received = 0;
        const nativeListener = () => received++;
        document.addEventListener("keydown", nativeListener);
        const prevented = combinations.map(options => {
          const event = new KeyboardEvent("keydown", {...options,bubbles:true,cancelable:true});
          document.querySelector("#draft").dispatchEvent(event);
          return event.defaultPrevented;
        });
        document.removeEventListener("keydown", nativeListener);
        return {prevented, received};
      })())`, returnByValue: true,
    });
    const removedState = JSON.parse(removed.result.value);
    assert.deepEqual(removedState.prevented, Array(22).fill(false));
    assert.equal(removedState.received, 22);
    await new Promise(resolve => setTimeout(resolve, 220));
    const unchanged = await client.send("Runtime.evaluate", {
      expression: `JSON.stringify({models:__codexPlusModelAndEffortTest.models,efforts:__codexPlusModelAndEffortTest.efforts,draft:document.querySelector("#draft").textContent,messages:removedShortcutMessages})`,
      returnByValue: true,
    });
    assert.deepEqual(JSON.parse(unchanged.result.value), {models:[],efforts:[],draft:"保留当前草稿",messages:[]});
    await client.send("Runtime.evaluate", {
      expression: `document.querySelector("[class*='ModelPickerTriggerModelText']").textContent="6 Luna"; document.querySelector("#model-trigger").setAttribute("data-selected-reasoning-effort","max");`,
    });
    for (const [key, code, expected] of [
      ["=", "Equal", "6.1 Sol"], ["=", "Equal", "6 Astra"], ["=", "Equal", "6 Luna"],
      ["-", "Minus", "6 Astra"], ["-", "Minus", "6.1 Sol"], ["-", "Minus", "6 Luna"],
    ]) {
      await client.send("Runtime.evaluate", {
        expression: `document.dispatchEvent(new KeyboardEvent("keydown", {
          key: ${JSON.stringify(key)}, code: ${JSON.stringify(code)}, ctrlKey: true, bubbles: true, cancelable: true,
        }))`,
      });
      await new Promise((resolve) => setTimeout(resolve, 220));
      const state = await client.send("Runtime.evaluate", {
        expression: `JSON.stringify({
          model: document.querySelector("[class*='ModelPickerTriggerModelText']").textContent,
          effort: document.querySelector("#model-trigger").getAttribute("data-selected-reasoning-effort"),
          efforts: window.__codexPlusModelAndEffortTest.efforts,
          draft: document.querySelector("#draft").textContent,
        })`, returnByValue: true,
      });
      assert.deepEqual(JSON.parse(state.result.value), {
        model: expected, effort: "max", efforts: [], draft: "保留当前草稿",
      });
    }
    // A real native click invalidates the shortcut label cache before switching from an older model.
    for (const [key, expected] of [["=", "6 Astra"], ["-", "6 Luna"]]) {
      await client.send("Runtime.evaluate", {
        expression: `(() => {
          document.querySelector("#model-terra").textContent = "GPT-5.6 Terra";
          document.querySelector("#model-terra").dispatchEvent(new MouseEvent("click", { bubbles: true }));
          document.querySelector("[class*='ModelPickerTriggerModelText']").textContent = "5.6 Terra";
          document.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(key)}, ctrlKey: true, bubbles: true, cancelable: true }));
        })()`,
      });
      await new Promise((resolve) => setTimeout(resolve, 220));
      const state = await client.send("Runtime.evaluate", {
        expression: `document.querySelector("[class*='ModelPickerTriggerModelText']").textContent`, returnByValue: true,
      });
      assert.equal(state.result.value, expected);
    }
    const ignored = await client.send("Runtime.evaluate", {
      expression: `JSON.stringify([
        { ctrlKey: false }, { altKey: true }, { metaKey: true }, { shiftKey: true },
        { repeat: true }, { isComposing: true },
      ].map((extra) => {
        const event = new KeyboardEvent("keydown", { key: "-", code: "Minus", ctrlKey: true, bubbles: true, cancelable: true, ...extra });
        document.dispatchEvent(event);
        return event.defaultPrevented;
      }))`, returnByValue: true,
    });
    assert.deepEqual(JSON.parse(ignored.result.value), [false, false, false, false, false, false]);
  } finally {
    await client?.close();
    await stopTestBrowser(child, profile);
    removeTestProfile(profile);
  }
});

// 打包按包目录解析依赖，所以副本同时带上 package.json 与 node_modules。
function stageSourceCopy() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codex-plus-bundle-"));
  fs.cpSync(SOURCE_DIR, path.join(temporary, "src"), { recursive: true });
  fs.copyFileSync(path.join(PACKAGE_ROOT, "package.json"), path.join(temporary, "package.json"));
  fs.symlinkSync(path.join(PACKAGE_ROOT, "node_modules"), path.join(temporary, "node_modules"));
  return temporary;
}

// update 只依赖插件目录本身：副本里补齐启动器、手册源与示例规则即可独立发布。
function stagePackageCopy() {
  const temporary = stageSourceCopy();
  const files = [
    path.join("bin", "codex+"), path.join("docs", "codex+.1"), "hash-rules.example.toml",
    path.join("claude", ".claude-plugin"), path.join("claude", "hooks", "hooks.json"),
  ];
  for (const file of files) fs.cpSync(path.join(PACKAGE_ROOT, file), path.join(temporary, file), { recursive: true });
  return fs.realpathSync(temporary);
}

test("SC-CODEX-PLUS-011: macOS update 只发布当前 Codex+ 文件并退役 install 命令", () => {
  const packageCopy = stagePackageCopy();
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codex-plus-update-"));
  try {
    const prefix = path.join(temporary, "prefix");
    const main = path.join(packageCopy, "src", "hosts", "codex-desktop", "main.ts");
    const env = { ...process.env, CODEX_PLUS_INSTALL_PREFIX: prefix, CODEX_PLUS_SKIP_APP: "1" };
    const run = (args: string[]) => spawnSync(process.execPath, [main, ...args], { cwd: temporary, encoding: "utf8", env });
    const result = run(["update"]);
    assert.equal(result.status, 0, result.stderr);
    // update 必须先打包再更新链接，否则源码改动不经发布就会立即生效。
    const packaged = path.join(packageCopy, "bin", "codex+.mjs");
    assert.match(result.stdout, /^已打包命令: .+（源码指纹 [0-9a-f]{12}）$/m);
    assert.match(result.stdout, /^已安装命令: /m);
    assert.equal(fs.existsSync(packaged), true);
    assert.equal(fs.readFileSync(packaged, "utf8").startsWith("#!/usr/bin/env node\n"), true);
    assert.equal((fs.statSync(packaged).mode & 0o111) !== 0, true);
    const claudeHooks = path.join(packageCopy, "claude", "hooks", "hash-rules.mjs");
    assert.match(result.stdout, /^已打包 Claude Code 插件: /m);
    assert.doesNotMatch(fs.readFileSync(claudeHooks, "utf8"), /^\s*import\s/m);
    const installedCommand = path.join(prefix, "bin", "codex+");
    assert.equal(fs.lstatSync(installedCommand).isSymbolicLink(), true);
    assert.equal(fs.readlinkSync(installedCommand), path.join(packageCopy, "bin", "codex+"));
    assert.equal(fs.existsSync(path.join(prefix, "share", "man", "man1", "codex+.1")), true);
    assert.equal(fs.existsSync(path.join(prefix, "lib")), false);
    assert.equal(fs.existsSync(path.join(prefix, "bin", "codex+.cmd")), false);
    const selfTest = spawnSync(installedCommand, ["--self-test"], { encoding: "utf8" });
    assert.equal(selfTest.status, 0, selfTest.stderr);
    assert.match(selfTest.stdout, /SC-CODEX-PLUS-SELF: PASS/);

    // 首次 update 从示例生成用户规则；之后再次 update 不覆盖用户的修改。
    const rules = path.join(packageCopy, "hash-rules.toml");
    assert.match(result.stdout, /^已从示例生成缩写规则: /m);
    assert.equal(fs.readFileSync(rules, "utf8"), fs.readFileSync(path.join(packageCopy, "hash-rules.example.toml"), "utf8"));
    const customRules = '[[rules]]\ntrigger = "#mine"\ntext = "自己的规则"\n';
    fs.writeFileSync(rules, customRules);
    const again = run(["update"]);
    assert.equal(again.status, 0, again.stderr);
    assert.doesNotMatch(again.stdout, /已从示例生成缩写规则/);
    assert.equal(fs.readFileSync(rules, "utf8"), customRules);

    const retired = run(["install"]);
    assert.equal(retired.status, 1);
    assert.match(retired.stderr, /未知命令：install/);
    const manual = run(["--man"]);
    assert.equal(manual.status, 0, manual.stderr);
    assert.match(manual.stdout, /codex\+ update/);
    assert.doesNotMatch(manual.stdout, /codex\+ install|^\s+install\s+/m);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
    fs.rmSync(packageCopy, { recursive: true, force: true });
  }
});

test("SC-CODEX-PLUS-011: 打包产物自包含且对同一份源码确定性", async () => {
  const temporary = stageSourceCopy();
  try {
    const first = await buildBundle(temporary);
    const second = await buildBundle(temporary);
    assert.equal(first.revision, second.revision);
    assert.equal(first.source, second.source);
    assert.match(first.revision, /^[0-9a-f]{12}$/);

    // 注入脚本必须内联，产物运行时不得再依赖 src。
    const inlined = JSON.parse(/globalThis\.__CODEX_PLUS_BUNDLE__ = (\{.*\});/.exec(first.source)![1]);
    assert.deepEqual(
      Object.keys(inlined.renderers).sort(),
      ["hash-highlights", "message-avatars", "model-shortcuts", "pending-input", "project-branches", "reasoning-prefix"],
    );
    assert.equal(Object.hasOwn(inlined, "pricing"), false);

    // 入口 guard 用 path.resolve 比较 argv[1] 与 import.meta.url，后者已 realpath，
    // 所以这里必须传真实路径，否则 main() 不会执行。
    const isolated = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codex-plus-isolated-")));
    try {
      const artifact = path.join(isolated, "codex+.mjs");
      fs.writeFileSync(artifact, first.source, { mode: 0o755 });
      const selfTest = spawnSync(process.execPath, [artifact, "--self-test"], { encoding: "utf8" });
      assert.equal(selfTest.status, 0, selfTest.stderr);
      assert.match(selfTest.stdout, /SC-CODEX-PLUS-SELF: PASS/);
      const offlineGc = spawnSync(process.execPath, [artifact, "gc", "--dry-run"], {
        encoding: "utf8",
        env: { ...process.env, CODEX_PLUS_STATE_DIR: isolated, CODEX_PLUS_CDP_PORT: String(await freePort()) },
      });
      assert.equal(offlineGc.status, 1);
      assert.match(offlineGc.stderr, /gc 需要 Codex\+ 模式/);
      const manual = spawnSync(process.execPath, [artifact, "--man"], { encoding: "utf8" });
      assert.equal(manual.status, 0, manual.stderr);
      assert.match(manual.stdout, /codex\+ gc --dry-run/);
      assert.doesNotMatch(manual.stdout, /CODEX_PLUS_RUNTIME_GC|CODEX_PLUS_MEMORY_WARN/);
      // 隔离目录里没有 codex+ 的 package.json，update 必须明确失败而不是静默发布到错误位置。
      const orphanUpdate = spawnSync(process.execPath, [artifact, "update"], { encoding: "utf8" });
      assert.equal(orphanUpdate.status, 1);
      assert.match(orphanUpdate.stderr, /无法定位 codex\+ 根目录/);
    } finally {
      fs.rmSync(isolated, { recursive: true, force: true });
    }

    // 源码改动只有重新打包才会进入产物，且指纹随之变化。
    fs.appendFileSync(path.join(temporary, "src", "hosts", "codex-desktop", "page", "features", "pending-input.ts"), "\nconsole.debug(\"变更标记\");\n");
    const third = await buildBundle(temporary);
    assert.notEqual(third.revision, first.revision);
    assert.equal(third.source.includes("变更标记"), true);
    assert.equal(first.source.includes("变更标记"), false);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("SC-CODEX-PLUS-011: 打包在模块无法解析时失败，不产出可疑产物", async () => {
  const temporary = stageSourceCopy();
  try {
    const target = path.join(temporary, "src", "hosts", "codex-desktop", "main.ts");
    fs.appendFileSync(target, '\nimport { missing } from "./missing.ts";\nvoid missing;\n');
    await assert.rejects(() => buildBundle(temporary), /Could not resolve "\.\/missing\.ts"/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

interface Keybinding {
  command: string;
  key: string | null;
  when?: string;
}

test("SC-CODEX-PLUS-050: 恢复旧版禁用项且保留用户改键，不再禁用原生快捷键", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codex-plus-keybindings-"));
  try {
    const codexHome = path.join(temporary, "codex-home");
    const stateDir = path.join(temporary, "state");
    const keybindingsFile = path.join(codexHome, "keybindings.json");
    const stateFile = path.join(stateDir, "shortcut-keybindings.json");
    const env = {
      ...process.env,
      CODEX_PLUS_CODEX_HOME: codexHome,
      CODEX_PLUS_STATE_DIR: stateDir,
    };
    const original = [
      { command: "thread1", key: "CmdOrCtrl+1", when: "editorFocus" },
      { command: "thread2", key: null },
      { command: "thread9", key: "CmdOrCtrl+9" },
      { command: "switchToMode1", key: "Ctrl+1" },
      { command: "openFolder", key: "Command+O" },
    ];
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(keybindingsFile, `${JSON.stringify(original, null, 2)}\n`);

    // 从真实旧版本遗留格式恢复；新版本不再创建任何禁用项。
    const legacyApplied = [...original.filter(binding => !["thread9","switchToMode1"].includes(binding.command)),
      ...["thread9","switchToMode1","switchToMode2","switchToMode3","thread4","switchToMode4"].map(command=>({command,key:null}))];
    fs.mkdirSync(stateDir,{recursive:true});
    fs.writeFileSync(keybindingsFile,JSON.stringify(legacyApplied));
    fs.writeFileSync(stateFile,JSON.stringify({schema_version:1,original_file_existed:true,original_bindings:original,applied_bindings:legacyApplied}));
    const edited = JSON.parse(fs.readFileSync(keybindingsFile, "utf8"))
      .filter((binding: Keybinding) => binding.command !== "switchToMode3")
      .map((binding: Keybinding) => {
        if (binding.command === "thread1") return { command: "thread1", key: "Command+7" };
        if (binding.command === "openFolder") return { command: "openFolder", key: "Command+Shift+O" };
        return binding;
      });
    fs.writeFileSync(keybindingsFile, `${JSON.stringify(edited, null, 2)}\n`);
    const stopped = runCommand(["stop"], { encoding: "utf8", env: { ...env, CODEX_PLUS_SKIP_APP: "1" } });
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.match(stopped.stdout, /switchToMode3/);
    const restored: Keybinding[] = JSON.parse(fs.readFileSync(keybindingsFile, "utf8"));
    assert.deepEqual(restored.filter((binding) => binding.command === "thread1"), [
      { command: "thread1", key: "Command+7" },
    ]);
    assert.deepEqual(restored.filter((binding) => binding.command === "thread2"), [
      { command: "thread2", key: null },
    ], "原值本来为 null 时必须保留");
    assert.equal(restored.some((binding) => binding.command === "thread3"), false, "原值缺失时移除注入项");
    assert.equal(restored.some((binding) => binding.command === "thread4"), false, "旧版 Cmd+4 注入项应恢复");
    assert.deepEqual(restored.filter((binding) => binding.command === "thread9"), [original[2]]);
    assert.deepEqual(restored.filter((binding) => binding.command === "switchToMode1"), [original[3]]);
    assert.equal(restored.some((binding) => binding.command === "switchToMode2"), false);
    assert.equal(restored.some((binding) => binding.command === "switchToMode3"), false);
    assert.equal(restored.some((binding) => binding.command === "switchToMode4"), false, "旧版 Ctrl+4 注入项应恢复");
    assert.deepEqual(restored.find((binding) => binding.command === "openFolder"), {
      command: "openFolder", key: "Command+Shift+O",
    });
    assert.equal(fs.existsSync(stateFile), false);

    fs.rmSync(keybindingsFile);
    assert.equal(restoreKeybindings(env).status, 0);
    assert.equal(fs.existsSync(keybindingsFile), false, "无旧备份时不应创建键位文件");
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("SC-CODEX-PLUS-040: update 不读取或改写 Codex 模型配置", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codex-plus-config-"));
  try {
    const prefix = path.join(temporary, "system");
    const codexHome = path.join(temporary, "codex-home");
    const configPath = path.join(codexHome, "config.toml");
    const config = 'model = "gpt-5.6-terra"\nmodel_catalog_json = "/custom/models.json"\n';
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(configPath, config);
    const result = runCommand(["update"], {
      cwd: PACKAGE_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        CODEX_PLUS_INSTALL_PREFIX: prefix,
        CODEX_PLUS_SKIP_APP: "1",
        CODEX_PLUS_CODEX_HOME: codexHome,
        CODEX_PLUS_CONFIG_PATH: configPath,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(configPath, "utf8"), config);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("已删除 usage 指令，旧统计环境变量不创建或改写数据库", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-plus-without-usage-"));
  try {
    const database = path.join(root, "usage.sqlite");
    const result = runCommand(["usage"], {
      encoding: "utf8",
      env: { ...process.env, CODEX_PLUS_STATE_DIR: root, CODEX_PLUS_USAGE_DB_PATH: database },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /未知命令：usage/);
    assert.equal(fs.existsSync(database), false);
    const manual = runCommand(["--man"], { encoding: "utf8" });
    assert.equal(manual.status, 0, manual.stderr);
    assert.doesNotMatch(manual.stdout, /codex\+ usage|CODEX_PLUS_USAGE_DB_PATH|CODEX_PLUS_SESSION_ROOT|usage\.sqlite/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
