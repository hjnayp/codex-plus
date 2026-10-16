import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test from "node:test";
import { CdpClient } from "../src/hosts/codex-desktop/cdp.ts";
import type { CdpTarget } from "../src/hosts/codex-desktop/cdp.ts";
import { PAGE_FEATURES } from "../src/hosts/codex-desktop/page/features.ts";
import { loadRenderers, readRendererSource } from "../src/hosts/codex-desktop/renderers.ts";

const SOURCE = await readRendererSource("pending-input");
const A = "01a0fb36-f37b-7a92-b140-ad266c115d0c";
const B = "01a0ff5e-3ea5-73d1-805a-7edba9e38d9b";
const turn = (turnId: string, items: object[], extra: object = {}) => ({ turnId, status: "inProgress", items, ...extra });
const question = (id: string, titles: string[]) => ({ type: "agentMessage", id, phase: "final_answer", questions: titles.map((title,index) => ({ title, options: index ? ["iPhone", "小程序"] : ["批准", "调整"] })) });
const prose = (id: string, text = "请批准新版规格。") => ({ type: "agentMessage", id, phase: "final_answer", text: `<!-- 等待回答 -->\n${text}` });
const answer = (id: string, index = 0) => ({ type: "steeringUserMessage", status: "accepted", input: [{ type: "text", text: `<send_user_message_question_reply>\n${JSON.stringify([{questionItemId:JSON.stringify(["request_user_input_async",id,index]),answer:"批准"}])}\n</send_user_message_question_reply>` }] });

test("待回答提示登记到实际注入和清理链", async () => {
  assert.ok(PAGE_FEATURES.some(({ id }) => id === "pending-input"));
  const renderers = await loadRenderers();
  assert.equal(renderers.sources.pendingInput, SOURCE);
  assert.match(renderers.cleanup, /__CODEX_PLUS_PENDING_INPUT_CLEANUP__/);
});

