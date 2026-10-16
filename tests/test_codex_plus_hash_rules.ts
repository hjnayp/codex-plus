import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { parse } from "smol-toml";
import { compileHashRules } from "../src/core/hash-rules.ts";
import { CdpClient } from "../src/hosts/codex-desktop/cdp.ts";
import { loadRenderers } from "../src/hosts/codex-desktop/renderers.ts";

// 固定验收样例独立于用户持续编辑的规则真源。
const rules = [
  { trigger: "#ap", text: "批准. " },
  { trigger: "#rbc", text: "将改动提交给 claude 审查, 使用 opus, high. " },
  { trigger: "#rui", text: "对于 UI 页面, $opsis. " },
  { trigger: "#_master-branch", text: "远端主分支" },
  { trigger: "#nb", text: "在当前工作树, 从#_master-branch创建新分支. 注意 upstream 不要设置为#_master-branch. " },
  { trigger: "#fullreview", text: "#rbc #rui" },
  { trigger: "#doandreview", text: "完成后, #fullreview" },
  { trigger: "#go", text: "#ap #doandreview" },
  { trigger: "#rvc1(ai=claude,module=opus)", text: "将改动提交给 {ai} 审查, 使用 {module}" },
  { trigger: "#rvui1", text: "对于 UI 页面, $opsis. " },
  { trigger: "#rvcode(ai=claude,module=opus,think=high)", text: "将改动提交给 {ai} 审查, 使用 {module}, {think}" },
  { trigger: "#goandrv1(ai=claude, module=opus, think=high)", text: "批准. 完成后, #rvui1 -> #rvcode(ai={ai}, module={module}, think={think})" },
];
const fixtureToml = rules.map(({ trigger, text }) => `# 注释\n[[rules]]\ntrigger = ${JSON.stringify(trigger)}\ntext = ${JSON.stringify(text)} # 行尾注释`).join("\n");

test("现有规则的独立预期、完整 token、递归和配置错误", () => {
  const compiled = compileHashRules(rules);
  assert.deepEqual(JSON.parse(JSON.stringify(parse(fixtureToml).rules)), rules);
  assert.equal(compiled.replace("#go"), "批准.  完成后, 将改动提交给 claude 审查, 使用 opus, high.  对于 UI 页面, $opsis. ");
  assert.equal(compiled.replace("#nb"), "在当前工作树, 从远端主分支创建新分支. 注意 upstream 不要设置为远端主分支. ");
  assert.equal(compiled.replace("#gopher #unknown #go_extra #GO"), "#gopher #unknown #go_extra #GO");
  assert.equal(compiled.replace("https://x.dev/a#go https://x.dev/#go foo#go"), "https://x.dev/a#go https://x.dev/#go foo#go");
  assert.equal(compiled.replace("https://x.dev/1，#ap"), "https://x.dev/1，批准. ");
  for (const invalid of [null, {}, [{trigger:"#a",text:"x",enabled:false}], [{ trigger: "x", text: "bad" }],
    [{ trigger: "#a", text: "a" }, { trigger: "#a", text: "b" }],
    [{ trigger: "#a", text: "#b" }, { trigger: "#b", text: "#a" }],
    [{ trigger: "#a", text: "x".repeat(1024 * 1024 + 1) }]]) {
    assert.throws(() => compileHashRules(invalid));
  }
  assert.equal(compileHashRules([{ trigger: "#a", text: "" }]).replace("#a"), "");
});

