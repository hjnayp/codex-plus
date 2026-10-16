import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { hashRulesFile } from "../config.ts";
import { processStopped } from "../daemon/state.ts";
import { loadRenderers } from "../renderers.ts";
import { processAlive, readJson, sleep, writeJsonAtomic } from "../system.ts";
import type { CommandContext } from "./context.ts";
import { formatLoadedThreads, listLoadedThreads } from "./threads.ts";

const RELOAD_TIMEOUT_MS = 10000;

// 入口守卫保证命令只在 argv[1] 指向入口文件时执行，所以它就是源码入口或打包产物本身。
function entryFile(): string {
  return path.resolve(process.argv[1]);
}

export async function startCommand(context: CommandContext): Promise<void> {
  const { config, cdp, app, daemon, keybindings } = context;
  await loadRenderers(hashRulesFile(config));
  await fs.promises.mkdir(config.stateDir, { recursive: true });
  try {
    const existingPid = await daemon.pid();
    if (processAlive(existingPid)) {
      if (await cdp.ready()) {
        console.log(`${config.commandName} 已运行（PID ${existingPid}）`);
        return;
      }
      await stopCommand(context, [], { quiet: true });
    }
    if (await app.running() && !(await cdp.ready())) {
      throw new Error(`官方 Codex 已以普通模式运行；请执行 \`${config.commandName} restart\` 切换到 增强模式`);
    }
    await cdp.ensureAvailablePort();
    if (await keybindings.hasBackup()) await keybindings.restore({ quiet: true });

    await daemon.resetStartup();
    const log = await fs.promises.open(config.stateFiles.log, "a");
    const child = spawn(process.execPath, [entryFile(), "daemon"], {
      detached: true,
      env: { ...process.env, CODEX_PLUS_CDP_PORT: String(cdp.port) },
      stdio: ["ignore", log.fd, log.fd],
    });
    child.unref();
    await log.close();

    const deadline = Date.now() + config.startupTimeoutMs;
    while (Date.now() < deadline) {
      const ready = await daemon.ready();
      if (ready?.pid === child.pid && ready?.cdp_ready) {
        console.log(`Codex+ 已启动（PID ${child.pid}，CDP 127.0.0.1:${cdp.port}）`);
        return;
      }
      if (!processAlive(child.pid as number)) break;
      await sleep(250);
    }
    throw new Error(`Codex+ 启动失败，请查看 ${config.stateFiles.log}`);
  } catch (error) {
    await keybindings.restore({ quiet: true });
    throw error;
  }
}

// 先请求守护进程协作清理，超时后强制停止；确认进程退出后才清理状态文件。
export async function stopCommand({ config, daemon, keybindings }: CommandContext, _args: string[] = [], { quiet = false } = {}): Promise<void> {
  const pid = await daemon.pid();
  const running = processAlive(pid);
  if (running) {
    const identity = await daemon.identity();
    await daemon.requestStop({ pid, instance_id: identity.instance_id });
    process.kill(pid, "SIGTERM");
    const deadline = Date.now() + config.stopTimeoutMs;
    while (Date.now() < deadline && !(await processStopped(pid))) await sleep(100);
    if (!(await processStopped(pid))) {
      process.kill(pid, "SIGKILL");
      const forceDeadline = Date.now() + config.forceStopTimeoutMs;
      while (Date.now() < forceDeadline && !(await processStopped(pid))) await sleep(50);
    }
    if (!(await processStopped(pid))) throw new Error(`守护进程 ${pid} 未能退出`);
  }
  await daemon.clear();
  await keybindings.restore({ quiet });
  if (!quiet) console.log(running ? `${config.commandName} 已停止；官方 Codex 保持运行` : `${config.commandName} 未运行`);
}

export async function restartCommand(context: CommandContext): Promise<void> {
  await loadRenderers(hashRulesFile(context.config));
  await stopCommand(context, [], { quiet: true });
  await context.app.quit();
  await startCommand(context);
}

export async function launchCommand(context: CommandContext): Promise<void> {
  const pid = await context.daemon.pid();
  if (processAlive(pid) && (await context.cdp.ready())) {
    await startCommand(context);
    await context.app.activate();
    return;
  }
  if (await context.app.running()) return restartCommand(context);
  return startCommand(context);
}

export async function statusCommand({ config, cdp, app, daemon }: CommandContext): Promise<void> {
  const pid = await daemon.pid();
  const ready = await daemon.ready();
  const targets = await cdp.targets().catch(() => []);
  const daemonRunning = processAlive(pid);
  const codexRunning = await app.running();
  console.log(`守护进程: ${daemonRunning ? (targets.length ? `运行中（PID ${pid}）` : `异常（PID ${pid}，CDP 已失联）`) : "未运行"}`);
  console.log(`官方 Codex: ${codexRunning ? "运行中" : "未运行"}`);
  console.log(`本地 CDP: ${targets.length ? `就绪（${targets.length} 个页面）` : "未就绪"}（127.0.0.1:${cdp.port}）`);
  if (codexRunning && !targets.length) {
    console.log(`注入状态: 未启用；界面增强与模型快捷键不可用，请执行 \`${config.commandName} restart\``);
  }
  if (ready?.started_at) console.log(`启动时间: ${ready.started_at}`);
  console.log(`日志: ${config.stateFiles.log}`);
  if (targets.length) {
    try {
      console.log(formatLoadedThreads(await listLoadedThreads(targets), config));
    } catch (error) {
      console.log(`已加载对话: 读取失败（${(error as Error).message}）`);
    }
  }
}

// 先在本进程校验规则，再请求守护进程推送；守护进程失败时保留旧规则并回报原因。
export async function reloadCommand({ config, daemon }: CommandContext): Promise<void> {
  const rulesPath = (await daemon.ready())?.hash_rules_file || hashRulesFile(config);
  await loadRenderers(rulesPath);
  const identity = await daemon.identity();
  if (!processAlive(identity.pid)) throw new Error("codex+ 守护进程未运行，请先 start");
  const id = randomUUID();
  await writeJsonAtomic(config.stateFiles.reloadRequest, { id, instance_id: identity.instance_id });
  const deadline = Date.now() + RELOAD_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await readJson(config.stateFiles.reloadResult);
    if (result?.id === id) {
      if (result.error) throw new Error(result.error);
      console.log(`已重新加载规则：${rulesPath}`);
      return;
    }
    await sleep(100);
  }
  throw new Error("等待规则重新加载超时");
}
