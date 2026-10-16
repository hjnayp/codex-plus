import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface StateFiles {
  pid: string;
  ready: string;
  port: string;
  log: string;
  stopRequest: string;
  instance: string;
  shortcutKeybindings: string;
  reloadRequest: string;
  reloadResult: string;
}

export interface Config {
  commandName: string;
  userHome: string;
  codexHome: string;
  /// 测试与无界面环境跳过官方 App 的探测、启动与激活。
  skipApp: boolean;
  /// 只有真实 App 或显式指定的 Codex 目录才恢复快捷键，避免测试改写用户配置。
  manageKeybindings: boolean;
  chatgptApp: string;
  installPrefix: string;
  stateDir: string;
  stateFiles: StateFiles;
  configuredPort: number | null;
  startupTimeoutMs: number;
  stopTimeoutMs: number;
  forceStopTimeoutMs: number;
  hashRulesOverride: string | null;
}

export const DEFAULT_CDP_PORT = 57331;

// 源码运行时为 src/hosts/codex-desktop，打包后为 bin/；仓库定位与产物路径都以此为起点。
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

export function validPort(value: unknown): value is number | string {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const userHome = os.homedir();
  const stateDir = env.CODEX_PLUS_STATE_DIR || path.join(userHome, ".codex", "codex+");
  const state = (name: string) => path.join(stateDir, name);
  const configuredPort = String(env.CODEX_PLUS_CDP_PORT || "").trim();
  const skipApp = env.CODEX_PLUS_SKIP_APP === "1";
  return {
    commandName: env.CODEX_PLUS_COMMAND_NAME || "codex+",
    userHome,
    codexHome: env.CODEX_PLUS_CODEX_HOME || path.join(userHome, ".codex"),
    skipApp,
    manageKeybindings: !skipApp || Boolean(env.CODEX_PLUS_CODEX_HOME),
    chatgptApp: String(env.CODEX_PLUS_CHATGPT_APP || "").trim() || "/Applications/ChatGPT.app",
    installPrefix: env.CODEX_PLUS_INSTALL_PREFIX || path.join(userHome, ".local"),
    stateDir,
    stateFiles: {
      pid: state("daemon.pid"),
      ready: state("ready.json"),
      port: state("cdp-port.json"),
      log: state("daemon.log"),
      stopRequest: state("stop.request"),
      instance: state("daemon.instance.json"),
      shortcutKeybindings: state("shortcut-keybindings.json"),
      reloadRequest: state("reload-request.json"),
      reloadResult: state("reload-result.json"),
    },
    configuredPort: validPort(configuredPort) ? Number(configuredPort) : null,
    startupTimeoutMs: Number(env.CODEX_PLUS_STARTUP_TIMEOUT_MS || 90000),
    stopTimeoutMs: Number(env.CODEX_PLUS_STOP_TIMEOUT_MS || 7000),
    forceStopTimeoutMs: Number(env.CODEX_PLUS_FORCE_STOP_TIMEOUT_MS || 2000),
    hashRulesOverride: env.CODEX_PLUS_HASH_RULES_FILE || null,
  };
}

// 产物位于 bin/，源码位于 src/hosts/codex-desktop/，相对层级不同，所以按 package.json 向上定位插件根目录。
export function packageRoot(): string {
  let current = MODULE_DIR;
  while (true) {
    const manifest = path.join(current, "package.json");
    if (fs.existsSync(manifest) && JSON.parse(fs.readFileSync(manifest, "utf8")).name === "codex-plus") return current;
    const parent = path.dirname(current);
    if (parent === current) throw new Error("无法定位 codex+ 根目录（需要 name 为 codex-plus 的 package.json）");
    current = parent;
  }
}

export function hashRulesFile(config: Config): string {
  return config.hashRulesOverride || path.join(packageRoot(), "hash-rules.toml");
}
