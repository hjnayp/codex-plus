import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { CdpClient } from "../src/hosts/codex-desktop/cdp.ts";
import type { CdpTarget } from "../src/hosts/codex-desktop/cdp.ts";
import { readRendererSource } from "../src/hosts/codex-desktop/renderers.ts";

// Explicitly opt in: this verifies the current Codex app's real worker and caches.
const port = process.env.CODEX_PLUS_NATIVE_CDP_PORT;
test("真实 Codex：外部分支切换与 Git 状态变化自动反映到 renderer", { skip: !port, timeout: 60000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-branch-native-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const source = await readRendererSource("project-branches");
  let client: CdpClient | undefined;
  let restoreRenderer = false;
  try {
    git("init", "-b", "original"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
    fs.writeFileSync(path.join(root, "tracked"), "initial"); git("add", "tracked"); git("commit", "-m", "initial");
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const target = targets.find((target: CdpTarget) => target.type === "page" && target.url === "app://-/index.html");
    assert.ok(target);
    client = new CdpClient(target.webSocketDebuggerUrl); await client.connect();
    const evaluate = async (expression: string) => {
      const result = await client!.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const wait = async (expression: string) => {
      for (let i = 0; i < 120; i++) {
        if (await evaluate(expression)) return;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.fail(`未自动刷新：${expression}`);
    };
    restoreRenderer = await evaluate("typeof window.__CODEX_PLUS_PROJECT_BRANCHES_CLEANUP__==='function'");
    await evaluate("window.__CODEX_PLUS_PROJECT_BRANCHES_CLEANUP__?.()");
    const pendingSubscriptions = `(async()=>{const url=[...document.querySelectorAll('link[rel=modulepreload]')].map(n=>n.href).find(url=>/app-shared/.test(url));const module=await import(url);const accessor=Object.values(module).find(value=>typeof value==='function'&&value.toString().includes('case\u0060computer-use\u0060')&&value.toString().includes('case\u0060git\u0060'));return [...accessor('git').pending.values()].filter(request=>request.method==='subscribe-live-query').length})()`;
    await new Promise(resolve => setTimeout(resolve, 200));
    const nativeSubscriptionCount = await evaluate(pendingSubscriptions);
    await evaluate(`(()=>{const row=document.createElement('div');row.id='codex-plus-native-branch-fixture';row.style.display='none';
      row.dataset.appActionSidebarProjectRow='';row.dataset.appActionSidebarProjectId='native-fixture';row.setAttribute('aria-labelledby','codex-plus-native-branch-label');
      row.innerHTML='<span id="codex-plus-native-branch-label"><span data-marquee-text>fixture</span></span>';
      row.__reactFiber$fixture={memoizedProps:{group:{projectId:'native-fixture',projectKind:'local',gitRepos:[{root:${JSON.stringify(root)}}]}}};
      document.body.append(row)})()`);
    await evaluate(source);
    const badge = "document.querySelector('#codex-plus-native-branch-fixture .codex-plus-project-branches-badge')";
    await wait(`${badge}?.textContent==='original' && ${badge}?.dataset.state==='clean'`);
    // No synthetic focus event: the production timer must observe native cache invalidation.
    git("checkout", "-b", "changed"); fs.writeFileSync(path.join(root, "tracked"), "changed"); fs.writeFileSync(path.join(root, "new"), "new");
    await wait(`${badge}?.textContent==='changed' && ${badge}?.dataset.state==='dirty'`);
    assert.match(await evaluate(`${badge}.getAttribute('aria-label')`), /未暂存 1 · 未跟踪 1/);
    git("add", "tracked", "new");
    await wait(`${badge}?.dataset.state==='staged'`);
    assert.match(await evaluate(`${badge}.getAttribute('aria-label')`), /已暂存 2 · 未暂存 0 · 未跟踪 0/);
    git("commit", "-m", "changed"); git("checkout", "--detach");
    await wait(`${badge}?.textContent==='HEAD' && ${badge}?.dataset.state==='clean'`);
    assert.match(await evaluate(`${badge}.getAttribute('aria-label')`), /游离 HEAD/);
    assert.equal(await evaluate(`(()=>{const badge=${badge};return parseFloat(getComputedStyle(badge.parentElement.parentElement).fontSize)-parseFloat(getComputedStyle(badge).fontSize)})()`), 2);
    assert.ok(await evaluate(pendingSubscriptions) > nativeSubscriptionCount, "真实订阅保持 pending 至取消");
    await evaluate("window.__CODEX_PLUS_PROJECT_BRANCHES_CLEANUP__?.()");
    await wait(`${pendingSubscriptions}.then(count=>count===${nativeSubscriptionCount})`);
    assert.equal(await evaluate("document.querySelectorAll('.codex-plus-project-branches,#codex-plus-project-branches-style').length"), 0);
  } finally {
    if (client) {
      try {
        await client.send("Runtime.evaluate", { expression: "window.__CODEX_PLUS_PROJECT_BRANCHES_CLEANUP__?.();document.getElementById('codex-plus-native-branch-fixture')?.remove()" });
        // Restore the feature only when it was already enabled before this test.
        if (restoreRenderer) await client.send("Runtime.evaluate", { expression: source });
      } finally { client.close(); }
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
