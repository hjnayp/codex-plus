import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CdpClient } from "../src/hosts/codex-desktop/cdp.ts";
import type { CdpTarget } from "../src/hosts/codex-desktop/cdp.ts";
import { PAGE_FEATURES } from "../src/hosts/codex-desktop/page/features.ts";
import { loadRenderers, readRendererSource } from "../src/hosts/codex-desktop/renderers.ts";

const SOURCE = await readRendererSource("reasoning-prefix");

test("强度前缀进入实际注入和清理链", async () => {
  assert.ok(PAGE_FEATURES.some(({ id }) => id === "reasoning-prefix"));
  const renderers = await loadRenderers();
  assert.equal(renderers.sources.reasoningPrefix, SOURCE);
  assert.match(renderers.cleanup, /__CODEX_PLUS_REASONING_PREFIX_CLEANUP__/);
});

test("Chromium：原生档位先切换、前缀移除、单次提交、失败和生命周期隔离", { timeout: 60000 }, async () => {
  const chrome = process.env.CODEX_PLUS_TEST_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  assert.ok(fs.existsSync(chrome));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "codex-reasoning-prefix-"));
  const browser = spawn(chrome, ["--headless=new", "--no-first-run", "--no-default-browser-check",
    "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
  let client: CdpClient | undefined;
  try {
    let port;
    for (let i = 0; i < 100 && !port; i++) {
      try { port = Number(fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]); } catch {}
      if (!port) await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(port);
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    client = new CdpClient(targets.find((target: CdpTarget) => target.type === "page").webSocketDebuggerUrl);
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
    await evaluate(`(() => {
      document.body.innerHTML='<main data-codex-composer-root><div><div contenteditable="true" data-codex-composer></div></div><button data-codex-intelligence-trigger data-selected-reasoning-effort="medium">Model</button><button id="send" aria-label="发送">Send</button><button id="stop" aria-label="停止">Stop</button></main>';
      window.root=document.querySelector('main'); window.input=document.querySelector('[data-codex-composer]');
      window.trigger=document.querySelector('[data-codex-intelligence-trigger]');
      window.scope={conversationId:'thread-a'}; window.records=[]; window.selections=[]; window.enter='enter';
      window.makeDoc=(text,type='paragraph',blocks=1)=>({text,
        firstChild:{type:{name:type},firstChild:{isText:true},textContent:text.split('\\n')[0],nodeSize:text.split('\\n')[0].length+2},
        childCount:blocks, mentions:['skill:kept'], marks:['bold'], attachments:['image:kept']});
      const state={doc:makeDoc(''),get tr(){const doc=this.doc;return {delete(from,to){window.deletedRange=[from,to];return {doc:makeDoc(from===0?doc.text.slice(doc.firstChild.nodeSize-1):doc.text.slice(0,from-1)+doc.text.slice(to-1))}}}}};
      window.controller={view:{dom:input,state,isDestroyed:false,dispatch(tr){state.doc=tr.doc;input.textContent=tr.doc.text}},getEnterBehavior:()=>enter};
      input.parentElement.__reactFiber$fixture={memoizedProps:{composerController:controller},return:{memoizedProps:scope}};
      window.modelProps={model:'gpt-6.1-sol',reasoningEffort:'medium',models:['gpt-6-astra','gpt-6.1-sol','gpt-6-luna'].map(model=>({model,supportedReasoningEfforts:['low','medium','high','xhigh'].map(reasoningEffort=>({reasoningEffort}))})),
        async onSelectModel(model,effort){selections.push({model,effort});if(window.hangSelection)await new Promise(()=>{});await new Promise(r=>setTimeout(r,window.selectionDelay||0));if(window.rejectSelection)throw Error('原生切换失败');if(!window.neverCommit){if(!window.neverCommitModel)modelProps.model=model;modelProps.reasoningEffort=effort;trigger.setAttribute('data-selected-reasoning-effort',effort)}}};
      trigger.__reactFiber$fixture={memoizedProps:modelProps};
      window.reset=(text,type='paragraph',blocks=1)=>{state.doc=makeDoc(text,type,blocks);input.textContent=text;root.hidden=false;scope.conversationId='thread-a';records=[];selections=[];window.selectionDelay=0;window.rejectSelection=false;window.neverCommit=false;window.hangSelection=false;window.neverCommitModel=false;modelProps.model='gpt-6.1-sol';modelProps.disabled=false;modelProps.reasoningEffortDisabled=false;modelProps.reasoningEffort='medium';trigger.setAttribute('data-selected-reasoning-effort','medium');root.querySelector('[role=alert]')?.remove();};
      window.nativeSend=()=>records.push({text:state.doc.text,effort:trigger.getAttribute('data-selected-reasoning-effort'),model:modelProps.model,mentions:state.doc.mentions,marks:state.doc.marks,attachments:state.doc.attachments});
      input.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing&&(enter==='enter'?!(e.ctrlKey||e.metaKey):e.ctrlKey||e.metaKey))nativeSend()});
      document.querySelector('#send').addEventListener('click',nativeSend);
      window.press=(extra={})=>{const event=new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true,cancelable:true,...extra});input.dispatchEvent(event);return event.defaultPrevented};
    })()`);
    await evaluate(SOURCE);
    for (const [marker, effort] of [["#l", "low"], ["#m", "medium"], ["#h", "high"], ["#x", "xhigh"]]) {
      await evaluate(`reset(${JSON.stringify(marker + "  修复问题\n保留正文 #h")});press();`);
      await wait("records.length === 1");
      assert.deepEqual(await evaluate("records"), [{ text: "修复问题\n保留正文 #h", effort, model: "gpt-6.1-sol",
        mentions: ["skill:kept"], marks: ["bold"], attachments: ["image:kept"] }]);
    }
    // 用户确认的别名及档位；模型和档位必须在实际发送前共同生效。
    for (const [marker, model, effort] of [
      ["#astra-l", "gpt-6-astra", "low"],
      ["#sol-h", "gpt-6.1-sol", "high"],
      ["#luna-x", "gpt-6-luna", "xhigh"],
      ["#astra-m", "gpt-6-astra", "medium"],
    ]) {
      await evaluate(`reset(${JSON.stringify(marker + "  模型正文")});press();`);
      await wait("records.length === 1");
      assert.deepEqual(await evaluate("records"), [{ text: "模型正文", model, effort,
        mentions: ["skill:kept"], marks: ["bold"], attachments: ["image:kept"] }]);
      assert.deepEqual(await evaluate("selections"), [{ model, effort }]);
      await evaluate("records=[];controller.view.state.doc=makeDoc('后续消息');press();");
      assert.equal(await evaluate("records[0].model"), model);
      assert.equal(await evaluate("records[0].effort"), effort);
    }
    for (const [prefix, model, effort] of [
      ["#sol", "gpt-6.1-sol", "medium"],
      ["#astra", "gpt-6-astra", "medium"],
      ["#luna", "gpt-6-luna", "medium"],
      ["#m", "gpt-6.1-sol", "medium"],
      ["#sol #m", "gpt-6.1-sol", "medium"],
      ["#astra #h", "gpt-6-astra", "high"],
      ["#x #luna", "gpt-6-luna", "xhigh"],
      ["#astra-l #sol #h", "gpt-6.1-sol", "high"],
    ]) {
      await evaluate(`reset(${JSON.stringify(prefix + "  独立指令正文")});press();`);
      await wait("records.length === 1");
      assert.deepEqual(await evaluate("records"), [{text: "独立指令正文", model, effort,
        mentions: ["skill:kept"], marks: ["bold"], attachments: ["image:kept"]}]);
    }
    await evaluate("reset('#astra');press();");
    await wait("records.length === 1");
    assert.equal(await evaluate("records[0].text"), "");
    // 模型单指令沿用非默认的当前强度；强度单指令沿用非默认模型。
    await evaluate("reset('#luna 保持强度');modelProps.reasoningEffort='high';trigger.setAttribute('data-selected-reasoning-effort','high');press();");
    await wait("records.length === 1");
    assert.equal(await evaluate("records[0].effort"), "high");
    await evaluate("reset('#m 保持模型');modelProps.model='gpt-6-astra';press();");
    await wait("records.length === 1");
    assert.equal(await evaluate("records[0].model"), "gpt-6-astra");
    await evaluate("reset('#luna-x 按钮提交');document.querySelector('#send').click();");
    await wait("records.length === 1");
    assert.equal(await evaluate("records[0].model"), "gpt-6-luna");
    await evaluate("reset('#astra-l\\n多段模型正文','paragraph',2);press();");
    await wait("records.length === 1");
    assert.equal(await evaluate("records[0].text"), "多段模型正文");
    for (const setup of [
      "modelProps.models=modelProps.models.filter(m=>m.model!=='gpt-6-astra')",
      "modelProps.models.find(m=>m.model==='gpt-6-astra').supportedReasoningEfforts=[]",
    ]) {
      await evaluate(`reset('#astra-l 不支持时保留');window.savedModels=modelProps.models;${setup};press();`);
      await wait("!!root.querySelector('[role=alert]')");
      assert.deepEqual(await evaluate("records"), []);
      assert.deepEqual(await evaluate("selections"), []);
      assert.equal(await evaluate("controller.view.state.doc.text"), "#astra-l 不支持时保留");
      await evaluate("modelProps.models=savedModels;modelProps.models.find(m=>m.model==='gpt-6-astra').supportedReasoningEfforts=['low','medium','high','xhigh'].map(reasoningEffort=>({reasoningEffort}));");
    }
    await evaluate("reset('#astra-l 原生失败');window.rejectSelection=true;press();");
    await wait("!!root.querySelector('[role=alert]')");
    assert.deepEqual(await evaluate("records"), []);
    assert.equal(await evaluate("controller.view.state.doc.text"), "#astra-l 原生失败");
    // 回调完成、强度已更新，但模型未提交时也不得发送。
    await evaluate("reset('#astra-l 模型未提交');window.neverCommitModel=true;press();");
    await new Promise(resolve => setTimeout(resolve, 5300));
    assert.match(await evaluate("root.querySelector('[role=alert]')?.textContent"), /超时/);
    assert.deepEqual(await evaluate("records"), []);
    assert.equal(await evaluate("controller.view.state.doc.text"), "#astra-l 模型未提交");
    await evaluate("reset('#x 点击发送');document.querySelector('#send').click();");
    await wait("records.length === 1");
    assert.equal(await evaluate("records[0].effort"), "xhigh");
    assert.equal(await evaluate("records[0].text"), "点击发送");
    // 独立 token 可以独占首段；删除段落边界，保留下一段正文。
    await evaluate("reset('#h\\n多段正文','paragraph',2);press();");
    await wait("records.length === 1");
    assert.equal(await evaluate("records[0].text"), "多段正文");
    for (const [text, type] of [["普通正文", "paragraph"], ["#hello", "paragraph"], ["正文 #h", "paragraph"],
      ["#H 大写", "paragraph"], ["#terra-h 未支持", "paragraph"], ["#sol-hash 非指令", "paragraph"], ["#SOL-h 大写", "paragraph"], ["#h 示例代码", "code_block"], ["#h 标题", "heading"]]) {
      await evaluate(`reset(${JSON.stringify(text)},${JSON.stringify(type)});press();`);
      assert.equal(await evaluate("records[0].text"), text);
      assert.deepEqual(await evaluate("selections"), []);
    }
    await evaluate("reset('#h 不应发送');press({shiftKey:true});press({isComposing:true});document.querySelector('#stop').click();");
    assert.deepEqual(await evaluate("records"), []);
    assert.deepEqual(await evaluate("selections"), []);
    await evaluate("reset('#h 快速连按');window.selectionDelay=100;press();press({repeat:true});document.querySelector('#send').click();");
    await wait("records.length === 1");
    assert.equal(await evaluate("selections.length"), 1);
    await evaluate("reset('#l 修改后的发送快捷键');window.enter='mod-enter';press();");
    assert.deepEqual(await evaluate("records"), []);
    await evaluate("press({metaKey:true})");
    await wait("records.length === 1");
    assert.equal(await evaluate("records[0].effort"), "low");
    await evaluate("window.enter='enter';reset('#h 保留草稿');window.rejectSelection=true;press();");
    await wait("!!root.querySelector('[role=alert]')");
    assert.deepEqual(await evaluate("records"), []);
    assert.equal(await evaluate("controller.view.state.doc.text"), "#h 保留草稿");
    await evaluate("reset('#h 禁用档位');modelProps.reasoningEffortDisabled=true;press();");
    await wait("!!root.querySelector('[role=alert]')");
    assert.deepEqual(await evaluate("selections"), []);
    assert.equal(await evaluate("controller.view.state.doc.text"), "#h 禁用档位");
    // 取消是永久的：离开再返回，或编辑后恢复同一文档，都不能恢复旧提交。
    for (const action of [
      "document.body.click();scope.conversationId='thread-b';setTimeout(()=>scope.conversationId='thread-a',30)",
      "input.dispatchEvent(new InputEvent('input',{bubbles:true}));",
      "scope.conversationId='thread-b';setTimeout(()=>scope.conversationId='thread-a',50)",
    ]) {
      await evaluate(`reset('#h 不应恢复旧提交');window.selectionDelay=100;press();${action};`);
      await new Promise(resolve => setTimeout(resolve, 180));
      assert.deepEqual(await evaluate("records"), []);
      assert.equal(await evaluate("controller.view.state.doc.text"), "#h 不应恢复旧提交");
    }
    await evaluate("reset('#h 原生调用不结束');window.hangSelection=true;press();");
    // 整个调用的五秒期限必须生效，而不是只限制调用返回后的 React 更新。
    await new Promise(resolve => setTimeout(resolve, 5300));
    assert.match(await evaluate("root.querySelector('[role=alert]')?.textContent"), /超时/);
    assert.equal(await evaluate("controller.view.state.doc.text"), "#h 原生调用不结束");
    assert.deepEqual(await evaluate("records"), []);
    await evaluate("reset('超时后普通消息');press();");
    assert.equal(await evaluate("records[0].text"), "超时后普通消息");
    for (const action of ["controller.view.state.doc=makeDoc('#h 用户改了草稿')", "scope.conversationId='thread-b'", "root.hidden=true", "window.__CODEX_PLUS_REASONING_PREFIX_CLEANUP__()"] ) {
      await evaluate(`reset('#h 不应异步误发');window.selectionDelay=80;press();${action};`);
      await new Promise(resolve => setTimeout(resolve, 150));
      assert.deepEqual(await evaluate("records"), []);
      assert.equal(await evaluate("controller.view.state.doc.text.startsWith('#h')"), true);
    }
    await evaluate("reset('#h 停用后透传');press();");
    assert.equal(await evaluate("records[0].text"), "#h 停用后透传");
    await evaluate(SOURCE);
    await evaluate(SOURCE);
    await evaluate("reset('#h 重复注入');press();");
    await wait("records.length === 1");
    assert.equal(await evaluate("selections.length"), 1);
  } finally {
    client?.close();
    if (browser.exitCode == null) {
      const exited = new Promise(resolve => browser.once("exit", resolve));
      browser.kill("SIGTERM");
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))]);
      if (browser.exitCode == null) browser.kill("SIGKILL");
    }
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
