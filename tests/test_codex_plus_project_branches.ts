import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { CdpClient } from "../src/hosts/codex-desktop/cdp.ts";
import type { CdpTarget } from "../src/hosts/codex-desktop/cdp.ts";
import { PAGE_FEATURES } from "../src/hosts/codex-desktop/page/features.ts";
import { loadRenderers, readRendererSource } from "../src/hosts/codex-desktop/renderers.ts";

const source = await readRendererSource("project-branches");
test("项目分支登记到打包、注入和清理链", async () => {
  assert.ok(PAGE_FEATURES.some(({ id }) => id === "project-branches"));
  const renderers = await loadRenderers();
  assert.equal(renderers.sources.projectBranches, source);
  assert.match(renderers.cleanup, /__CODEX_PLUS_PROJECT_BRANCHES_CLEANUP__/);
});

test("Chromium：项目归属、Git 默认颜色、刷新、失败、竞态和清理", { timeout: 60000 }, async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "codex-project-branches-"));
  // Match the native worker accessor and exported host atom discovery boundary.
  const nativeModule = `const hostAtom={};function init(){hostAtom=factory(state,(id,{get:g})=>{let cfg=g(id,\`host_config\`);return cfg})}
  const listeners=new Map();const worker={subscribe:(type,cb)=>{const set=listeners.get(type)||new Set();listeners.set(type,set);set.add(cb);return ()=>set.delete(cb)},request:async({method,params,signal})=>{window.calls.push({method,params});
    if(method==='subscribe-live-query')return new Promise((_,reject)=>{setTimeout(()=>{if(!signal.aborted)for(const cb of listeners.get('git-live-query-updated')||[])cb({subscriptionId:params.subscriptionId,phase:'complete',result:{type:'success'}})},0);signal.addEventListener('abort',()=>{window.aborted++;reject(Error('Aborted'))},{once:true})});
    await new Promise((resolve,reject)=>{const timer=setTimeout(resolve,window.delay||0);
      signal.addEventListener('abort',()=>{clearTimeout(timer);window.aborted++;reject(Error('Aborted'))},{once:true})});
    const fixture=window.results[params.root||params.cwd];if(fixture.error)throw Error(fixture.error);
    return method==='current-branch'?fixture.branch:fixture.status}};
  function accessor(id){switch(id){case\`computer-use\`:return null;case\`git\`:return worker}}
  export{accessor,hostAtom};`;
  const server = http.createServer((request, response) => {
    if (request.url!.startsWith("/app-shared-")) {
      response.setHeader("Content-Type", "text/javascript");
      if (request.url!.includes("stall")) setTimeout(() => response.end(nativeModule), 9000);
      else response.end(nativeModule);
      return;
    }
    response.end(`<!doctype html><meta charset="utf-8"><link rel="modulepreload" href="/app-shared-fixture.js"><style>body{font:14px system-ui}aside{width:260px}.row{display:flex}.label{display:flex;min-width:0;flex:1}.label>[data-marquee-text]{overflow:hidden;white-space:nowrap}</style><aside></aside>`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const chrome = process.env.CODEX_PLUS_TEST_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const child = spawn(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${profile}`, `http://127.0.0.1:${(server.address() as AddressInfo).port}`], { stdio: "ignore" });
  let client: CdpClient | undefined;
  try {
    let port;
    for (let i = 0; i < 100 && !port; i++) {
      try { port = Number(fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]); } catch {}
      if (!port) await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(port, "Chromium 启动");
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    client = new CdpClient(targets.find((target: CdpTarget) => target.type === "page").webSocketDebuggerUrl);
    await client.connect();
    const evaluate = async (expression: string) => {
      const result = await client!.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const wait = async (expression: string) => {
      for (let i = 0; i < 350; i++) {
        if (await evaluate(expression)) return;
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      assert.fail(`等待失败：${expression}`);
    };
    await wait("document.readyState==='complete'");
    await evaluate(`window.results={};window.calls=[];window.aborted=0;window.clicked=0;
      window.add=(id,roots,kind='local',hostId='local')=>{
        const row=document.createElement('div');row.className='row';row.dataset.appActionSidebarProjectRow='';row.dataset.appActionSidebarProjectId=id;row.setAttribute('aria-labelledby','label-'+id);
        row.innerHTML='<span class="label" id="label-'+id+'"><span data-marquee-text>project-'+id+'</span></span><button>操作</button>';
        row.querySelector('button').onclick=()=>window.clicked++;
        row.__reactFiber$fixture={memoizedProps:{group:{projectId:id,projectKind:kind,hostId,gitRepos:roots.map(root=>({root}))}},memoizedState:{memoizedState:{current:{node:{},chain:{},get:(_atom,id)=>({id,ssh:id==='remote'?{hostname:'fixture-host'}:undefined})}}}};
        document.querySelector('aside').append(row);return row;
      };
      window.view=id=>[...document.querySelector('#label-'+id).querySelectorAll('.codex-plus-project-branches-badge')].map(n=>({text:n.textContent,state:n.dataset.state,description:n.getAttribute('aria-label'),color:getComputedStyle(n).color}));
      window.wake=()=>window.dispatchEvent(new Event('focus'));
      for(const [root,branch,stagedCount,unstagedCount,untrackedCount] of [['/clean','main',0,0,0],['/staged','feature',2,0,0],['/dirty','fix',1,1,0],['/new','main',0,0,1],['/remote','remote-branch',0,0,0]])results[root]={branch:{branch,isDetached:false},status:{type:'success',stagedCount,unstagedCount,untrackedCount}};
      add('clean',['/clean']);add('staged',['/staged']);add('dirty',['/dirty']);add('new',['/new']);add('nongit',[]);add('remote',['/remote'],'remote','remote');add('multi',['/clean','/dirty']);`);
    assert.equal(await evaluate("view('clean').length"), 0, "原生基线没有分支标签");
    await evaluate(source);
    await wait("view('multi').length===2 && view('remote').length===1");
    assert.equal((await evaluate("view('clean')"))[0].state, "clean");
    assert.equal((await evaluate("view('staged')"))[0].state, "staged");
    assert.equal((await evaluate("view('dirty')"))[0].state, "dirty");
    assert.equal((await evaluate("view('new')"))[0].state, "dirty");
    assert.equal(await evaluate("view('nongit').length"), 0);
    assert.equal(await evaluate("document.querySelectorAll('.codex-plus-project-branches-badge[title]').length"), 0);
    assert.equal(await evaluate("view('clean')[0].color===view('staged')[0].color"), true);
    assert.equal(await evaluate("view('dirty')[0].color===view('new')[0].color && view('clean')[0].color!==view('dirty')[0].color"), true);
    assert.equal(await evaluate("calls.find(c=>c.params.root==='/remote').params.hostConfig.ssh.hostname"), "fixture-host");
    assert.match((await evaluate("view('dirty')"))[0].description, /已暂存 1 · 未暂存 1 · 未跟踪 0/);
    await evaluate("results['/clean'].branch={branch:null,isDetached:true};wake()");
    await wait("view('clean')[0]?.text==='HEAD'");
    assert.match((await evaluate("view('clean')"))[0].description, /游离 HEAD/);
    await evaluate("results['/staged'].branch.branch='feat/1012/登录优化';wake()");
    await wait("view('staged')[0]?.text==='登录优化'");
    assert.match((await evaluate("view('staged')"))[0].description, /feat\/1012\/登录优化/);
    await evaluate("results['/staged'].branch.branch='refactor/1008/分级优化';wake()");
    await wait("view('staged')[0]?.text==='分级优化'");
    assert.match((await evaluate("view('staged')"))[0].description, /refactor\/1008\/分级优化/);
    await evaluate("results['/staged'].branch.branch='feat/1012';wake()");
    await wait("view('staged')[0]?.text==='1012'");
    await evaluate("results['/staged'].branch.branch='feature/team/nested/登录优化';wake()");
    await wait("view('staged')[0]?.text==='登录优化'");
    assert.match((await evaluate("view('staged')"))[0].description, /feature\/team\/nested\/登录优化/);
    await evaluate("results['/staged'].branch.branch='new-branch';wake()");
    await wait("view('staged')[0]?.text==='new-branch'");
    await evaluate("results['/dirty'].error='读取失败';wake()");
    await wait("view('dirty')[0]?.state==='unknown'");
    assert.match((await evaluate("view('dirty')"))[0].description, /读取失败/);
    await evaluate("delete results['/dirty'].error;wake()");
    await wait("view('dirty')[0]?.state==='dirty'");
    // An unborn branch is a named branch even with zero commits.
    await evaluate("results['/clean'].branch={branch:'unborn',isDetached:false};wake()");
    await wait("view('clean')[0]?.text==='unborn'");
    await evaluate("document.querySelector('[data-app-action-sidebar-project-id=clean] button').click()");
    assert.equal(await evaluate("clicked"), 1, "标签不接管原生操作");
    // Worktree/project identity can change while an old response is in flight.
    await evaluate("delay=200;wake()");
    await new Promise(resolve => setTimeout(resolve, 50));
    await evaluate("document.querySelector('[data-app-action-sidebar-project-id=clean]').remove()");
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(await evaluate("document.querySelector('#label-clean')"), null);
    await evaluate(source);
    await wait("view('staged').length===1");
    assert.equal(await evaluate("document.querySelectorAll('#codex-plus-project-branches-style').length"), 1);
    await evaluate("wake()");
    await new Promise(resolve => setTimeout(resolve, 50));
    const before = await evaluate("calls.length");
    await evaluate("__CODEX_PLUS_PROJECT_BRANCHES_CLEANUP__()");
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.equal(await evaluate("document.querySelectorAll('.codex-plus-project-branches').length"), 0);
    assert.equal(await evaluate("document.querySelectorAll('[data-codex-plus-project-branches-host]').length"), 0);
    assert.equal(await evaluate("calls.length"), before, "停用后不再查询");
    assert.ok(await evaluate("aborted>0"), "停用取消在途请求");
    // Module loading must also have a deadline; a hung import cannot lock all future reads.
    await evaluate("delay=0;document.querySelector('link[rel=modulepreload]').href='/app-shared-stall.js'");
    await evaluate(source);
    await wait("view('staged')[0]?.state==='unknown'");
    assert.match((await evaluate("view('staged')"))[0].description, /加载超时/);
    await evaluate("document.querySelector('link[rel=modulepreload]').href='/app-shared-fixture.js';wake()");
    await wait("view('staged')[0]?.text==='new-branch'");
    await evaluate("__CODEX_PLUS_PROJECT_BRANCHES_CLEANUP__()");
  } finally {
    client?.close(); child.kill("SIGTERM");
    await new Promise(resolve => child.once("exit", resolve));
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
