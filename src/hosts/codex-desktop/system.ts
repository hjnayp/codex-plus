import fs from "node:fs";
import path from "node:path";

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.promises.access(target);
    return true;
  } catch {
    return false;
  }
}

export async function readJson<T = any>(target: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.promises.readFile(target, "utf8"));
  } catch {
    return null;
  }
}

export async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  await fs.promises.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.promises.rename(temporary, target);
}

// 正在运行的产物就是 update 的常见调用入口，所以先写同目录临时文件再原子替换，
// 避免调用方读到半个产物。
export async function replaceFile(destination: string, contents: string | Buffer, permission: number): Promise<void> {
  const staged = path.join(path.dirname(destination), `.${path.basename(destination)}.update`);
  await fs.promises.writeFile(staged, contents, { mode: permission });
  await fs.promises.chmod(staged, permission);
  await fs.promises.rename(staged, destination);
}

export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
