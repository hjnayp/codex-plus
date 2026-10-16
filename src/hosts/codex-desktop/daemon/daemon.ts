import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type { CdpClient } from "../cdp.ts";
import type { CommandContext } from "../commands/context.ts";
import { formatGcReport, reclaimIdleThreads } from "../commands/threads.ts";
import { hashRulesFile } from "../config.ts";
import { attachRenderers, loadRenderers, reinjectRenderers } from "../renderers.ts";
import type { Renderers } from "../renderers.ts";
import { processAlive, readJson, sleep, writeJsonAtomic } from "../system.ts";

// 守护进程就绪后按此周期自动执行一次 gc -t AUTO_GC_IDLE_MINUTES。
const AUTO_GC_INTERVAL_MS = 30 * 60000;
const AUTO_GC_IDLE_MINUTES = 30;
const POLL_INTERVAL_MS = 500;
const CDP_LOST_TIMEOUT_MS = 15000;

/// 常驻进程：维持每个 Codex 页面的注入、处理规则重新加载与定时回收，退出时撤销注入并清理状态。
class Daemon {
  readonly #context: CommandContext;
  readonly #instanceId = randomUUID();
  readonly #clients = new Map<string, CdpClient>();
  readonly #logPrefix: string;
  #renderers: Renderers;
  #stopRequested = false;
  #cleanupPromise: Promise<void> | null = null;
  #autoGcTimer: NodeJS.Timeout | undefined;
  #autoGcRunning = false;
  #lastReloadId: string | null = null;

  constructor(context: CommandContext, renderers: Renderers) {
    this.#context = context;
    this.#renderers = renderers;
    this.#logPrefix = `[${context.config.commandName}]`;
  }

  get instanceId(): string {
    return this.#instanceId;
  }

