import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildClaudeHooks } from "../src/build/bundle.ts";
import { compileHashRules } from "../src/core/hash-rules.ts";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = "/plugin/claude";
const RULES_PATH = `${PLUGIN_ROOT}/../hash-rules.toml`;
const RULES_TOML = `[[rules]]
trigger = "#ap"
text = "批准. "

[[rules]]
trigger = "#rv(ai=claude)"
text = "交给 {ai} 审查"
`;

// hook API 的事件、$ 与 next 均为测试替身，按 any 处理。
type Hook = ($: any, event: any, next: any) => Promise<any>;

interface HookEntry {
  hook: Hook;
  catch?: Hook;
}

interface RuleFile {
  text: string;
  mtime: number;
}

let artifact: string;
let loads = 0;

test.before(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-plus-claude-hooks-"));
  artifact = path.join(directory, "hash-rules.mjs");
  fs.writeFileSync(artifact, await buildClaudeHooks(PACKAGE_ROOT));
});

// 每次导入新的产物实例，模块级规则缓存互不影响；$ 只提供 hook 实际调用的能力。
async function load(files: Map<string, RuleFile>) {
  const module = await import(`${pathToFileURL(artifact)}?instance=${++loads}`);
  const hooks: Record<string, HookEntry> = {};
  const toasts: string[] = [];
  const fills: { text: string }[] = [];
  module.register((event: string, hook: Hook) => {
    hooks[event] = { hook };
    return { catch: (handler: Hook) => { hooks[event].catch = handler; } };
  });
  const $ = {
    plugin: { root: PLUGIN_ROOT },
    fs: {
      stat: async (file: string) => {
        const entry = files.get(file);
        return entry ? { kind: "file", size: entry.text.length, mtimeMs: entry.mtime, isLink: false }
          : { kind: "other", size: 0, mtimeMs: 0, isLink: false };
      },
      read: async (file: string) => {
        if (!files.has(file)) throw new Error(`ENOENT: ${file}`);
        return files.get(file)!.text;
      },
    },
    ui: { toast: (text: string) => toasts.push(text) },
    prompt: { fill: async (args: { text: string }) => { fills.push(args); return { isFilled: true }; } },
  };
  async function submit(text: string, extra: object = {}) {
    let passed: any;
    const event = { text, wait: false, origin: { kind: "composer" }, ...extra };
    const result = await hooks["prompt.submit"].hook($, event, async (e: any) => { passed = e; return { text: e.text }; });
    return { result, passed };
  }
  async function edit(text: string, decorations?: unknown[]) {
    const event = { origin: { kind: "composer" }, text: "", cursor: 0, start: 0, end: 0, inputText: text };
    return hooks["prompt.edit"].hook($, event, async () => ({ text, cursor: text.length, decorations }));
  }
  return { module, hooks, $, toasts, fills, submit, edit };
}

function rulesFile(text = RULES_TOML, mtime = 1) {
  return new Map([[RULES_PATH, { text, mtime }]]);
}

test("代码区外才展开，围栏状态跨段延续", () => {
  const rules = compileHashRules([{ trigger: "#ap", text: "批准. " }]);
  const replaced = (text: string) => {
    let output = "";
    let end = 0;
    for (const edit of rules.edits(text).edits) {
      output += text.slice(end, edit.start) + edit.text;
      end = edit.end;
    }
    return output + text.slice(end);
  };
  assert.equal(replaced("#ap `#ap` #ap"), "批准.  `#ap` 批准. ");
  assert.equal(replaced("```\n#ap\n```\n#ap"), "```\n#ap\n```\n批准. ");
  assert.equal(replaced("~~~~\n#ap\n~~~\n#ap"), "~~~~\n#ap\n~~~\n#ap");
  assert.equal(replaced("``a ` #ap`` #ap"), "``a ` #ap`` 批准. ");
  assert.equal(replaced("`#ap"), "`批准. ");
  assert.equal(replaced("`a` #ap ``b`` `c"), "`a` 批准.  ``b`` `c");
  const opened = rules.edits("```js", null);
  assert.equal(opened.fence, "```");
  const inside = rules.edits("#ap", opened.fence);
  assert.deepEqual(inside, { edits: [], fence: "```" });
  assert.deepEqual(rules.edits("```", inside.fence), { edits: [], fence: null });
});