test("Chromium：有效提问、原生入口、回答、对话隔离、定位和停用", { timeout: 60000 }, async () => {
  const chrome = process.env.CODEX_PLUS_TEST_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  assert.ok(fs.existsSync(chrome));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "codex-pending-input-test-"));
  const nativeModule = `const fixtureQuestionState={};const fixtureQuestionIds={kind:'questionIds'};function fixturePending(get,e){return get(fixtureQuestionIds,e).some(n=>get(fixtureQuestionState,{...e,itemId:n})?.isSubmitting===true)}function arbitraryBundledName(e,t){let n=e.get(fixtureQuestionState,t);if(n==null)return;let r={hostId:t.hostId,threadId:t.threadId};e.set(null,t,{...n,deadlineMs:null});e.set(null,r,{selectedQuestionKey:t,questionIds:[t.itemId]})}export{arbitraryBundledName,fixtureQuestionState,fixtureQuestionIds,fixturePending};`;
  const server = http.createServer((request, response) => {
    if (request.url!.startsWith("/app-initial-")) {
      response.setHeader("Content-Type", "text/javascript");
      setTimeout(() => response.end(nativeModule), request.url!.includes("race") ? 300 : 0); return;
    }
    response.end(`<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:20px;font:14px system-ui;width:720px}.messages{height:1400px}main{position:fixed;bottom:20px;width:720px;background:#fff} [data-codex-composer]{height:90px;border:1px solid #ccc;border-radius:16px}
  </style></head><body><div class="messages"></div><main data-codex-composer-root><div data-above-composer-conversation-id="${A}"></div><div data-composer-rail-placement="above"><div id="native-goal">进行中的目标 · 验收页面</div></div><div><div contenteditable="true" data-codex-composer></div></div></main></body></html>`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const child = spawn(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${profile}`, `http://127.0.0.1:${(server.address() as AddressInfo).port}`], { stdio: "ignore" });
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
      for (let i = 0; i < 150; i++) {
        if (await evaluate(expression)) return;
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      assert.fail(`等待失败：${expression}`);
    };
    // Chrome 先以 about:blank 建立页面目标，等夹具页面本身加载完成后再布置。
    await wait("location.protocol === 'http:' && document.readyState === 'complete'");
    await evaluate(`window.installTurns=(threadId,turns,requests=[])=>{
      document.querySelector('.messages').replaceChildren();
      for(const turn of turns){const node=document.createElement('article');node.dataset.contentSearchTurnKey=turn.turnId;
        node.__reactProps$fixture={children:{props:{conversationId:threadId,hostId:'local',historyEntityKey:'entity:'+turn.turnId,turn,turnRequests:requests}}};
        node.textContent='original turn '+turn.turnId;
        node.scrollIntoView=()=>{window.locatedTurn=turn.turnId};document.querySelector('.messages').append(node)}
      document.querySelector('[data-above-composer-conversation-id]').dataset.aboveComposerConversationId=threadId;
      window.fixtureScope.value.conversationId=threadId;
    };
    window.openedQuestions=[];
    window.fixtureScope={node:{},chain:{},value:{conversationId:${JSON.stringify(A)}},get:(atom,key)=>{
      if(atom.kind==='questionIds'){window.initializedEntity=key.entityKey;return []}
      if(window.fixtureAbsent || window.needsInitialization && window.initializedEntity!==key.entityKey)return null;
      return {deadlineMs:123,lastSubmission:null,isSkipped:!!window.fixtureSkipped,isSubmitting:false}
    },set:(_atom,key,state)=>{
      if(!state.selectedQuestionKey)return;
      window.openedQuestions.push(state.selectedQuestionKey);
      const selected=state.selectedQuestionKey;
      const [_,source,index]=JSON.parse(selected.itemId);
      const article=[...document.querySelectorAll('article')].find(n=>'entity:'+n.__reactProps$fixture.children.props.turn.turnId===selected.entityKey);
      const q=article.__reactProps$fixture.children.props.turn.items.find(i=>i.id===source).questions[index];
      document.querySelector('#native-question')?.remove();
      const dialog=document.createElement('dialog');dialog.id='native-question';dialog.textContent=q.title;
      for(const option of q.options||[]){let b=document.createElement('button');b.textContent=option;dialog.append(b)}
      document.body.append(dialog);dialog.showModal();
    }};
    document.querySelector('main').__reactFiber$fixture={memoizedState:{memoizedState:{current:fixtureScope}}};
    const preload=document.createElement('link');preload.rel='modulepreload';preload.href='/app-initial-fixture.js';document.head.append(preload);
    window.text=()=>document.querySelector('.codex-plus-pending-input')?.textContent||'';
    window.count=()=>window.__CODEX_PLUS_PENDING_INPUT_STATUS__().count;`);
    const install = (turns: object[], threadId = A, requests: object[] = []) => evaluate(`installTurns(${JSON.stringify(threadId)},${JSON.stringify(turns)},${JSON.stringify(requests)})`);
    await install([turn("one", [question("q1", ["是否批准新版规格？"]), prose("m1")])]);
    assert.equal(await evaluate("text()"), "", "基线：原生目标区域不会自动显示待回答提醒");
    await evaluate(SOURCE);
    await wait("count()===1 && text().includes('是否批准新版规格？')");
    assert.equal(await evaluate("document.querySelector('.codex-plus-pending-input').nextElementSibling.contains(document.querySelector('#native-goal'))"), true);
    await evaluate("document.querySelector('.codex-plus-pending-input-summary').click()");
    await evaluate("document.querySelector('.codex-plus-pending-input-list button').click()");
    await wait("document.querySelector('#native-question')?.open");
    assert.deepEqual(await evaluate("openedQuestions.at(-1)"), {hostId:"local",threadId:A,entityKey:"entity:one",itemId:'["request_user_input_async","q1",0]'});
    assert.deepEqual(await evaluate("[...document.querySelectorAll('#native-question button')].map(n=>n.textContent)"), ["批准","调整"]);
    await evaluate("document.querySelector('#native-question').remove()");
    await install([turn("ended", [question("old", ["旧问题不应继续提醒"]), prose("old-prose")], {status:"completed"})]);
    await wait("count()===0");
    await install([turn("one", [question("q1", ["是否批准新版规格？"]), prose("m1")]), turn("heartbeat", [{type:"agentMessage",text:"继续验收其它页面。"}])]);
    await wait("count()===1");
    await install([turn("one", [question("q1", ["是否批准新版规格？"]), prose("m1"), answer("q1")])]);
    await wait("count()===0 && !text()");
    await install([turn("two", [question("q2", ["选择顶部对齐方式？", "选择设备？"])])]);
    await wait("count()===2");
    await evaluate("document.querySelector('.codex-plus-pending-input-summary').click()");
    assert.equal(await evaluate("document.querySelectorAll('.codex-plus-pending-input-list button').length"), 2);
    await evaluate("document.querySelector('[data-codex-composer]').textContent='尚未发送的草稿';document.querySelector('.codex-plus-pending-input-list button').click()");
    await wait("document.querySelector('#native-question')?.open");
    assert.deepEqual(await evaluate("[...document.querySelectorAll('#native-question button')].map(n=>n.textContent)"), ["iPhone","小程序"]);
    assert.equal(await evaluate("openedQuestions.at(-1).itemId"), '["request_user_input_async","q2",1]');
    await evaluate("document.querySelector('#native-question').remove();document.querySelectorAll('.codex-plus-pending-input-list button')[1].click()");
    await wait("document.querySelector('#native-question')?.open");
    assert.equal(await evaluate("openedQuestions.at(-1).itemId"), '["request_user_input_async","q2",0]');
    assert.equal(await evaluate("document.querySelector('[data-codex-composer]').textContent"),"尚未发送的草稿");
    await evaluate("document.querySelector('#native-question').remove()");
    await install([turn("two", [question("q2", ["选择顶部对齐方式？", "选择设备？"]), answer("q2", 0)])]);
    await wait("count()===1 && text().includes('选择设备？')");
    await evaluate(`document.querySelector('[data-above-composer-conversation-id]').dataset.aboveComposerConversationId=${JSON.stringify(B)}`);
    await wait("count()===0");
    await install([turn("three", [prose("m3"), {type:"agentMessage",text:"继续其它工作。"}])]);
    await wait("count()===0");
    await install([turn("three", [prose("m3")]), turn("auto", [{type:"userMessage",content:[{type:"text",text:"自动继续"}]}], {automationKind:"heartbeat"})]);
    await wait("count()===0");
    await install([turn("three", [prose("m3"), {type:"steeringUserMessage",status:"accepted",input:[{type:"text",text:"同意，继续。"}]}])]);
    await wait("count()===0");
    await install([turn("quoted", [{type:"agentMessage",phase:"final_answer",text:"```html\n<!-- 等待回答 -->\n```\n如何使用这个标记？"}])]);
    await wait("count()===0");
    for (const text of ["    <!-- 等待回答 -->\n\n这是代码示例。", "  ```html\n<!-- 等待回答 -->\n  ```", "~~~html\n<!-- 等待回答 -->\n~~~~", "```html\n<!-- 等待回答 -->"]) {
      await install([turn("code", [{type:"agentMessage",phase:"final_answer",text}])]);
      await new Promise(resolve=>setTimeout(resolve,300));
      assert.equal(await evaluate("count()"),0,"Markdown 代码示例不构成待回答信号");
    }
    await install([turn("native", [])], A, [{id:7,method:"item/tool/requestUserInput",params:{questions:[{question:"选择部署环境？"}]}}]);
    await wait("count()===1 && text().includes('选择部署环境？')");
    await evaluate("document.querySelector('.codex-plus-pending-input-summary').click();document.querySelector('.codex-plus-pending-input-list button').click()");
    assert.equal(await evaluate("locatedTurn"),"native");
    // Only React props change; no DOM mutation. The periodic refresh must see resolution.
    await evaluate("document.querySelector('[data-content-search-turn-key]').__reactProps$fixture.children.props.turnRequests=[]");
    await wait("count()===0");
    await install([turn("last", [question("q-last",["最后一个有效问题"])])]);
    await wait("count()===1");
    // Native loading happens before a row is shown. A click still yields before
    // opening, so a same-task route switch must invalidate it.
    await install([turn("race", [question("race-question", ["迟到点击"])] )]);
    await evaluate(SOURCE);
    await wait("count()===1");
    await evaluate(`window.beforeRace=openedQuestions.length;document.querySelector('.codex-plus-pending-input-summary').click();document.querySelector('.codex-plus-pending-input-list button').click();installTurns(${JSON.stringify(B)},[])`);
    await new Promise(resolve=>setTimeout(resolve,100));
    assert.equal(await evaluate("openedQuestions.length"),await evaluate("beforeRace"));
    await install([turn("skipped", [question("skipped-question", ["已跳过的问题"])] )]);
    await wait("count()===1");
    await evaluate("window.fixtureSkipped=true");
    await wait("count()===0");
    await evaluate("window.fixtureSkipped=false");
    await install([turn("no-state", [question("absent-question", ["原生状态不可用"])] )]);
    await wait("count()===1");
    await evaluate("window.fixtureAbsent=true");
    await wait("count()===0");
    assert.equal(await evaluate("openedQuestions.length"),await evaluate("beforeRace"));
    await evaluate("window.fixtureAbsent=false");
    await evaluate("window.needsInitialization=true;window.initializedEntity=null");
    await install([turn("steered-entity", [question("entity-question", ["续接后的问题"])] )]);
    await wait("count()===1");
    assert.equal(await evaluate("initializedEntity"),"entity:steered-entity");
    await evaluate("window.needsInitialization=false");
    // Resolution can update only host props, before the periodic rendering runs.
    await install([turn("resolved", [question("resolved-question", ["已结束点击"])] )]);
    await wait("count()===1");
    await evaluate("document.querySelector('.codex-plus-pending-input-summary').click();document.querySelector('article').__reactProps$fixture.children.props.turn.status='completed';document.querySelector('.codex-plus-pending-input-list button').click()");
    await new Promise(resolve=>setTimeout(resolve,100));
    assert.equal(await evaluate("openedQuestions.length"),await evaluate("beforeRace"));
    await install([turn("last", [question("q-last",["最后一个有效问题"])])]);
    await wait("count()===1");
    await evaluate(SOURCE);
    await wait("document.querySelectorAll('.codex-plus-pending-input').length===1");
    await evaluate("window.beforeCleanup=openedQuestions.length;document.querySelector('.codex-plus-pending-input-summary').click();document.querySelector('.codex-plus-pending-input-list button').click();window.__CODEX_PLUS_PENDING_INPUT_CLEANUP__()");
    await new Promise(resolve=>setTimeout(resolve,100));
    assert.equal(await evaluate("openedQuestions.length"),await evaluate("beforeCleanup"));
    assert.deepEqual(await evaluate("({rows:document.querySelectorAll('.codex-plus-pending-input').length,styles:document.querySelectorAll('#codex-plus-pending-input-style').length,native:document.querySelector('#native-goal').textContent,status:typeof window.__CODEX_PLUS_PENDING_INPUT_STATUS__})"), {rows:0,styles:0,native:"进行中的目标 · 验收页面",status:"undefined"});
  } finally {
    client?.close(); child.kill("SIGTERM");
    await new Promise(resolve => server.close(resolve));
    await new Promise<void>(resolve => { if(child.exitCode!==null)resolve();else child.once("exit",resolve) });
    fs.rmSync(profile, {recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
});
