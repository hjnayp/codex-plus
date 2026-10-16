import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { Config } from "./config.ts";
import { pathExists, sleep } from "./system.ts";

const execFileAsync = promisify(execFile);
const BUNDLE_ID = "com.openai.codex";

/// 官方 Codex Desktop（macOS ChatGPT.app）的进程控制；skipApp 时视为未运行且不执行任何操作。
export class CodexApp {
  readonly #config: Config;

  constructor(config: Config) {
    this.#config = config;
  }

  async activate(): Promise<void> {
    if (this.#config.skipApp) return;
    await execFileAsync("open", [this.#config.chatgptApp]);
  }

  async #processRunning(): Promise<boolean> {
    if (this.#config.skipApp) return false;
    try {
      await execFileAsync("/usr/bin/pgrep", ["-x", "ChatGPT"]);
      return true;
    } catch {
      return false;
    }
  }

  async running(): Promise<boolean> {
    if (this.#config.skipApp) return false;
    try {
      const { stdout } = await execFileAsync("osascript", ["-e", `application id "${BUNDLE_ID}" is running`]);
      if (stdout.trim().toLowerCase() === "true") return true;
    } catch {
      // AppleScript may report false while the main process is still terminating.
    }
    return this.#processRunning();
  }

  async quit(): Promise<void> {
    if (!(await this.running())) return;
    await execFileAsync("osascript", ["-e", `tell application id "${BUNDLE_ID}" to quit`]);
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && ((await this.running()) || (await this.#processRunning()))) {
      await sleep(250);
    }
    if (await this.running()) throw new Error("官方 Codex 未能在 15 秒内退出");
  }

  /// 以本机回环 CDP 启动官方可执行文件；应用由用户关闭，不随调用方退出。
  async launchWithCdp(port: number): Promise<void> {
    const app = this.#config.chatgptApp;
    if (!(await pathExists(app))) throw new Error(`找不到官方应用：${app}`);
    const executable = path.join(app, "Contents", "MacOS", "ChatGPT");
    if (!(await pathExists(executable))) throw new Error(`找不到官方应用可执行文件：${executable}`);
    spawn(executable, [
      `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1",
      `--remote-allow-origins=http://127.0.0.1:${port}`,
    ], {
      detached: true,
      cwd: path.dirname(executable),
      env: process.env,
      stdio: "ignore",
    }).unref();
  }
}
