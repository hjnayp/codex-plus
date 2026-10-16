import fs from "node:fs";
import path from "node:path";
import { buildBundle, buildClaudeHooks } from "../../../build/bundle.ts";
import { packageRoot } from "../config.ts";
import { replaceFile } from "../system.ts";
import type { CommandContext } from "./context.ts";

// bin/codex+ 启动器只负责找 node，业务代码全部来自 update 打包的这个产物。
const BUNDLE_BASENAME = "codex+.mjs";

/// 先打包再更新链接：未执行 update 的源码改动不会影响已安装的命令。
export async function updateCommand({ config }: CommandContext): Promise<void> {
  const pluginRoot = packageRoot();
  const binDir = path.join(config.installPrefix, "bin");
  const manDir = path.join(config.installPrefix, "share", "man", "man1");
  await Promise.all([
    fs.promises.mkdir(binDir, { recursive: true }),
    fs.promises.mkdir(manDir, { recursive: true }),
  ]);
  const launcherSource = path.join(pluginRoot, "bin", "codex+");
  if (!fs.existsSync(launcherSource)) throw new Error(`缺少启动器：${launcherSource}`);
  await fs.promises.chmod(launcherSource, 0o755);

  const packaged = path.join(pluginRoot, "bin", BUNDLE_BASENAME);
  const { source, revision } = await buildBundle(pluginRoot);
  await replaceFile(packaged, source, 0o755);
  const claudeHooks = path.join(pluginRoot, "claude", "hooks", "hash-rules.mjs");
  await replaceFile(claudeHooks, await buildClaudeHooks(pluginRoot), 0o644);

  // 规则文件由用户维护且不入公开版本库；首次安装时从示例生成，已有文件不覆盖。
  const rules = path.join(pluginRoot, "hash-rules.toml");
  let rulesCreated = true;
  try {
    await fs.promises.copyFile(path.join(pluginRoot, "hash-rules.example.toml"), rules, fs.constants.COPYFILE_EXCL);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    rulesCreated = false;
  }

  const installedCommand = path.join(binDir, config.commandName);
  await fs.promises.rm(installedCommand, { force: true });
  await fs.promises.symlink(launcherSource, installedCommand);

  const manSource = path.join(pluginRoot, "docs", "codex+.1");
  if (!fs.existsSync(manSource)) throw new Error(`缺少手册源：${manSource}`);
  const manTarget = path.join(manDir, `${config.commandName}.1`);
  await replaceFile(manTarget, await fs.promises.readFile(manSource), 0o644);

  console.log(`已打包命令: ${packaged}（源码指纹 ${revision}）`);
  console.log(`已打包 Claude Code 插件: ${claudeHooks}`);
  if (rulesCreated) console.log(`已从示例生成缩写规则: ${rules}`);
  console.log(`已安装命令: ${installedCommand} -> ${launcherSource}`);
  console.log(`已安装手册: ${manTarget}`);
}