test("Chromium + ProseMirror：发送前展开，保留代码、格式、mention、附件及原生提交语义", { timeout: 30000 }, async () => {
  const bundle = await build({ stdin: {
    contents: 'import {Schema} from "prosemirror-model"; import {EditorState} from "prosemirror-state"; import {EditorView} from "prosemirror-view"; window.PM={Schema,EditorState,EditorView};',
    resolveDir: new URL("../", import.meta.url).pathname,
  }, bundle: true, write: false, platform: "browser", format: "iife" });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "codex-hash-"));
  const browser = spawn(process.env.CODEX_PLUS_TEST_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ["--headless=new", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
  let client: CdpClient | undefined;
  try {
    let port;
    for (let i = 0; i < 100 && !port; i++) {
      try { port = Number(fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]); } catch {}
      if (!port) await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(port);
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    client = new CdpClient(targets.find((target: { type: string }) => target.type === "page").webSocketDebuggerUrl);
    await client.connect();
    const evaluate = async (expression: string) => {
      const result = await client!.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const wait = async (expression: string) => {
      for (let i = 0; i < 100; i++) {
        if (await evaluate(expression)) return;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.fail(`等待失败：${expression}`);
    };
    await evaluate(bundle.outputFiles[0].text);
    await evaluate(`(() => {
      document.body.innerHTML='<main data-codex-composer-root><div><div contenteditable="true" data-codex-composer></div></div><button data-codex-intelligence-trigger data-selected-reasoning-effort="medium">Model</button><button id="send" aria-label="发送">Send</button><button id="queue" aria-label="加入队列">Queue</button></main>';
      window.root=document.querySelector('main'); window.input=document.querySelector('[data-codex-composer]');
      window.schema=new PM.Schema({nodes:{doc:{content:'block+'},paragraph:{content:'inline*',group:'block',toDOM:()=>['p',0]},code_block:{content:'text*',group:'block',code:true,toDOM:()=>['pre',['code',0]]},text:{group:'inline'},hard_break:{inline:true,group:'inline',selectable:false,toDOM:()=>['br']},mention:{inline:true,group:'inline',atom:true,attrs:{id:{}},toDOM:node=>['span',{'data-mention':node.attrs.id},'@skill']}},marks:{strong:{toDOM:()=>['strong',0]},code:{code:true,toDOM:()=>['code',0]}}});
      const view=new PM.EditorView(input,{state:PM.EditorState.create({schema})});input.removeAttribute('data-codex-composer');window.input=view.dom;input.setAttribute('data-codex-composer','');input.setAttribute('spellcheck','true');window.controller={view,getEnterBehavior:()=>window.enter};
      input.parentElement.__reactFiber$fixture={memoizedProps:{composerController:controller},return:{memoizedProps:{conversationId:'fixture'}}};
      window.trigger=document.querySelector('[data-codex-intelligence-trigger]');
      window.modelProps={model:'gpt-6.1-sol',reasoningEffort:'medium',models:[{model:'gpt-6.1-sol',supportedReasoningEfforts:['medium','high'].map(reasoningEffort=>({reasoningEffort}))}],async onSelectModel(model,effort){if(window.rejectSelection)throw Error('selection failed');modelProps.reasoningEffort=effort;trigger.setAttribute('data-selected-reasoning-effort',effort)}};
      trigger.__reactFiber$fixture={memoizedProps:modelProps};
      window.reset=(blocks)=>{window.records=[];window.enter='enter';window.rejectSelection=false;window.attachments=['attachment:kept'];modelProps.reasoningEffort='medium';trigger.setAttribute('data-selected-reasoning-effort','medium');root.querySelector('[role=alert]')?.remove();controller.view.updateState(PM.EditorState.create({schema,doc:schema.nodeFromJSON({type:'doc',content:blocks})}))};
      window.paragraph=(text,marks)=>({type:'paragraph',content:[{type:'text',text,...(marks?{marks}:{} )}]});
      window.nativeSend=()=>records.push({doc:controller.view.state.doc.toJSON(),attachments,effort:modelProps.reasoningEffort});
      input.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing&&(enter==='enter'?!(e.ctrlKey||e.metaKey):e.ctrlKey||e.metaKey))nativeSend()});
      document.querySelector('#send').addEventListener('click',nativeSend);document.querySelector('#queue').addEventListener('click',nativeSend);
      window.press=(extra={})=>input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true,...extra}));
    })()`);
    const fixturePath = path.join(profile, "hash-rules.toml");
    fs.writeFileSync(fixturePath, fixtureToml);
    const renderers = await loadRenderers(fixturePath);
    await evaluate(renderers.source);
    await evaluate(`reset([paragraph('#ap #unknown #gopher'),paragraph('#go',[{type:'code'}]),{type:'code_block',content:[{type:'text',text:'#go'}]}]);`);
    await wait("CSS.highlights.get('codex-plus-hash')?.size === 1");
    assert.deepEqual(await evaluate("Array.from(CSS.highlights.get('codex-plus-hash'), range=>range.toString())"), ["#ap"]);
    assert.equal(await evaluate("input.spellcheck"), true);
    assert.equal(await evaluate("controller.view.state.doc.textContent"), "#ap #unknown #gopher#go#go");
    await evaluate("window.savedRules=window.__CODEX_PLUS_HASH_RULES__;window.__CODEX_PLUS_HASH_RULES__=[{trigger:'#unknown',text:'known now'}];input.dispatchEvent(new InputEvent('input',{bubbles:true}));");
    await wait("Array.from(CSS.highlights.get('codex-plus-hash'),range=>range.toString()).join() === '#unknown'");
    await evaluate("window.__CODEX_PLUS_HASH_RULES__=savedRules;");
    // 单独留存可复核截图：实际 EditorView 中高亮，不修改文档或 selection。
    await evaluate("reset([paragraph('#ap #unknown #gopher')]);");
    await wait("Array.from(CSS.highlights.get('codex-plus-hash'),range=>range.toString()).join() === '#ap'");
    const screenshot = await client.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(os.tmpdir(), "codex-plus-hash-highlights.png"), Buffer.from(screenshot.data, "base64"));
    await evaluate("reset([paragraph('#l #sol-h 正文 #h #sol-h'),paragraph('#x')]);");
    await wait("CSS.highlights.get('codex-plus-hash')?.size === 2");
    assert.deepEqual(await evaluate("Array.from(CSS.highlights.get('codex-plus-hash'),range=>range.toString())"), ["#l", "#sol-h"]);
    await evaluate("reset([paragraph('#h',[{type:'code'}])]);");
    await wait("CSS.highlights.get('codex-plus-hash')?.size === 0");
    await evaluate("press();");
    assert.equal(await evaluate("records[0].doc.content[0].content[0].text"), "#h");
    assert.equal(await evaluate("records[0].effort"), "medium");
    await evaluate(`reset([{type:'paragraph',content:[{type:'text',text:'#h '},{type:'mention',attrs:{id:'kept'}}]},paragraph('正文')]);press();`);
    await wait("records.length === 1");
    assert.deepEqual(await evaluate("records[0].doc.content[0].content"), [{type:"mention",attrs:{id:"kept"}}]);
    await evaluate("reset([paragraph('#go')]);input.dispatchEvent(new InputEvent('input',{bubbles:true}));");
    assert.equal(await evaluate("controller.view.state.doc.textContent"), "#go");
    await evaluate("press();press({repeat:true});document.querySelector('#send').click();");
    await wait("records.length === 1");
    assert.equal(await evaluate("records[0].doc.content[0].content[0].text"), "批准.  完成后, 将改动提交给 claude 审查, 使用 opus, high.  对于 UI 页面, $opsis. ");

    await evaluate(`reset([{type:'paragraph',content:[{type:'text',text:'#ap',marks:[{type:'strong'}]},{type:'mention',attrs:{id:'skill:kept'}},{type:'text',text:' #go',marks:[{type:'code'}]},{type:'text',text:' #gopher #unknown'}]},{type:'code_block',content:[{type:'text',text:'#go'}]}]);document.querySelector('#queue').click();`);
    await wait("records.length === 1");
    assert.deepEqual(await evaluate("records[0]"), { doc: { type: "doc", content: [
      { type: "paragraph", content: [
        { type: "text", text: "批准. ", marks: [{ type: "strong" }] },
        { type: "mention", attrs: { id: "skill:kept" } },
        { type: "text", text: " #go", marks: [{ type: "code" }] },
        { type: "text", text: " #gopher #unknown" },
      ] }, { type: "code_block", content: [{ type: "text", text: "#go" }] },
    ] }, attachments: ["attachment:kept"], effort: "medium" });
    await evaluate(`reset([{type:'paragraph',content:[{type:'text',text:'#g',marks:[{type:'strong'}]},{type:'text',text:'o #go',marks:[]},{type:'text',text:'pher',marks:[{type:'strong'}]}]}]);press();`);
    await wait("records.length === 1");
    assert.equal(await evaluate("controller.view.state.doc.textContent"), "批准.  完成后, 将改动提交给 claude 审查, 使用 opus, high.  对于 UI 页面, $opsis.  #gopher");
    await evaluate("reset([paragraph('正文 `#go` #ap https://x.dev/a#ap foo#ap'),paragraph('```text'),paragraph('#go'),paragraph('```'),paragraph('#ap')]);");
    await wait("CSS.highlights.get('codex-plus-hash')?.size === 2");
    await evaluate("press();");
    await wait("records.length === 1");
    assert.equal(await evaluate("records[0].doc.content[0].content[0].text"), "正文 `#go` 批准.  https://x.dev/a#ap foo#ap");
    assert.equal(await evaluate("records[0].doc.content[2].content[0].text"), "#go");
    assert.equal(await evaluate("records[0].doc.content[4].content[0].text"), "批准. ");
    await evaluate(`reset([{type:'paragraph',content:[{type:'text',text:'\u0060\u0060\u0060js'},{type:'hard_break'},{type:'text',text:'#go'},{type:'hard_break'},{type:'text',text:'\u0060\u0060\u0060'},{type:'hard_break'},{type:'text',text:'#ap'}]},paragraph('#ap')]);`);
    await wait("CSS.highlights.get('codex-plus-hash')?.size === 2");
    await evaluate("press();");
    await wait("records.length === 1");
    assert.equal(await evaluate("records[0].doc.content[0].content[2].text"), "#go");
    assert.equal(await evaluate("records[0].doc.content[0].content[6].text"), "批准. ");
    assert.equal(await evaluate("records[0].doc.content[1].content[0].text"), "批准. ");
    await evaluate("reset([paragraph('#rvc1(codex, sol) #rvc1(module=fable) #rvc1(unknown=x)')]);");
    await wait("Array.from(CSS.highlights.get('codex-plus-hash') || [],range=>range.toString()).join('|') === '#rvc1(codex, sol)|#rvc1(module=fable)'");
    assert.deepEqual(await evaluate("Array.from(CSS.highlights.get('codex-plus-hash'),range=>range.toString())"), ["#rvc1(codex, sol)", "#rvc1(module=fable)"]);
    assert.equal(await evaluate("controller.view.state.doc.textContent"), "#rvc1(codex, sol) #rvc1(module=fable) #rvc1(unknown=x)");
    await evaluate("document.querySelector('#send').click();");
    await wait("records.length === 1");
    assert.equal(await evaluate("records[0].doc.content[0].content[0].text"), "将改动提交给 codex 审查, 使用 sol 将改动提交给 claude 审查, 使用 fable #rvc1(unknown=x)");
    await evaluate("reset([paragraph('#h #goandrv1(codex, sol, xhigh)')]);press();");
    await wait("records.length === 1");
    assert.equal(await evaluate("records[0].effort"), "high");
    assert.equal(await evaluate("records[0].doc.content[0].content[0].text"), "批准. 完成后, 对于 UI 页面, $opsis.  -> 将改动提交给 codex 审查, 使用 sol, xhigh");
    await evaluate("reset([paragraph('#rvc1( #ap')]);");
    await wait("Array.from(CSS.highlights.get('codex-plus-hash') || [],range=>range.toString()).join() === '#ap'");
    await evaluate("press();");
    await wait("records.length === 1");
    assert.equal(await evaluate("records[0].doc.content[0].content[0].text"), "#rvc1( 批准. ");
    await evaluate("reset([paragraph('#rvc1(module=')]);");
    await wait("CSS.highlights.get('codex-plus-hash')?.size === 0");
    await evaluate("press();");
    assert.equal(await evaluate("records[0].doc.content[0].content[0].text"), "#rvc1(module=");
    await evaluate("reset([paragraph('#h #ap')]);press();");
    await wait("records.length === 1");
    assert.equal(await evaluate("records[0].doc.content[0].content[0].text"), "批准. ");
    assert.equal(await evaluate("records[0].effort"), "high");
    await evaluate("reset([paragraph('#h #go')]);rejectSelection=true;press();");
    await wait("!!root.querySelector('[role=alert]')");
    assert.equal(await evaluate("controller.view.state.doc.textContent"), "#h #go");
    assert.equal(await evaluate("records.length"), 0);
    await evaluate("reset([paragraph('#go')]);press({shiftKey:true});");
    assert.equal(await evaluate("controller.view.state.doc.textContent"), "#go");
    assert.equal(await evaluate("records.length"), 0);
    await evaluate("enter='mod-enter';press();");
    assert.equal(await evaluate("records.length"), 0);
    await evaluate("press({metaKey:true});");
    await wait("records.length === 1");
    await evaluate("reset([paragraph('#go')]);window.__CODEX_PLUS_HASH_RULES__=[{trigger:'#go',text:'#go'}];press();");
    await wait("!!root.querySelector('[role=alert]')");
    assert.equal(await evaluate("controller.view.state.doc.textContent"), "#go");
    assert.equal(await evaluate("records.length"), 0);
    await evaluate(renderers.cleanup);
    assert.equal(await evaluate("CSS.highlights.has('codex-plus-hash')"), false);
    assert.equal(await evaluate("input.getAttribute('spellcheck')"), "true");
    assert.equal(await evaluate("!!document.querySelector('#codex-plus-hash-highlights-style')"), false);
  } finally {
    client?.close();
    const exited = new Promise(resolve => browser.once("exit", resolve));
    browser.kill("SIGTERM");
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 2000))]);
    if (browser.exitCode == null && browser.signalCode == null) browser.kill("SIGKILL");
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
