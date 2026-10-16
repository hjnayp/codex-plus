import { CodexApp } from "../app.ts";
import { CdpEndpoint } from "../cdp.ts";
import { loadConfig } from "../config.ts";
import type { Config } from "../config.ts";
import { DaemonState } from "../daemon/state.ts";
import { KeybindingRestorer } from "../keybindings.ts";

/// 命令共享的协作者；在入口按同一份配置组装一次，命令之间不再各自读取环境变量。
export interface CommandContext {
  config: Config;
  cdp: CdpEndpoint;
  app: CodexApp;
  daemon: DaemonState;
  keybindings: KeybindingRestorer;
}

export type Command = (context: CommandContext, args: string[]) => Promise<void>;

export function createContext(env: NodeJS.ProcessEnv = process.env): CommandContext {
  const config = loadConfig(env);
  return {
    config,
    cdp: new CdpEndpoint(config),
    app: new CodexApp(config),
    daemon: new DaemonState(config.stateFiles),
    keybindings: new KeybindingRestorer(config),
  };
}
