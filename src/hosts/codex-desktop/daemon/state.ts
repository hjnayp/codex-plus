import { execFile } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";
import type { StateFiles } from "../config.ts";
import { processAlive, readJson, writeJsonAtomic } from "../system.ts";

const execFileAsync = promisify(execFile);

export interface DaemonIdentity {
  pid: number;
  instance_id: string;
}

export interface ReadyState {
  pid: number;
  hash_rules_file: string;
  cdp_ready: true;
  port: number;
  instance_id: string;
  started_at: string;
}

/// 守护进程与命令进程之间经状态目录通信：PID、实例身份、就绪、停止与重新加载请求。
export class DaemonState {
  readonly files: StateFiles;

  constructor(files: StateFiles) {
    this.files = files;
  }

  async pid(): Promise<number> {
    try {
      return Number((await fs.promises.readFile(this.files.pid, "utf8")).trim());
    } catch {
      return 0;
    }
  }

  async identity(): Promise<DaemonIdentity> {
    const identity = await readJson(this.files.instance);
    return {
      pid: Number(identity?.pid) || 0,
      instance_id: String(identity?.instance_id || ""),
    };
  }

  async ready(): Promise<Partial<ReadyState> | null> {
    return readJson(this.files.ready);
  }

  async claim(pid: number, instanceId: string): Promise<void> {
    await writeJsonAtomic(this.files.instance, {
      pid,
      instance_id: instanceId,
      started_at: new Date().toISOString(),
    });
    await fs.promises.writeFile(this.files.pid, `${pid}\n`, "utf8");
  }

  async markReady(ready: ReadyState): Promise<void> {
    await writeJsonAtomic(this.files.ready, ready);
  }

  async requestStop(identity: DaemonIdentity): Promise<void> {
    await writeJsonAtomic(this.files.stopRequest, { ...identity, requested_at: new Date().toISOString() });
  }

  async stopRequested(pid: number, instanceId: string): Promise<boolean> {
    const request = await readJson(this.files.stopRequest);
    return request?.pid === pid && request?.instance_id === instanceId;
  }

  /// 启动新守护进程前清掉上一实例的就绪与停止标记。
  async resetStartup(): Promise<void> {
    await fs.promises.rm(this.files.ready, { force: true });
    await fs.promises.rm(this.files.stopRequest, { force: true });
  }

  async clear(): Promise<void> {
    for (const file of [this.files.pid, this.files.ready, this.files.stopRequest, this.files.instance]) {
      await fs.promises.rm(file, { force: true });
    }
  }
}

/// 进程已退出或只剩僵尸进程时视为已停止。
export async function processStopped(pid: number): Promise<boolean> {
  if (!processAlive(pid)) return true;
  try {
    const { stdout } = await execFileAsync("/bin/ps", ["-o", "stat=", "-p", String(pid)]);
    return stdout.trim().startsWith("Z");
  } catch {
    return true;
  }
}
