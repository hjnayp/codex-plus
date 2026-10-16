import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";

interface StartResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

const MAIN = process.env.CODEX_PLUS_STARTUP_TEST_MAIN
  || fileURLToPath(new URL("../src/hosts/codex-desktop/main.ts", import.meta.url));

async function freePort() {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function fixture({ ready = true, codexStatus = "pass", warnOnce = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-plus-headroom-start-"));
  const marker = path.join(root, "commands");
  const command = path.join(root, "headroom");
  fs.writeFileSync(command, `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(marker)}, args.join(" ") + "\\n");
if (args[0] === "doctor") {
  const count = ${JSON.stringify(path.join(root, "doctor-count"))};
  const first = !fs.existsSync(count);
  fs.writeFileSync(count, "called");
  console.log(JSON.stringify({ exit_code: 1, checks: [
    { name: "proxy", status: "pass" }, { name: "readiness", status: "pass" },
    { name: "codex", status: ${warnOnce} && first ? "warn" : ${JSON.stringify(codexStatus)}, summary: "Codex routing result" },
    { name: "claude", status: "warn", summary: "not configured" }
  ] }));
  process.exit(1);
} else { process.exit(99); }
`, { mode: 0o755 });
  let healthRequests = 0;
  const server = http.createServer((request, response) => {
    healthRequests++;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ready }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const env: NodeJS.ProcessEnv & { CODEX_HOME: string } = {
    ...process.env,
    CODEX_PLUS_STATE_DIR: root,
    CODEX_HOME: path.join(root, "codex-home"),
    CODEX_PLUS_SKIP_HEADROOM: "0",
    CODEX_PLUS_SKIP_APP: "1",
    CODEX_PLUS_CHATGPT_APP: path.join(root, "missing-app"),
    CODEX_PLUS_CDP_PORT: String(await freePort()),
    CODEX_PLUS_HEADROOM_COMMAND: command,
    CODEX_PLUS_HEADROOM_HEALTH_URL: `http://127.0.0.1:${port}/health`,
    CODEX_PLUS_HEADROOM_TIMEOUT_MS: "1000",
    CODEX_PLUS_STARTUP_TIMEOUT_MS: "1000",
  };
  return {
    root, marker, port, env,
    healthRequests: () => healthRequests,
    commands: () => fs.existsSync(marker) ? fs.readFileSync(marker, "utf8").trim().split("\n") : [],
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function start(env: NodeJS.ProcessEnv, action = "start", isolateApp = false) {
  return new Promise<StartResult>((resolve, reject) => {
    const wrapper = `
      const fs = await import("node:fs");
      const cp = (await import("node:child_process")).default;
      const { promisify } = await import("node:util");
      const { syncBuiltinESMExports } = await import("node:module");
      const originalExec = promisify(cp.execFile);
      const originalSpawn = cp.spawn;
      const quit = process.env.CODEX_PLUS_STATE_DIR + "/app-quit";
      const events = process.env.CODEX_PLUS_STATE_DIR + "/app-events";
      const mockedExec = (...args) => cp.execFileOriginal(...args);
      cp.execFileOriginal = cp.execFile;
      mockedExec[promisify.custom] = async (file, args, options) => {
        if (file === "osascript") {
          if (args.join(" ").includes("to quit")) {
            fs.writeFileSync(quit, "quit");
            fs.appendFileSync(events, "quit\\n");
          }
          return { stdout: fs.existsSync(quit) || process.env.TEST_CODEX_RUNNING === "0" ? "false" : "true", stderr: "" };
        }
        if (file === "/usr/bin/pgrep") throw Object.assign(new Error("not running"), { code: 1 });
        return originalExec(file, args, options);
      };
      cp.execFile = mockedExec;
      cp.spawn = (file, args, options) => {
        if (args[1] === "daemon") {
          fs.appendFileSync(events, "launch\\n");
          fs.writeFileSync(process.env.CODEX_PLUS_STATE_DIR + "/ready.json",
            JSON.stringify({ pid: process.pid, cdp_ready: true }));
          return { pid: process.pid, unref() {} };
        }
        return originalSpawn(file, args, options);
      };
      syncBuiltinESMExports();
      process.argv = [process.execPath, ${JSON.stringify(MAIN)}, ${JSON.stringify(action)}];
      await import(${JSON.stringify(pathToFileURL(MAIN).href)});
    `;
    const args = isolateApp ? ["--input-type=module", "-e", wrapper] : [MAIN, action];
    const child = spawn(process.execPath, args, { env });
    let stdout = "", stderr = "";
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    child.on("error", reject);
    child.on("exit", (status) => resolve({ status, stdout, stderr }));
  });
}

// SC-CODEX-PLUS-065：start 与 Headroom 状态及配置无关，绝不退出已有 Codex。
for (const ready of [false, true]) {
  test(`Headroom ready=${ready} 且路由诊断异常时，start 仍直接启动，不调用检查或退出 Codex`, async () => {
    const f = await fixture({ ready, codexStatus: "warn" });
    try {
      f.env.CODEX_PLUS_SKIP_APP = "0";
      f.env.TEST_CODEX_RUNNING = "0";
      const result = await start(f.env, "start", true);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /已启动/);
      assert.equal(f.healthRequests(), 0);
      assert.deepEqual(f.commands(), []);
      assert.equal(fs.readFileSync(path.join(f.root, "app-events"), "utf8"), "launch\n");
    } finally { await f.close(); }
  });
}

for (const snapshot of [undefined, "old-config-hash"]) {
  test(`已有增强实例快照 ${snapshot ?? "缺失"} 时，配置变化和 Headroom 异常均不触发重启`, async () => {
    const f = await fixture({ ready: false, codexStatus: "warn" });
    const daemon = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const daemonExited = new Promise((resolve) => daemon.once("exit", resolve));
    const cdp = http.createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      response.end("[]");
    });
    await new Promise<void>((resolve) => cdp.listen(0, "127.0.0.1", resolve));
    try {
      f.env.CODEX_PLUS_SKIP_APP = "0";
      f.env.CODEX_PLUS_CDP_PORT = String((cdp.address() as AddressInfo).port);
      fs.mkdirSync(f.env.CODEX_HOME, { recursive: true });
      const configPath = path.join(f.env.CODEX_HOME, "config.toml");
      fs.writeFileSync(configPath, 'model_provider = "changed"\n');
      fs.writeFileSync(path.join(f.root, "daemon.pid"), `${daemon.pid}\n`);
      const readyRecord = JSON.stringify({ pid: daemon.pid, cdp_ready: true, headroom_config_hash: snapshot });
      fs.writeFileSync(path.join(f.root, "ready.json"), readyRecord);
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await start(f.env, "start", true);
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /已运行/);
      }
      assert.equal(daemon.exitCode, null);
      assert.equal(fs.readFileSync(path.join(f.root, "daemon.pid"), "utf8"), `${daemon.pid}\n`);
      assert.equal(f.healthRequests(), 0);
      assert.deepEqual(f.commands(), []);
      assert.equal(fs.existsSync(path.join(f.root, "app-events")), false);
      assert.equal(fs.readFileSync(path.join(f.root, "ready.json"), "utf8"), readyRecord);
      assert.equal(fs.readFileSync(configPath, "utf8"), 'model_provider = "changed"\n');
    } finally {
      daemon.kill("SIGTERM");
      await daemonExited;
      cdp.closeAllConnections();
      await new Promise((resolve) => cdp.close(resolve));
      await f.close();
    }
  });
}

