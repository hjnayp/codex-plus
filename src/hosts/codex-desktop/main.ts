#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createContext } from "./commands/context.ts";
import type { Command, CommandContext } from "./commands/context.ts";
import {
  launchCommand, reloadCommand, restartCommand, startCommand, statusCommand, stopCommand,
} from "./commands/lifecycle.ts";
import { gcCommand } from "./commands/threads.ts";
import { updateCommand } from "./commands/update.ts";
import { daemonCommand } from "./daemon/daemon.ts";
import { LEGACY_SHORTCUT_COMMANDS } from "./keybindings.ts";
import { makeManual } from "./manual.ts";
import { PAGE_FEATURES } from "./page/features.ts";
import { readRendererSource } from "./renderers.ts";

const printManual: Command = async ({ config }) => console.log(makeManual(config.commandName));

// 检查运行中的入口（源码或打包产物）带齐全部界面能力与快捷键恢复所需的约定。
const selfTest: Command = async () => {
  for (const { id, cleanup } of PAGE_FEATURES) {
    if (!(await readRendererSource(id)).includes(cleanup)) throw new Error(`界面能力 ${id} 注入检查失败`);
  }
  const modelShortcuts = await readRendererSource("model-shortcuts");
  if (!["gpt-6-astra", "gpt-6.1-sol", "gpt-6-luna"].every((model) => modelShortcuts.includes(model))) {
    throw new Error("模型快捷键注入检查失败");
  }
  if (!["switchToMode1", "switchToMode2", "switchToMode3"].every((command) => LEGACY_SHORTCUT_COMMANDS.includes(command))) {
    throw new Error("官方冲突键生命周期检查失败");
  }
  console.log("SC-CODEX-PLUS-SELF: PASS");
};

/// 命令表：offline 命令不读取已记住的 CDP 端口。
const COMMANDS: Record<string, { run: Command; offline?: boolean }> = {
  "--man": { run: printManual, offline: true },
  man: { run: printManual, offline: true },
  "--self-test": { run: selfTest, offline: true },
  launch: { run: launchCommand },
  start: { run: startCommand },
  restart: { run: restartCommand },
  stop: { run: stopCommand },
  status: { run: statusCommand },
  gc: { run: gcCommand },
  reload: { run: reloadCommand },
  update: { run: updateCommand },
  daemon: { run: daemonCommand },
};

async function main(): Promise<void> {
  if (process.platform !== "darwin") throw new Error("Codex+ 仅支持 macOS");
  const context: CommandContext = createContext();
  const [name = "start", ...args] = process.argv.slice(2);
  const command = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : null;
  if (!command) throw new Error(`未知命令：${name}\n请执行 ${context.config.commandName} --man`);
  if (!command.offline) await context.cdp.loadRememberedPort();
  await command.run(context, args);
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`${process.env.CODEX_PLUS_COMMAND_NAME || "codex+"}: ${error.message}`);
    process.exitCode = 1;
  });
}