test("打包产物不含 import，可直接作为 hook 模块加载", async () => {
  const source = fs.readFileSync(artifact, "utf8");
  assert.doesNotMatch(source, /^\s*import\s/m);
  assert.doesNotMatch(source, /\bimport\(/);
  assert.match(source, /^export\s*\{/m);
});

test("发送前展开人直接输入的提示，保留代码与非用户来源", async () => {
  const { submit, toasts } = await load(rulesFile());
  const typed = await submit("#ap `#ap` #rv(codex)");
  assert.equal(typed.passed.text, "批准.  `#ap` 交给 codex 审查");
  assert.equal(typed.result.text, typed.passed.text);
  for (const extra of [{ origin: { kind: "peer" } }, { origin: { kind: "task-notification" } },
    { isMeta: true }, { command: { name: "review" } }]) {
    const { passed } = await submit("#ap", extra);
    assert.equal(passed.text, "#ap", JSON.stringify(extra));
  }
  for (const kind of ["bridge", "sdk"]) {
    assert.equal((await submit("#ap", { origin: { kind } })).passed.text, "批准. ");
  }
  const unchanged = await submit("#unknown");
  assert.equal(unchanged.passed.text, "#unknown");
  assert.deepEqual(toasts, []);
});

test("输入框只给实际生效的缩写着色，保留其他插件的着色", async () => {
  const { edit } = await load(rulesFile());
  const existing = { start: 0, end: 1, bold: true };
  const box = await edit("x #ap `#ap` #rv(bad=1) #rv(codex)", [existing]);
  assert.equal(box.text, "x #ap `#ap` #rv(bad=1) #rv(codex)");
  assert.deepEqual(box.decorations, [
    existing,
    { start: 2, end: 5, color: "warning", underline: true },
    { start: 23, end: 33, color: "warning", underline: true },
  ]);
  const plain = await edit("没有缩写");
  assert.equal(plain.decorations, undefined);
});

test("规则无效时保留旧规则且同一版本只提示一次，缺失规则时不展开", async () => {
  const files = rulesFile();
  const { submit, toasts } = await load(files);
  assert.equal((await submit("#ap")).passed.text, "批准. ");
  files.set(RULES_PATH, { text: "[[rules]]\ntrigger = ", mtime: 2 });
  assert.equal((await submit("#ap")).passed.text, "批准. ");
  assert.equal((await submit("#ap")).passed.text, "批准. ");
  assert.equal(toasts.length, 1);
  assert.match(toasts[0], /^Codex\+ 缩写规则无效，继续使用旧规则：/);
  files.set(RULES_PATH, { text: '[[rules]]\ntrigger = "#ap"\ntext = "通过. "\n', mtime: 3 });
  assert.equal((await submit("#ap")).passed.text, "通过. ");

  const missing = await load(new Map());
  assert.equal((await missing.submit("#ap")).passed.text, "#ap");
  assert.equal((await missing.edit("#ap")).decorations, undefined);
  assert.equal(missing.toasts.length, 1);
  assert.match(missing.toasts[0], /^Codex\+ 缩写规则无效，暂不展开：/);
});

test("展开失败或 hook 出错时不发送原文，并把草稿放回输入框", async () => {
  const big = "x".repeat(600 * 1024);
  const { submit, fills, hooks, $ } = await load(rulesFile(`[[rules]]\ntrigger = "#big"\ntext = "${big}"\n`));
  const failed = await submit("#big #big");
  assert.equal(failed.passed, undefined);
  assert.match(failed.result.drop, /^Codex\+ 缩写展开失败，未发送消息：缩写展开超过 1 MiB$/);
  assert.deepEqual(fills, [{ text: "#big #big" }]);

  const event = { text: "#ap", wait: false, origin: { kind: "composer" } };
  const forwarded: unknown[] = [];
  const next = Object.assign(async (e: { text: string }) => { forwarded.push(e); return { text: e.text }; }, { called: false });
  assert.match((await hooks["prompt.submit"].catch!($, event, next)).drop, /处理超时或出错/);
  assert.deepEqual(fills.at(-1), { text: "#ap" });
  next.called = true;
  assert.deepEqual(await hooks["prompt.submit"].catch!($, event, next), { text: "#ap" });
  assert.deepEqual(forwarded, [event]);
});
