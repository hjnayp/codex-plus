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
import { readRendererSource } from "../src/hosts/codex-desktop/renderers.ts";

test("消息头像：左右布局、上传持久化、失败保留、重建与清理", { timeout: 30000 }, async t => {
  const chrome = process.env.CODEX_PLUS_TEST_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (!fs.existsSync(chrome)) return t.skip("本机未安装 Chrome");
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "codex-avatar-test-"));
  const server = http.createServer((req, res) => res.end(`<!doctype html><style>*{margin:0}body{margin:0}.flex{display:flex}.flex-col{flex-direction:column}.bubble{margin-left:auto;width:80px;height:50px}.scroll{height:360px;overflow:auto;padding:0 100px}.content{padding-top:80px;height:1200px}</style><div data-above-composer-conversation-id="a"></div><div class="scroll"><div class="content">
    <div data-local-conversation-user-anchor="true"><div class="bubble">你好</div></div>
    <div class="flex flex-col gap-0"><small>用时 5 秒</small><div data-local-conversation-final-assistant="true"><div data-response-annotation-conversation="a" data-response-annotation-target="b">回答内容</div></div></div></div></div>`));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const child = spawn(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${profile}`, `http://127.0.0.1:${(server.address() as AddressInfo).port}`], { stdio: "ignore" });
  let client: CdpClient | undefined, otherClient: CdpClient | undefined;
  try {
    let port;
    for (let i = 0; i < 100; i++) {
      try { port = Number(fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]); break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(port, "测试浏览器启动");
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    client = new CdpClient(targets.find((target: CdpTarget) => target.type === "page").webSocketDebuggerUrl);
    await client.connect();
    const evaluate = async (expression: string) => {
      const response = await client!.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      assert.equal(response.exceptionDetails, undefined, JSON.stringify(response.exceptionDetails));
      return response.result.value;
    };
    const source = await readRendererSource("message-avatars");
    for (let i=0;i<100;i++) {
      if (await evaluate("!!document.querySelector('[data-local-conversation-user-anchor]')")) break;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    const originalMessages = await evaluate(`['[data-local-conversation-user-anchor]','.gap-0'].map(s=>{const e=document.querySelector(s);return {html:e.outerHTML,rect:e.getBoundingClientRect().toJSON()}})`);
    await evaluate(source);
    await evaluate(`window.stored = role => new Promise((resolve,reject)=>{const r=indexedDB.open('codex-plus-message-avatars',1);r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result;const q=db.transaction('images').objectStore('images').get(role);q.onsuccess=()=>{resolve(q.result||null);db.close()};};});
      window.saveAvatar = async()=>{document.querySelector('dialog button:last-child').click();for(let i=0;i<100&&document.querySelector('dialog');i++)await new Promise(r=>setTimeout(r,20));};
      localStorage.setItem('app-existing-data','x'.repeat(5*1024*1024-1000));`);
    const count = () => evaluate("document.querySelectorAll('.codex-plus-message-avatar').length");
    assert.equal(await count(), 2, "每条消息恰好一个头像，嵌套标记不重复");
    const placements = await evaluate(`['assistant','user'].map(role=>{
      const h=document.querySelector(role==='assistant'?'.gap-0':'[data-local-conversation-user-anchor]'), b=document.querySelector('.codex-plus-message-avatar[data-role='+role+']');
      const r=h.getBoundingClientRect(), a=b.getBoundingClientRect();
      return {role,valid:role==='assistant'?a.right<r.left:a.left>r.right,host:r.toJSON(),avatar:a.toJSON(),hidden:b.hidden};
    })`);
    assert.deepEqual(placements.map((item: { valid: boolean }) => item.valid), [true, true], JSON.stringify(placements));
    assert.deepEqual(await evaluate(`['[data-local-conversation-user-anchor]','.gap-0'].map(s=>{const e=document.querySelector(s),c=e.cloneNode(true);c.style.removeProperty('anchor-name');if(!c.style.length)c.removeAttribute('style');return {html:c.outerHTML,rect:e.getBoundingClientRect().toJSON()}})`), originalMessages, "除定位锚点属性外，不改变消息 DOM、尺寸或位置");
    assert.equal(await evaluate(`(async()=>{const scroll=document.querySelector('.scroll'),host=document.querySelector('.gap-0'),avatar=document.querySelector('.codex-plus-message-avatar[data-role=assistant]');
      const raf=window.requestAnimationFrame;window.requestAnimationFrame=()=>0;
      try {const before=avatar.getBoundingClientRect().top;scroll.scrollTop=40;await new Promise(r=>setTimeout(r,60));
      const after=avatar.getBoundingClientRect().top;return Math.abs(before-after-40)<0.5 && Math.abs(after-host.getBoundingClientRect().top)<0.5;}
      finally {window.requestAnimationFrame=raf;scroll.scrollTop=0;await new Promise(r=>setTimeout(r,60));}})()`), true, "暂停 JS 帧回调后滚动仍同步，由浏览器原生定位");
    await evaluate(`window.groupContent=document.querySelector('.content');
      window.firstUser=document.querySelector('[data-local-conversation-user-anchor]');
      window.firstAssistant=document.querySelector('.gap-0');
      window.extraUser=document.createElement('div');extraUser.dataset.localConversationUserAnchor='true';extraUser.innerHTML='<div class="bubble">第二条用户消息</div>';
      window.extraAssistant=document.createElement('div');extraAssistant.dataset.localConversationFinalAssistant='true';extraAssistant.textContent='第二条 GPT 回复';
      window.nextUser=extraUser.cloneNode(true);nextUser.style.marginBlockStart='3px';
      groupContent.insertBefore(extraUser,firstAssistant);firstAssistant.after(extraAssistant);groupContent.append(nextUser);
      new Promise(r=>setTimeout(r,140));`);
    assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('.codex-plus-message-avatar'),b=>b.dataset.role)`), ["user","assistant","user"], "用户、用户、GPT、GPT、用户只显示三个组首头像");
    assert.deepEqual(await evaluate(`[firstUser,extraUser,firstAssistant,extraAssistant,nextUser].map(e=>getComputedStyle(e).marginBlockStart)`), ["0px","0px","0px","0px","3px"], "连续消息保留原有间距，包括已有的非零间距");
    assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('.bubble'),e=>{const r=e.getBoundingClientRect();return [r.width,r.height]})`), [[80,50],[80,50],[80,50]], "分组不改变气泡大小");
    assert.equal(await evaluate(`(()=>{const avatars=Array.from(document.querySelectorAll('.codex-plus-message-avatar'));
      return Math.abs(avatars[0].getBoundingClientRect().top-firstUser.getBoundingClientRect().top)<0.5 &&
        Math.abs(avatars[1].getBoundingClientRect().top-firstAssistant.getBoundingClientRect().top)<0.5 &&
        Math.abs(avatars[2].getBoundingClientRect().top-nextUser.getBoundingClientRect().top)<0.5})()`), true, "头像锚定每组第一条消息");
    await evaluate(`window.tailUser=extraUser.cloneNode(true);groupContent.append(tailUser);new Promise(r=>setTimeout(r,140))`);
    assert.equal(await count(), 3, "继续追加同角色消息不新增头像");
    await evaluate(`window.tailAssistant=extraAssistant.cloneNode(true);groupContent.append(tailAssistant);new Promise(r=>setTimeout(r,140))`);
    assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('.codex-plus-message-avatar'),b=>b.dataset.role)`), ["user","assistant","user","assistant"], "角色切换后重新显示头像");
    await evaluate(`extraUser.before(nextUser);new Promise(r=>setTimeout(r,140))`);
    assert.equal(await count(), 4, "移动消息节点后重新计算分组");
    assert.equal(await evaluate(`(()=>{const avatars=Array.from(document.querySelectorAll('.codex-plus-message-avatar'));
      return Math.abs(avatars.find(b=>b.dataset.role==='user').getBoundingClientRect().top-firstUser.getBoundingClientRect().top)<0.5})()`), true, "分组重算后旧组仍锚定首条");
    assert.equal(await evaluate(`(async()=>{const scroll=document.querySelector('.scroll');scroll.scrollTop=135;
      await new Promise(r=>setTimeout(r,80));
      const firstAvatar=Array.from(document.querySelectorAll('.codex-plus-message-avatar')).find(b=>b.dataset.role==='user');
      const valid=firstUser.getBoundingClientRect().bottom<=scroll.getBoundingClientRect().top &&
        nextUser.getBoundingClientRect().bottom>scroll.getBoundingClientRect().top &&
        firstAvatar.getBoundingClientRect().top<scroll.getBoundingClientRect().top;
      scroll.scrollTop=0;await new Promise(r=>setTimeout(r,80));return valid;})()`), true, "组首滚出可视区域不会把头像转移到后续消息");
    await evaluate(`firstUser.remove();new Promise(r=>setTimeout(r,140))`);
    assert.equal(await evaluate(`(()=>{const avatar=Array.from(document.querySelectorAll('.codex-plus-message-avatar')).find(b=>b.dataset.role==='user');
      return Math.abs(avatar.getBoundingClientRect().top-nextUser.getBoundingClientRect().top)<0.5})()`), true, "首条从 DOM 移除后为新的组首创建头像");
    await evaluate(`extraUser.remove();extraAssistant.remove();nextUser.remove();tailUser.remove();tailAssistant.remove();
      groupContent.prepend(firstUser);new Promise(r=>setTimeout(r,260))`);
    assert.equal(await count(), 2, "恢复原消息后不残留分组头像");
    const rebound = await evaluate(`window.avatarReplacementFrame=()=>new Promise(resolve=>requestAnimationFrame(()=>{
      window.reboundAvatar=document.querySelector('.codex-plus-message-avatar[data-role=assistant]');
      window.reboundImage=reboundAvatar.firstElementChild;
      const replacement=firstAssistant.cloneNode(true);
      replacement.style.removeProperty('anchor-name');
      if(!replacement.style.length)replacement.removeAttribute('style');
      firstAssistant.replaceWith(replacement);window.firstAssistant=replacement;
      requestAnimationFrame(()=>{
        const button=document.querySelector('.codex-plus-message-avatar[data-role=assistant]');
        const rect=button.getBoundingClientRect(),host=replacement.getBoundingClientRect();
        const hit=document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2);
        resolve({sameButton:button===reboundAvatar,sameImage:button.firstElementChild===reboundImage,
          aligned:Math.abs(rect.top-host.top)<0.5,visible:hit===button||button.contains(hit)});
      });
    }));avatarReplacementFrame()`);
    assert.deepEqual(rebound, { sameButton: true, sameImage: true, aligned: true, visible: true },
      "状态更新替换消息宿主后，下一帧头像可见并复用原节点");
    await evaluate("new Promise(r=>setTimeout(r,100))");
    assert.equal(await evaluate(`document.querySelector('.codex-plus-message-avatar[data-role=assistant]')===reboundAvatar
      && reboundAvatar.firstElementChild===reboundImage`), true, "重绑后保留既有头像图片，避免重建解码");
    await evaluate(`window.avatarGap=async(delay)=>{
      const button=document.querySelector('.codex-plus-message-avatar[data-role=assistant]');
      const image=button.firstElementChild,rect=button.getBoundingClientRect();
      const host=firstAssistant,parent=host.parentNode,next=host.nextSibling;
      const replacement=host.cloneNode(true);replacement.style.removeProperty('anchor-name');
      if(!replacement.style.length)replacement.removeAttribute('style');
      host.remove();let restored=false;
      const timer=setTimeout(()=>{parent.insertBefore(replacement,next);window.firstAssistant=replacement;restored=true;},delay);
      const frames=[];
      while(!restored){await new Promise(r=>requestAnimationFrame(r));
        if(restored)break;
        const a=button.getBoundingClientRect(),hit=document.elementFromPoint(a.left+a.width/2,a.top+a.height/2);
        frames.push(button.isConnected && (hit===button||button.contains(hit)) && Math.abs(a.top-rect.top)<0.5 && Math.abs(a.left-rect.left)<0.5);
      }
      clearTimeout(timer);await new Promise(r=>requestAnimationFrame(r));
      return {frames:frames.length,visible:frames.every(Boolean),sameButton:button===document.querySelector('.codex-plus-message-avatar[data-role=assistant]'),
        sameImage:button.firstElementChild===image,aligned:Math.abs(button.getBoundingClientRect().top-replacement.getBoundingClientRect().top)<0.5};
    };`);
    for(const delay of [50,100]) {
      const gap=await evaluate(`avatarGap(${delay})`);
      assert.ok(gap.frames>0, "实际检查空白期间绘制帧");
      assert.deepEqual({...gap,frames:undefined}, {frames:undefined,visible:true,sameButton:true,sameImage:true,aligned:true}, `${delay}ms 原生空白期间头像每帧可见，恢复后复用并对齐`);
    }
    await evaluate(`document.querySelector('[data-above-composer-conversation-id]').setAttribute('data-above-composer-conversation-id','client-new-thread:fixture');new Promise(r=>requestAnimationFrame(r))`);
    const promotion=await evaluate(`(async()=>{
      const gap=avatarGap(100);
      setTimeout(()=>document.querySelector('[data-above-composer-conversation-id]').setAttribute('data-above-composer-conversation-id','formal-fixture'),30);
      return await gap;
    })()`);
    assert.ok(promotion.frames>0 && promotion.visible && promotion.sameButton && promotion.sameImage && promotion.aligned,
      "新对话临时身份转正式身份期间头像保持可见并复用");
    assert.equal(await evaluate(`(()=>{
      const avatar=document.querySelector('.codex-plus-message-avatar[data-role=assistant]');
      const row=document.createElement('div');row.setAttribute('role','button');row.dataset.appActionSidebarThreadId='local:unopened-fixture';
      const pin=document.createElement('button');pin.setAttribute('aria-label','置顶聊天');row.append(pin);document.body.append(row);
      pin.click();const unchanged=avatar.isConnected;row.remove();return unchanged;
    })()`),true,"侧栏线程行内的置顶或菜单按钮不会被误判成切换对话");
    assert.equal(await evaluate(`(async()=>{
      const button=document.querySelector('.codex-plus-message-avatar[data-role=assistant]');
      const host=firstAssistant,parent=host.parentNode;host.remove();
      await new Promise(r=>setTimeout(r,260));const expired=!button.isConnected;
      parent.append(host);await new Promise(r=>requestAnimationFrame(r));
      return expired && button!==document.querySelector('.codex-plus-message-avatar[data-role=assistant]');
    })()`),true,"宿主超过 200ms 未恢复时清理，后续出现重新创建头像");
    assert.equal(await evaluate(`(async()=>{
      const button=document.querySelector('.codex-plus-message-avatar[data-role=assistant]');
      const host=firstAssistant,parent=host.parentNode;host.remove();
      await new Promise(r=>requestAnimationFrame(r));
      const row=document.createElement('button');row.dataset.appActionSidebarThreadId='local:other-fixture';document.body.append(row);row.click();
      const cleared=!button.isConnected;
      document.querySelector('[data-above-composer-conversation-id]').setAttribute('data-above-composer-conversation-id','other-fixture');parent.append(host);row.remove();
      await new Promise(r=>requestAnimationFrame(r));
      const next=document.querySelector('.codex-plus-message-avatar[data-role=assistant]');
      await new Promise(r=>setTimeout(r,240));
      return cleared && next!==button && next.isConnected;
    })()`),true,"明确切换对话立即清理冻结头像，旧计时器不会移除新对话头像");
    await evaluate(`window.hiddenComposer=document.createElement('div');hiddenComposer.dataset.aboveComposerConversationId='cached-hidden-fixture';hiddenComposer.hidden=true;document.body.prepend(hiddenComposer);`);
    await evaluate(source);
    assert.equal(await evaluate(`(()=>{
      const avatar=document.querySelector('.codex-plus-message-avatar[data-role=assistant]');
      const row=document.createElement('div');row.setAttribute('role','button');row.dataset.appActionSidebarThreadId='local:other-fixture';document.body.append(row);
      row.click();const connected=avatar.isConnected;row.remove();return connected;
    })()`),true,"隐藏的缓存对话排在 DOM 前面时，点击当前对话不会清空头像并卡住");
    await evaluate("hiddenComposer.remove()");
    await evaluate(`window.activePane=document.createElement('section');
      activePane.append(document.querySelector('[data-above-composer-conversation-id]'),document.querySelector('.scroll'));document.body.prepend(activePane);
      window.cachedPane=activePane.cloneNode(true);cachedPane.hidden=true;
      cachedPane.querySelector('[data-above-composer-conversation-id]').setAttribute('data-above-composer-conversation-id','cached-tab-fixture');
      cachedPane.querySelectorAll('[style]').forEach(e=>{e.style.removeProperty('anchor-name');if(!e.style.length)e.removeAttribute('style');});
      document.body.prepend(cachedPane);new Promise(r=>requestAnimationFrame(r));`);
    assert.equal(await count(),2,"隐藏缓存对话的消息不生成多余头像");
    assert.equal(await evaluate(`(async()=>{
      activePane.hidden=true;cachedPane.hidden=false;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
      const button=document.querySelector('.codex-plus-message-avatar[data-role=assistant]');
      return document.querySelectorAll('.codex-plus-message-avatar').length===2 && !activePane.querySelector('[style*=codex-plus-avatar]')
        && Math.abs(button.getBoundingClientRect().top-cachedPane.querySelector('.gap-0').getBoundingClientRect().top)<0.5;
    })()`),true,"缓存标签只改变 hidden 属性时重新读取会话、恢复头像并解绑隐藏宿主");
    assert.equal(await evaluate(`(async()=>{
      activePane.hidden=false;cachedPane.hidden=true;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
      const button=document.querySelector('.codex-plus-message-avatar[data-role=assistant]');
      return document.querySelectorAll('.codex-plus-message-avatar').length===2 && !cachedPane.querySelector('[style*=codex-plus-avatar]')
        && Math.abs(button.getBoundingClientRect().top-firstAssistant.getBoundingClientRect().top)<0.5;
    })()`),true,"切回已挂载的对话后头像继续显示");
    await evaluate("cachedPane.remove();activePane.replaceWith(...activePane.childNodes);new Promise(r=>requestAnimationFrame(r))");
    assert.equal(await evaluate(`(async()=>{
      const button=document.querySelector('.codex-plus-message-avatar[data-role=assistant]');
      const host=firstAssistant,parent=host.parentNode;host.remove();
      for(let i=0;i<6;i++){
        document.querySelector('[data-above-composer-conversation-id]').setAttribute('data-above-composer-conversation-id','other-fixture');
        await new Promise(r=>setTimeout(r,40));
      }
      const expired=!button.isConnected;parent.append(host);await new Promise(r=>requestAnimationFrame(r));return expired;
    })()`),true,"空白期间重复扫描不延长 200ms 期限");
    const clippedGap=await evaluate(`(async()=>{
      const scroll=document.querySelector('.scroll');scroll.scrollTop=260;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
      const button=document.querySelector('.codex-plus-message-avatar[data-role=assistant]');
      const rect=button.getBoundingClientRect(),clip=button.parentNode.style.clipPath;
      const host=firstAssistant,parent=host.parentNode;host.remove();await new Promise(r=>requestAnimationFrame(r));
      const frozen=button.getBoundingClientRect();
      const result={connected:button.isConnected,before:rect.toJSON(),after:frozen.toJSON(),clip,afterClip:button.parentNode.style.clipPath};
      parent.append(host);scroll.scrollTop=0;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return result;
    })()`);
    assert.ok(clippedGap.connected && clippedGap.after.bottom<=0 && Math.abs(clippedGap.after.top-clippedGap.before.top)<0.5 && clippedGap.afterClip===clippedGap.clip,
      `滚出视口的头像冻结时保留位置和裁剪，不跳回可视区域: ${JSON.stringify(clippedGap)}`);
    assert.equal(await evaluate(`new Promise(resolve=>{
      const writes=[];const observer=new MutationObserver(records=>writes.push(...records));
      observer.observe(document.querySelector('.codex-plus-message-avatar-layer'),
        {subtree:true,attributes:true,attributeFilter:['hidden','style']});
      window.dispatchEvent(new Event('resize'));
      requestAnimationFrame(()=>requestAnimationFrame(()=>{observer.disconnect();resolve(writes.length)}));
    })`), 0, "未改变视口时重复定位不写入相同的显隐和裁剪属性");
    await evaluate(`document.querySelector('[aria-label="设置 GPT 头像"]').click()`);
    assert.equal(await evaluate("document.querySelector('dialog').open"), true);
    assert.equal(await evaluate(`(()=>{const r=document.querySelector('dialog').getBoundingClientRect();return Math.abs(r.left+r.width/2-document.documentElement.clientWidth/2)<1 && Math.abs(r.top+r.height/2-innerHeight/2)<1})()`), true, "全局 margin reset 下弹窗仍居中");
    // Real browser File -> bitmap -> canvas -> IndexedDB; no image decoder mock.
    await evaluate(`window.upload = async (type='image/png', bad=false, size=0) => {
      const canvas=document.createElement('canvas'); canvas.width=320;canvas.height=160;
      const ctx=canvas.getContext('2d');ctx.fillStyle='red';ctx.fillRect(0,0,160,160);ctx.fillStyle='blue';ctx.fillRect(160,0,160,160);
      const blob=await new Promise(r=>canvas.toBlob(r,type));
      const file=new File([bad?'not an image':blob, new Uint8Array(size)],'avatar.png',{type});
      const transfer=new DataTransfer();transfer.items.add(file);
      const input=document.querySelector('dialog input');input.files=transfer.files;input.dispatchEvent(new Event('change'));
      for(let i=0;i<100 && input.disabled;i++)await new Promise(r=>setTimeout(r,20));
      return document.querySelector('[role=status]').textContent;
    };`);
    assert.match(await evaluate("upload()"), /拖动图片/);
    assert.equal(await evaluate("stored('assistant')"), null, "选图不自动覆盖头像");
    await evaluate(`const slider=document.querySelector('input[type=range]');slider.value='2';slider.dispatchEvent(new Event('input'));`);
    const cropRect = await evaluate("document.querySelector('dialog canvas').getBoundingClientRect().toJSON()");
    await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: cropRect.left + 240, y: cropRect.top + 140, button: "left", buttons: 1, clickCount: 1 });
    await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: cropRect.left + 40, y: cropRect.top + 140, button: "left", buttons: 1 });
    await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: cropRect.left + 40, y: cropRect.top + 140, button: "left", buttons: 0, clickCount: 1 });
    assert.deepEqual(await evaluate("Array.from(document.querySelector('dialog canvas').getContext('2d').getImageData(140,140,1,1).data)"), [0,0,255,255], "真实鼠标拖动后选中右侧蓝色区域");
    assert.deepEqual(await evaluate(`(()=>{const preview=document.querySelector('dialog canvas');return ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].map(key=>{const event=new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true});preview.dispatchEvent(event);return event.defaultPrevented;});})()`), [false,false,false,false], "头像方向键不再被拦截");
    assert.deepEqual(await evaluate("Array.from(document.querySelector('dialog canvas').getContext('2d').getImageData(140,140,1,1).data)"), [0,0,255,255], "已删除的方向键不会移动裁剪位置");
    await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: cropRect.left + 40, y: cropRect.top + 140, button: "left", buttons: 1, clickCount: 1 });
    await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: cropRect.left + 640, y: cropRect.top + 140, button: "left", buttons: 1 });
    await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: cropRect.left + 640, y: cropRect.top + 140, button: "left", buttons: 0, clickCount: 1 });
    assert.deepEqual(await evaluate("Array.from(document.querySelector('dialog canvas').getContext('2d').getImageData(140,140,1,1).data)"), [255,0,0,255], "缩放移动后选中左侧红色区域");
    await evaluate("saveAvatar()");
    const original = await evaluate("stored('assistant')");
    assert.ok(original.startsWith("data:image/png;base64,"));
    assert.deepEqual(await evaluate(`(async()=>{const img=await createImageBitmap(await (await fetch(await stored('assistant'))).blob());const c=document.createElement('canvas');c.width=c.height=256;c.getContext('2d').drawImage(img,0,0);img.close();return Array.from(c.getContext('2d').getImageData(128,128,1,1).data)})()`), [255,0,0,255], "保存结果与自定义裁剪预览一致，localStorage 接近满额也能保存");
    await evaluate(`document.querySelector('[aria-label="设置 GPT 头像"]').click()`);
    assert.match(await evaluate("upload('image/svg+xml')"), /请选择/);
    assert.match(await evaluate("upload('image/png',false,6*1024*1024)"), /拖动图片/, "超过 5 MB 的原图仍可上传并裁剪");
    assert.match(await evaluate("upload('image/png',true)"), /无法读取/);
    assert.equal(await evaluate("stored('assistant')"), original);
    for (const type of ["image/jpeg", "image/webp"]) {
      assert.match(await evaluate(`upload('${type}')`), /拖动图片/, `${type} 真实图片可解码裁剪`);
    }
    assert.match(await evaluate(`(async()=>{const bytes=Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'),c=>c.charCodeAt(0));
      const transfer=new DataTransfer();transfer.items.add(new File([bytes],'static.gif',{type:'image/gif'}));
      const input=document.querySelector('dialog input');input.files=transfer.files;input.dispatchEvent(new Event('change'));
      for(let i=0;i<100&&input.disabled;i++)await new Promise(r=>setTimeout(r,20));return document.querySelector('[role=status]').textContent;})()`), /拖动图片/, "真实 GIF 可解码为静态裁剪预览");
    await evaluate(`window.avatarNativeTransaction=IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction=function(...args){const transaction=avatarNativeTransaction.apply(this,args);
        if(args[1]==='readwrite')queueMicrotask(()=>transaction.abort());return transaction;};
      document.querySelector('dialog button:last-child').click();new Promise(r=>setTimeout(r,80))`);
    assert.match(await evaluate("document.querySelector('[role=status]').textContent"), /保存失败，原头像已保留/);
    assert.equal(await evaluate("stored('assistant')"), original, "真实 IndexedDB 事务中止不覆盖旧头像");
    await evaluate(`document.querySelector('dialog button').click();new Promise(r=>setTimeout(r,80))`);
    assert.match(await evaluate("document.querySelector('[role=status]').textContent"), /恢复失败/);
    assert.equal(await evaluate("stored('assistant')"), original, "恢复默认失败保留旧头像");
    await evaluate("IDBDatabase.prototype.transaction=avatarNativeTransaction");
    await evaluate("document.querySelector('dialog').dispatchEvent(new Event('cancel',{cancelable:true}))");
    assert.equal(await evaluate("document.querySelector('dialog')"), null);
    await evaluate(source);
    await evaluate("new Promise(r=>setTimeout(r,100))");
    assert.equal(await count(), 2);
    assert.equal(await evaluate("document.querySelector('.codex-plus-message-avatar[data-role=assistant] img').src"), original);
    assert.deepEqual(await evaluate("avatarReplacementFrame()"),
      { sameButton: true, sameImage: true, aligned: true, visible: true }, "自定义图片在消息宿主替换的下一帧继续显示，复用已解码图片");
    const customGap=await evaluate("avatarGap(100)");
    assert.ok(customGap.frames>0 && customGap.visible && customGap.sameButton && customGap.sameImage && customGap.aligned,
      "已上传头像在真实 100ms 空白期间每帧可见并复用已解码图片");
    await evaluate(`document.body.style.zoom='0.8';window.dispatchEvent(new Event('resize'));new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);
    const zoomedGap=await evaluate("avatarGap(100)");
    assert.ok(zoomedGap.frames>0 && zoomedGap.visible && zoomedGap.sameButton && zoomedGap.sameImage && zoomedGap.aligned,
      "缩放视图的冻结坐标与恢复位置保持一致");
    await evaluate(`document.body.style.removeProperty('zoom');window.dispatchEvent(new Event('resize'));new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);
    await evaluate(`document.querySelector('[data-local-conversation-user-anchor]').innerHTML='<div class="bubble">新消息</div>';
      document.querySelector('[data-local-conversation-final-assistant]').setAttribute('data-response-annotation-target','changed');
      new Promise(r=>setTimeout(r,160))`);
    assert.equal(await count(), 2, "React 重建子节点后恢复头像");
    await client.send("Emulation.setDeviceMetricsOverride", { width: 360, height: 640, deviceScaleFactor: 1, mobile: false });
    assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true, "窄窗口不产生横向滚动");
    const otherTarget = await client.send("Target.createTarget", { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
    const otherTargets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    otherClient = new CdpClient(otherTargets.find((target: CdpTarget) => target.id === otherTarget.targetId).webSocketDebuggerUrl);
    await otherClient.connect();
    const otherEvaluate = async (expression: string) => {
      const response = await otherClient!.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      assert.equal(response.exceptionDetails, undefined, JSON.stringify(response.exceptionDetails));
      return response.result.value;
    };
    for (let i=0;i<100;i++) {
      if (await otherEvaluate("!!document.querySelector('[data-local-conversation-user-anchor]')")) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    await otherEvaluate(source);
    await otherEvaluate("new Promise(r=>setTimeout(r,100))");
    await evaluate(`document.querySelector('[aria-label="设置我的头像"]').click()`);
    assert.match(await evaluate("upload()"), /拖动图片/);
    await evaluate(`saveAvatar()`);
    await otherEvaluate("new Promise(r=>setTimeout(r,100))");
    assert.equal(await otherEvaluate("document.querySelector('.codex-plus-message-avatar[data-role=user] img').src"), await evaluate("stored('user')"), "保存头像后另一真实窗口同步更新");
    await evaluate(`document.querySelector('[aria-label="设置我的头像"]').click()`);
    assert.equal(await evaluate("stored('user').then(Boolean)"), true);
    await evaluate(`document.querySelector('dialog button').click();new Promise(r=>setTimeout(r,100))`);
    assert.equal(await evaluate("stored('user')"), null);
    assert.equal(await evaluate("stored('assistant')"), original, "重置用户头像不改变 GPT 头像");
    await otherEvaluate("new Promise(r=>setTimeout(r,100))");
    assert.equal(await otherEvaluate("document.querySelector('.codex-plus-message-avatar[data-role=user] img')"), null, "恢复默认同步到另一窗口");
    await evaluate(`window.cleanupHost=document.querySelector('.gap-0');window.cleanupParent=cleanupHost.parentNode;
      cleanupHost.remove();new Promise(r=>setTimeout(r,20))`);
    await evaluate("window.__CODEX_PLUS_MESSAGE_AVATARS_CLEANUP__()");
    await evaluate("cleanupParent.append(cleanupHost);new Promise(r=>setTimeout(r,240))");
    assert.equal(await count(), 0);
    assert.equal(await evaluate("document.querySelector('[class*=codex-plus-message-avatar],#codex-plus-message-avatar-style')"), null);
    assert.equal(await evaluate("document.querySelector('[style*=anchor-name]')"), null, "停用恢复原有锚点属性");
    assert.equal(await evaluate("document.querySelector('[style*=margin-block-start]')"), null, "停用恢复原有消息间距");
    assert.equal(await evaluate("stored('assistant')"), original);
    await client.send("Page.reload");
    await new Promise(resolve => setTimeout(resolve, 250));
    await evaluate(source);
    await evaluate("new Promise(r=>setTimeout(r,100))");
    assert.equal(await evaluate("document.querySelector('.codex-plus-message-avatar[data-role=assistant] img').src"), original, "页面重载后保留头像");
  } finally {
    otherClient?.close();
    client?.close();
    const exit = new Promise(resolve => child.once("exit", resolve));
    child.kill("SIGTERM");
    await Promise.race([exit, new Promise(resolve => setTimeout(resolve, 2000))]);
    if (child.exitCode == null) { child.kill("SIGKILL"); await exit; }
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
