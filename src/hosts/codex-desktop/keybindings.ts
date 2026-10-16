import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config.ts";
import { pathExists, readJson, writeJsonAtomic } from "./system.ts";

/// 旧版本为避开冲突而禁用的官方快捷键；新版本不再禁用，只负责恢复。
export const LEGACY_SHORTCUT_COMMANDS = ["thread9", "switchToMode1", "switchToMode2", "switchToMode3"];
// 更早的版本还禁用过 Cmd+1/2/3/4 与 Ctrl+4。
const RESTORABLE_COMMANDS = ["thread1", "thread2", "thread3", ...LEGACY_SHORTCUT_COMMANDS, "thread4", "switchToMode4"];

type Binding = { command?: string; [key: string]: unknown };

interface BackupState {
  schema_version: 1;
  original_file_existed: boolean;
  original_bindings: Binding[];
  applied_bindings: Binding[];
}

export interface RestoreResult {
  restored: boolean;
  preserved_commands: string[];
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function commandBindings(bindings: Binding[], command: string): Binding[] {
  return bindings.filter((binding) => binding?.command === command);
}

// 用户在运行期间改过该命令的键位时保留现状，否则把注入项换回原值。
function restoreUnchangedCommandBindings(current: Binding[], original: Binding[], applied: Binding[], command: string) {
  if (!sameJson(commandBindings(current, command), commandBindings(applied, command))) {
    return { bindings: current, preserved: true };
  }
  const replacements = commandBindings(original, command);
  const firstIndex = current.findIndex((binding) => binding?.command === command);
  const withoutCommand = current.filter((binding) => binding?.command !== command);
  if (!replacements.length) return { bindings: withoutCommand, preserved: false };
  const insertionIndex = firstIndex < 0 ? withoutCommand.length : Math.min(firstIndex, withoutCommand.length);
  return {
    bindings: [
      ...withoutCommand.slice(0, insertionIndex),
      ...replacements,
      ...withoutCommand.slice(insertionIndex),
    ],
    preserved: false,
  };
}

/// 按旧版本留下的备份恢复 Codex 的 keybindings.json，并保留用户之后的改键。
export class KeybindingRestorer {
  readonly #enabled: boolean;
  readonly #keybindingsFile: string;
  readonly #backupFile: string;

  constructor(config: Config) {
    this.#enabled = config.manageKeybindings;
    this.#keybindingsFile = path.join(config.codexHome, "keybindings.json");
    this.#backupFile = config.stateFiles.shortcutKeybindings;
  }

  async hasBackup(): Promise<boolean> {
    return Boolean(await this.#readBackup());
  }

  async restore({ quiet = false } = {}): Promise<RestoreResult> {
    if (!this.#enabled) return { restored: false, preserved_commands: [] };
    const state = await this.#readBackup();
    if (!state) return { restored: false, preserved_commands: [] };
    const currentFile = await this.#readKeybindings();
    if (!currentFile.exists) {
      await fs.promises.rm(this.#backupFile, { force: true });
      return { restored: false, preserved_commands: [...LEGACY_SHORTCUT_COMMANDS] };
    }

    let next = currentFile.bindings;
    const preservedCommands: string[] = [];
    if (sameJson(next, state.applied_bindings)) {
      next = state.original_bindings;
    } else {
      for (const command of RESTORABLE_COMMANDS) {
        const result = restoreUnchangedCommandBindings(next, state.original_bindings, state.applied_bindings, command);
        next = result.bindings;
        if (result.preserved) preservedCommands.push(command);
      }
    }

    if (!state.original_file_existed && !preservedCommands.length && next.length === 0) {
      await fs.promises.rm(this.#keybindingsFile, { force: true });
    } else if (!sameJson(next, currentFile.bindings)) {
      await writeJsonAtomic(this.#keybindingsFile, next);
    }
    await fs.promises.rm(this.#backupFile, { force: true });
    if (!quiet && preservedCommands.length) {
      console.log(`保留运行期间改写的 Codex 快捷键: ${preservedCommands.join(", ")}`);
    }
    return { restored: true, preserved_commands: preservedCommands };
  }

  async #readKeybindings(): Promise<{ exists: boolean; bindings: Binding[] }> {
    if (!(await pathExists(this.#keybindingsFile))) return { exists: false, bindings: [] };
    const bindings = await readJson(this.#keybindingsFile);
    if (!Array.isArray(bindings)) {
      throw new Error(`Codex 快捷键配置不是数组：${this.#keybindingsFile}`);
    }
    return { exists: true, bindings };
  }

  async #readBackup(): Promise<BackupState | null> {
    const state = await readJson(this.#backupFile);
    if (state == null) return null;
    if (state.schema_version !== 1
      || typeof state.original_file_existed !== "boolean"
      || !Array.isArray(state.original_bindings)
      || !Array.isArray(state.applied_bindings)) {
      throw new Error(`Codex+ 快捷键备份无效：${this.#backupFile}`);
    }
    return state;
  }
}