  async run(): Promise<void> {
    const { config, cdp, app, daemon } = this.#context;
    process.once("SIGTERM", () => this.#requestStop());
    process.once("SIGINT", () => this.#requestStop());
    try {
      if (!(await cdp.ready())) {
        if (await app.running()) throw new Error("Codex 已运行但 CDP 未开放；守护进程拒绝静默注入或重启正文窗口");
        await app.launchWithCdp(cdp.port);
      }
      if (!(await this.#waitForFirstPage())) return;
      await app.activate();
      await daemon.markReady({
        pid: process.pid,
        hash_rules_file: hashRulesFile(config),
        cdp_ready: true,
        port: cdp.port,
        instance_id: this.#instanceId,
        started_at: new Date().toISOString(),
      });
      this.#autoGcTimer = setInterval(() => void this.#runAutoGc(), AUTO_GC_INTERVAL_MS);

      let cdpMissingSince = 0;
      while (!this.#stopRequested) {
        if (await daemon.stopRequested(process.pid, this.#instanceId)) break;
        if (await this.#refreshClients()) {
          cdpMissingSince = 0;
        } else if (!cdpMissingSince) {
          cdpMissingSince = Date.now();
        } else if (Date.now() - cdpMissingSince > CDP_LOST_TIMEOUT_MS) {
          console.error(`${this.#logPrefix} Codex CDP 已失联超过 15 秒，守护进程停止并清理失效状态`);
          break;
        }
        await this.#reloadRules();
        await sleep(POLL_INTERVAL_MS);
      }
    } finally {
      await this.#cleanup();
      process.exit(0);
    }
  }

  // 返回 false 表示在发现页面前收到了停止请求。
  async #waitForFirstPage(): Promise<boolean> {
    const { config, daemon } = this.#context;
    const deadline = Date.now() + config.startupTimeoutMs;
    while (!this.#stopRequested && Date.now() < deadline) {
      if (await daemon.stopRequested(process.pid, this.#instanceId)) {
        this.#stopRequested = true;
        break;
      }
      if (await this.#refreshClients()) return true;
      await sleep(250);
    }
    if (this.#stopRequested) return false;
    throw new Error(`${Math.round(config.startupTimeoutMs / 1000)} 秒内未发现 Codex CDP 页面`);
  }

  async #refreshClients(): Promise<boolean> {
    let targets;
    try {
      targets = await this.#context.cdp.targets();
    } catch {
      return false;
    }
    const currentIds = new Set(targets.map((target) => target.id));
    for (const [id, client] of this.#clients) {
      if (currentIds.has(id) && client.open) continue;
      client.close();
      this.#clients.delete(id);
    }
    for (const target of targets) {
      if (this.#clients.has(target.id) || !target.webSocketDebuggerUrl) continue;
      try {
        const client = await attachRenderers(target, this.#renderers);
        this.#clients.set(target.id, client);
        client.on("Page.loadEventFired", () => this.#restoreAfterNavigation(client));
      } catch (error) {
        console.error(`${this.#logPrefix} 页面连接失败 ${target.id}: ${(error as Error).message}`);
      }
    }
    return this.#clients.size > 0;
  }

  #restoreAfterNavigation(client: CdpClient): void {
    if (this.#stopRequested) return;
    setTimeout(() => {
      if (this.#stopRequested) return;
      void client.send("Runtime.evaluate", { expression: this.#renderers.source, awaitPromise: true }).catch((error) => {
        console.error(`${this.#logPrefix} 页面刷新后增强恢复失败: ${error.message}`);
      });
    }, 100);
  }

  async #reloadRules(): Promise<void> {
    const { config } = this.#context;
    const request = await readJson(config.stateFiles.reloadRequest);
    if (!request || request.instance_id !== this.#instanceId || request.id === this.#lastReloadId) return;
    this.#lastReloadId = request.id;
    try {
      const next = await loadRenderers(hashRulesFile(config));
      if (!this.#clients.size) throw new Error("没有可加载规则的 Codex 窗口");
      for (const client of this.#clients.values()) await reinjectRenderers(client, next);
      this.#renderers = next;
      await writeJsonAtomic(config.stateFiles.reloadResult, { id: request.id });
    } catch (error) {
      // 某个窗口在更新中断开时，恢复仍可访问的窗口和后续导航使用的旧脚本。
      for (const client of this.#clients.values()) {
        try {
          await reinjectRenderers(client, this.#renderers);
        } catch { /* 已关闭窗口由 refreshClients 清理。 */ }
      }
      await writeJsonAtomic(config.stateFiles.reloadResult, { id: request.id, error: (error as Error).message });
    }
  }

  async #runAutoGc(): Promise<void> {
    if (this.#stopRequested || this.#autoGcRunning) return;
    this.#autoGcRunning = true;
    const options = { dryRun: false, idleMinutes: AUTO_GC_IDLE_MINUTES };
    try {
      const targets = await this.#context.cdp.targets();
      const { total, pageErrors } = await reclaimIdleThreads(targets, options);
      console.log(`${this.#logPrefix} ${new Date().toISOString()} 定时${formatGcReport(total, options)}`);
      for (const message of pageErrors) console.error(`${this.#logPrefix} 定时回收部分窗口失败：${message}`);
    } catch (error) {
      console.error(`${this.#logPrefix} 定时回收失败：${(error as Error).message}`);
    } finally {
      this.#autoGcRunning = false;
    }
  }

  #requestStop(): void {
    this.#stopRequested = true;
    void this.#cleanup().finally(() => process.exit(0));
  }

  #cleanup(): Promise<void> {
    this.#cleanupPromise ??= (async () => {
      this.#stopRequested = true;
      clearInterval(this.#autoGcTimer);
      const clients = [...this.#clients.values()];
      await Promise.allSettled(clients.map(async (client) => {
        try {
          if (client.injectedScriptId) {
            await client.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: client.injectedScriptId });
          }
        } finally {
          await client.send("Runtime.evaluate", { expression: this.#renderers.cleanup, awaitPromise: true });
        }
      }));
      for (const client of clients) client.close();
      await this.#context.daemon.clear();
      await this.#context.keybindings.restore({ quiet: true });
    })();
    return this.#cleanupPromise;
  }
}

export async function daemonCommand(context: CommandContext): Promise<void> {
  const { config, daemon } = context;
  await fs.promises.mkdir(config.stateDir, { recursive: true });
  const previousPid = await daemon.pid();
  if (processAlive(previousPid) && previousPid !== process.pid) {
    throw new Error(`已有守护进程运行（PID ${previousPid}）`);
  }
  const renderers = await loadRenderers(hashRulesFile(config));
  const instance = new Daemon(context, renderers);
  await daemon.claim(process.pid, instance.instanceId);
  await instance.run();
}
