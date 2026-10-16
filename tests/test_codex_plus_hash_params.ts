import assert from "node:assert/strict";
import test from "node:test";
import { compileHashRules } from "../src/core/hash-rules.ts";

const entry = {
  trigger: "#rvc1(ai=claude,module=opus)",
  text: "将改动提交给 {ai} 审查, 使用 {module}",
};

test("参数调用：默认、具名覆盖和按声明顺序传入", () => {
  const rules = compileHashRules([entry]);
  for (const [call, expected] of [
    ["#rvc1", "将改动提交给 claude 审查, 使用 opus"],
    ["#rvc1()", "将改动提交给 claude 审查, 使用 opus"],
    ["#rvc1(module=fable)", "将改动提交给 claude 审查, 使用 fable"],
    ["#rvc1(codex, sol)", "将改动提交给 codex 审查, 使用 sol"],
    ["#rvc1(codex)", "将改动提交给 codex 审查, 使用 opus"],
    ["#rvc1(module=sol, ai=codex)", "将改动提交给 codex 审查, 使用 sol"],
    ["#rvc1(codex, module=sol)", "将改动提交给 codex 审查, 使用 sol"],
    ['#rvc1("Claude AI", "opus, high")', "将改动提交给 Claude AI 审查, 使用 opus, high"],
    ["#rvc1('Codex (local)', sol)", "将改动提交给 Codex (local) 审查, 使用 sol"],
  ]) assert.equal(rules.replace(call), expected, call);
});

test("错误、未知和未完成的完整调用不发生部分展开", () => {
  const rules = compileHashRules([entry, { trigger: "#ap", text: "批准" }]);
  for (const call of [
    "#rvc1(unknown=sol)", "#rvc1(a,b,c)", "#rvc1(ai=x,ai=y)", "#rvc1(x,ai=y)",
    "#rvc1(ai=x,sol)", "#rvc1(", "#rvc1(ai=)", "#rvc1(,sol)", "#rvc1(x,)",
    '#rvc1(ai="unfinished)', "#unknown(ai=#ap)", "##rvc1(codex, sol)",
  ]) {
    assert.equal(rules.replace(call), call, call);
    assert.equal(rules.matches(call).length, 0, call);
  }
  assert.equal(rules.replace("#rvc1(unknown=sol) #ap"), "#rvc1(unknown=sol) 批准");
  assert.equal(rules.replace("#rvc1( #ap"), "#rvc1( 批准");
  assert.equal(rules.replace("#todo(don't) #ap"), "#todo(don't) 批准");
  assert.equal(rules.replace("#todo(don't #ap) #ap"), "#todo(don't #ap) 批准");
  assert.equal(rules.replace("https://x.dev/#rvc1(codex,sol)"), "https://x.dev/#rvc1(codex,sol)");
});

test("整段匹配包含括号及空格，定义顺序和递归引用保持一致", () => {
  const rules = compileHashRules([
    entry,
    { trigger: "#review", text: "完成后，#rvc1(codex, module=sol)" },
    { trigger: "#outer(ai=claude)", text: "#rvc1(ai={ai},module=fable)" },
  ]);
  assert.equal(rules.replace("#review"), "完成后，将改动提交给 codex 审查, 使用 sol");
  assert.equal(rules.replace("#outer(codex)"), "将改动提交给 codex 审查, 使用 fable");
  const matches = rules.matches("前文 #rvc1(codex, sol) 后文");
  assert.equal(matches.length, 1);
  assert.equal(matches[0][0], "#rvc1(codex, sol)");
  assert.equal(matches[0].index, 3);
});

test("组合规则向内层转发参数，含逗号与引号的值仍作为一个参数", () => {
  const rules = compileHashRules([
    { trigger: "#rvui1", text: "对于 UI 页面, $opsis. " },
    { trigger: "#rvcode(ai=claude,module=opus,think=high)", text: "将改动提交给 {ai} 审查, 使用 {module}, {think}" },
    { trigger: "#goandrv1(ai=claude, module=opus, think=high)", text: "批准. 完成后, #rvui1 -> #rvcode(ai={ai}, module={module}, think={think})" },
  ]);
  assert.equal(rules.replace("#goandrv1"), "批准. 完成后, 对于 UI 页面, $opsis.  -> 将改动提交给 claude 审查, 使用 opus, high");
  assert.equal(rules.replace("#goandrv1(codex, sol, xhigh)"), "批准. 完成后, 对于 UI 页面, $opsis.  -> 将改动提交给 codex 审查, 使用 sol, xhigh");
  assert.equal(rules.replace('#goandrv1(ai="Codex, local", module="sol (fast)")'), "批准. 完成后, 对于 UI 页面, $opsis.  -> 将改动提交给 Codex, local 审查, 使用 sol (fast), high");
  assert.equal(rules.replace('#goandrv1(ai=' + JSON.stringify('Codex "local"') + ')'), '批准. 完成后, 对于 UI 页面, $opsis.  -> 将改动提交给 Codex "local" 审查, 使用 opus, high');
  const links = compileHashRules([entry, { trigger: "#link(value=claude)", text: "https://x.dev/#rvc1(ai={value})" }]);
  assert.equal(links.replace("#link(codex)"), "https://x.dev/#rvc1(ai=codex)");
});

test("定义校验、动态循环与展开长度保护", () => {
  for (const invalid of [
    [{ trigger: "#x(ai)", text: "{ai}" }],
    [{ trigger: "#x(ai=a,ai=b)", text: "{ai}" }],
    [{ trigger: "#x(ai=a)", text: "a" }, { trigger: "#x(ai=b)", text: "b" }],
    [{ trigger: "#x(ai=a)", text: "#x(ai={ai})" }],
    [entry, { trigger: "#wrapper", text: "#rvc1(modul=opus)" }],
    [entry, { trigger: "#wrapper", text: "#rvc1(module=" }],
  ]) assert.throws(() => compileHashRules(invalid));
  const rules = compileHashRules([{ trigger: "#x(value=ok)", text: "{value}{value}" }]);
  const recursive = compileHashRules([{ trigger: "#dispatch(target=done)", text: "#{target}(target={target})" }]);
  assert.throws(() => recursive.replace("#dispatch(target=dispatch)"), /循环|深度/);
  assert.throws(() => rules.replace(`#x("${"z".repeat(600000)}")`), /1 MiB/);
  assert.equal(rules.replace("#x(value=done)"), "donedone");
  assert.throws(() => compileHashRules([entry]).replace(Array(1800).fill("#rvc1(").join(" ")), /解析工作量/);
});

test("非默认调用在单次展开内复用，重复分支不造成指数遍历", () => {
  const entries = [{ trigger: "#leaf(x=default)", text: "" }];
  for (let i = 0; i < 24; i++) entries.push({
    trigger: `#level${i}(x=default)`,
    text: Array(2).fill(i === 0 ? "#leaf(x={x})" : `#level${i - 1}(x={x})`).join(""),
  });
  const rules = compileHashRules(entries);
  assert.equal(rules.replace("#level23(custom)"), "");
  assert.equal(rules.replace("#level23(other)"), "");
});