test("普通模式 Codex 已运行时，start 提示 restart，但不自行退出或启动应用", async () => {
  const f = await fixture({ ready: false });
  try {
    f.env.CODEX_PLUS_SKIP_APP = "0";
    const result = await start(f.env, "start", true);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /普通模式.*restart/);
    assert.equal(fs.existsSync(path.join(f.root, "app-events")), false);
    assert.equal(f.healthRequests(), 0);
    assert.deepEqual(f.commands(), []);
  } finally { await f.close(); }
});

test("实际 daemon 就绪后不读取或记录 Headroom 配置摘要", async () => {
  const f = await fixture();
  const server = http.createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify([{
      id: "isolated-codex", type: "page", url: "app://-/index.html",
      webSocketDebuggerUrl: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/page`,
    }]));
  });
  const sockets = new WebSocketServer({ server });
  sockets.on("connection", (socket) => socket.on("message", (data) => {
    const message = JSON.parse(data.toString());
    const result = message.method === "Page.addScriptToEvaluateOnNewDocument"
      ? { identifier: "isolated-injection" }
      : message.method === "Runtime.evaluate" ? { result: { type: "boolean", value: true } } : {};
    socket.send(JSON.stringify({ id: message.id, result }));
  }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  fs.mkdirSync(f.env.CODEX_HOME, { recursive: true });
  fs.mkdirSync(path.join(f.env.CODEX_HOME, "config.toml"));
  const sessions = path.join(f.root, "sessions");
  fs.mkdirSync(sessions);
  const daemon = spawn(process.execPath, [MAIN, "daemon"], {
    env: {
      ...f.env,
      CODEX_PLUS_CDP_PORT: String((server.address() as AddressInfo).port),
      CODEX_PLUS_SESSION_ROOT: sessions,
      CODEX_PLUS_USAGE_DB_PATH: path.join(f.root, "usage.sqlite"),
      CODEX_PLUS_STARTUP_TIMEOUT_MS: "5000",
    },
    stdio: "ignore",
  });
  const exited = new Promise((resolve) => daemon.once("exit", resolve));
  try {
    const readyPath = path.join(f.root, "ready.json");
    const deadline = Date.now() + 7000;
    while (!fs.existsSync(readyPath) && daemon.exitCode === null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(fs.existsSync(readyPath), "生产 daemon 应在受控 CDP 就绪后写入 ready.json");
    const ready = JSON.parse(fs.readFileSync(readyPath, "utf8"));
    assert.equal(ready.pid, daemon.pid);
    assert.equal(ready.cdp_ready, true);
    assert.equal(Object.hasOwn(ready, "headroom_config_hash"), false);
    assert.equal(f.healthRequests(), 0);
    assert.deepEqual(f.commands(), []);
  } finally {
    daemon.kill("SIGTERM");
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
    if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill("SIGKILL");
    for (const socket of sockets.clients) socket.terminate();
    await new Promise((resolve) => sockets.close(resolve));
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await f.close();
  }
});
