import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

const [manager, officialApp, reference, ca, cliCache, output, webCache] = process.argv.slice(2);
const reloadProbe = process.argv.includes("--probe-reload");
const held = [];
function finishHeld() {
  for (const entry of held) {
    if (entry.response.destroyed || entry.response.writableEnded) continue;
    entry.response.end(entry.tail);
  }
}
assert.ok(output && manager && officialApp && reference && ca && cliCache);
fs.mkdirSync(output, { recursive: true });
const root = path.join(os.homedir(), ".claude-mom-ui-lab");
const requests = [];
const upstream = http.createServer(async (req, res) => {
  if (req.url === "/reload-probe-page") {
    res.writeHead(200, { "content-type": "text/html" });
    return res.end("<!doctype html><title>Reload fixture</title><p>Owned reload fixture only</p>");
  }
  let raw = "";
  for await (const part of req) raw += part;
  if (req.url.startsWith("/v1/messages")) {
    const body = JSON.parse(raw);
    requests.push({ model: body.model, thinking: body.thinking, effort: body.output_config?.effort });
    const message = { id: "msg_ui_lab", type: "message", role: "assistant", model: body.model,
      content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } };
    const events = [
      { type: "message_start", message },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "UI_LAB_ROUTING_OK" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } },
      { type: "message_stop" },
    ];
    res.writeHead(200, { "content-type": "text/event-stream" });
    const wire = event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    if (reloadProbe && (body.model === "fixture/claude-sonnet-5-5" && raw.includes("UI_LAB_ROUTING") ||
        body.model === "fixture/claude-opus-5-5" && raw.includes("UI_LAB_CHAT_RELOAD"))) {
      const entry = { response: res, tail: events.slice(3).map(wire).join(""), aborted: false,
        kind: raw.includes("UI_LAB_CHAT_RELOAD") ? "chat" : "code" };
      held.push(entry);
      res.once("close", () => { if (!res.writableFinished) entry.aborted = true; });
      res.write(events.slice(0, 3).map(wire).join(""));
      return;
    }
    return res.end(events.map(wire).join(""));
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end("{}");
});
upstream.listen(0, "127.0.0.1");
await once(upstream, "listening");
const profiles = {
  profiles: [{ id: "fixture", name: "Isolated fixture", source: "manual", apiKey: "ui-lab-fixture-key-only",
    baseUrl: `http://127.0.0.1:${upstream.address().port}`, model: "fixture/claude-opus-5-5",
    smallModel: "fixture/claude-haiku-5-5", contextWindow: 1000000,
    models: ["fixture/claude-haiku-5-5", "fixture/claude-sonnet-5-5", "fixture/claude-opus-5-5", "fixture/claude-fable-5-2"] }],
  activeId: "fixture",
};
const upstreamFile = path.join(output, "fixture-upstreams.json");
fs.writeFileSync(upstreamFile, JSON.stringify(profiles), { mode: 0o600 });
execFileSync("python3", ["scripts/prepare-ui-lab.py", "--source", officialApp, "--reference", reference,
  "--ca", ca, "--upstreams", upstreamFile, "--cli-cache", cliCache,
  ...(webCache ? ["--web-cache", webCache] : [])], { stdio: "inherit" });
fs.unlinkSync(upstreamFile);
let managerOutput = "";
const child = spawn(path.join(manager, "Contents/MacOS/claude-mom"), ["--lab-run"], { stdio: ["pipe", "pipe", "pipe"] });
child.stdout.on("data", (data) => { managerOutput += data.toString(); });
child.stderr.on("data", (data) => { managerOutput += data.toString(); });
let control;
const result = { productionStateUsed: false, officialVersion: JSON.parse(fs.readFileSync(reference)).desktopVersion,
  referenceSHA256: crypto.createHash("sha256").update(fs.readFileSync(reference)).digest("hex"),
  checks: {}, requests, errors: [] };
async function rpc(route, data) {
  const response = await fetch(`http://127.0.0.1:${control.port}${route}`, {
    method: data ? "POST" : "GET", headers: { Authorization: `Bearer ${control.token}`, "content-type": "application/json" },
    ...(data ? { body: JSON.stringify(data) } : {}), signal: AbortSignal.timeout(15000),
  });
  const body = await response.json();
  if (!response.ok) throw Error(body.error || `Inspection HTTP ${response.status}`);
  return body;
}
async function frames() { return (await rpc("/status")).frames; }
async function evaluate(frame, expression) { return (await rpc("/evaluate", { id: frame.id, expression })).result; }
async function until(predicate, ms = 60000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    if (child.exitCode !== null) throw Error(`Lab manager stopped: ${managerOutput.slice(-4000)}`);
    try { const value = await predicate(); if (value) return value; } catch (error) { last = error; }
    await delay(500);
  }
  throw last || Error("Isolated UI wait timed out");
}
// Navigation can replace the renderer between observations. Resolve the owned
// frontend for each read instead of retaining a pre-navigation frame ID.
async function evaluateFrontend(expression) {
  return until(async () => {
    const frame = (await frames()).find(frame => frame.url.startsWith('https://claude.ai/epitaxy'));
    if (!frame) return false;
    const observed = await evaluate(frame, `(async()=>{
      if(document.readyState!=='complete'||!window['claude.web']?.LocalSessions)return null;
      return {value:await (${expression})};
    })()`);
    return observed ? { frame, value: observed.value } : false;
  });
}
async function clickText(text) {
  for (const frame of await frames()) {
    try {
      if (await evaluate(frame, `(() => { const wanted=${JSON.stringify(text)}; const e=[...document.querySelectorAll('button,a,[role="tab"],[role="button"]')].find(e => e.textContent.trim()===wanted || e.getAttribute('aria-label')===wanted || e.getAttribute('title')===wanted || wanted==='Code' && /(^|\\s)code(\\s|$)/i.test(e.getAttribute('aria-label') || e.getAttribute('title') || '')); if (!e) return false; e.click(); return true; })()`)) return frame;
    } catch {}
  }
  return null;
}
try {
  await until(() => {
    const file = path.join(root, "control.json");
    if (!fs.existsSync(file)) return false;
    control = JSON.parse(fs.readFileSync(file));
    return true;
  }, 60000);
  const ready = await until(() => {
    const file = path.join(root, "claude-local/ready.json");
    return fs.existsSync(file) && JSON.parse(fs.readFileSync(file));
  });
  const health = await (await fetch(`http://127.0.0.1:${ready.port}/__codex_claude_local/health`)).json();
  assert.ok(["installed", "web-cache"].includes(health.uiResources));
  result.resourceSource = health.uiResources;
  result.resourceBuildId = health.uiBuildId;
  assert.equal(health.desktopFeaturesSource, "official-reference");
  assert.equal(health.webFeaturesSource, "official-reference");
  assert.equal(health.modelSelectorsSource, "official-reference");
  result.checks.currentEvaluatedWebFeatures = true;
  result.checks.installedResourceProvenance = true;
  result.checks.sameVersionOfficialFeatures = true;
  const status = await rpc("/status");
  assert.ok(status.data.startsWith(root + path.sep));
  result.checks.isolatedUserData = true;
  await until(async () => {
    for (const frame of await frames()) {
      try { if (await evaluate(frame, "document.body?.innerText?.includes('Code') || !!document.querySelector('[aria-label=\"Code\"]') || [...document.querySelectorAll('button,a')].some(e => /code/i.test(e.getAttribute('aria-label') || e.getAttribute('title') || ''))")) return true; } catch {}
    }
    return false;
  });
  result.checks.codeEntryRendered = true;
  const clicked = await until(() => clickText("Code"), 30000);
  result.checks.codeNavigationClicked = !!clicked;
  assert.ok(clicked, "Click the actual native Code navigation control");
  await delay(3000);
  await clickText("UI Lab fixture");
  await delay(3000);
  const text = [];
  for (const frame of await frames()) {
    try {
      const body = await evaluate(frame, "document.body?.innerText?.slice(0,16000)");
      text.push({ url: frame.url, body });
      await rpc("/screenshot", { id: frame.id, name: `frame-${frame.contentsId}.png` });
    } catch {}
  }
  fs.writeFileSync(path.join(output, "ui-text.json"), JSON.stringify(text, null, 2));
  result.checks.fixtureVisible = text.some((frame) => frame.body?.includes("UI Lab fixture"));
  assert.equal(result.checks.fixtureVisible, true, "The isolated Desktop session fixture must be visible");
  const codeFrame = (await frames()).find((frame) => frame.url.startsWith("https://claude.ai/epitaxy"));
  const efforts = await evaluate(codeFrame, `(async () => {
    const d=await (await fetch('/api/model_selector/code')).json();
    return d.model_selector_config[0].models.find(m=>m.id==='fixture/claude-sonnet-5-5').thinking.effort_options.map(e=>e.id);
  })()`);
  assert.deepEqual(efforts.filter(effort => ["low", "medium", "high", "xhigh", "max"].includes(effort)),
    ["low", "medium", "high", "xhigh", "max"]);
  result.checks.officialCodeEffortCapabilities = efforts;
  // Choose a model through the native control, rather than relying on the
  // account rollout's default model during session adoption.
  await until(async () => {
    for (const frame of await frames()) {
      try {
        if (await evaluate(frame, `(() => {
          const button=[...document.querySelectorAll('button,[role="button"],[role="combobox"]')].find(e => /(?:Opus|Sonnet|Haiku|Fable) 5\\./.test(e.textContent) && e.getBoundingClientRect().width>20);
          if(!button)return false;button.click();return true;
        })()`)) return true;
      } catch {}
    }
    return false;
  }, 20000);
  await until(async () => {
    for (const frame of await frames()) {
      try {
        if (await evaluate(frame, `(() => {
          const option=[...document.querySelectorAll('[role="menuitem"],[role="menuitemradio"],[role="option"],button')].find(e => /Sonnet 5\\.5/.test(e.textContent) && e.getBoundingClientRect().width>20);
          if(!option)return false;option.click();return true;
        })()`)) return true;
      } catch {}
    }
    return false;
  }, 20000);
  result.checks.nativeSonnetSelected = true;
  let editorFrame;
  await until(async () => {
    for (const frame of await frames()) {
      try {
        const found = await evaluate(frame, `(() => {
          const e=[...document.querySelectorAll('textarea,[contenteditable="true"]')].find(e => e.getBoundingClientRect().width>20 && e.getBoundingClientRect().height>10);
          if(!e)return false; e.focus();
          if(e.tagName==='TEXTAREA') { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'UI_LAB_ROUTING');e.dispatchEvent(new Event('input',{bubbles:true})); }
          else document.execCommand('insertText',false,'UI_LAB_ROUTING');
          return true;
        })()`);
        if(found) { editorFrame=frame;return true; }
      } catch {}
    }
    return false;
  }, 30000);
  await evaluate(editorFrame, `(() => {
    const e=document.activeElement;
    const form=e.closest('form');
    if(form && typeof form.requestSubmit==='function') { form.requestSubmit();return 'form'; }
    const button=[...document.querySelectorAll('button')].find(e => !e.disabled && /^(send|send message|发送|发送消息)$/i.test(e.getAttribute('aria-label') || e.getAttribute('title') || e.textContent.trim()));
    if(button) { button.click();return 'button'; }
    e.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true}));return 'enter';
  })()`);
  await until(async () => {
    if (requests.length) return true;
    for (const frame of await frames()) {
      try {
        const trusted = await evaluate(frame, `(() => {
          const expected=${JSON.stringify(path.join(root, "scratch"))};
          const body=document.body.innerText;
          if(!body.includes(expected) || !/(Trust this workspace|信任此工作区)/i.test(body))return false;
          const dialog=[...document.querySelectorAll('[role="dialog"],[role="alertdialog"],dialog')].find(e => e.innerText.includes(expected)) || document;
          const button=[...dialog.querySelectorAll('button')].find(e => /^(Trust workspace|信任工作区)$/i.test(e.textContent.trim()));
          if(!button)return false;button.click();return true;
        })()`);
        if(trusted) result.checks.isolatedScratchExplicitlyTrusted = true;
      } catch {}
    }
    return false;
  }, 90000);
  assert.ok(requests.every((request) => profiles.profiles[0].models.includes(request.model)));
  assert.ok(requests.some((request) => request.model === "fixture/claude-sonnet-5-5"),
    "The resumed native Sonnet model must not silently become the default Opus route");
  result.checks.nativeCodeUsesConfiguredGateway = true;
  if (reloadProbe) {
    const sessionId = "local_11111111-1111-4111-8111-111111111112";
    const previewId = "preview-" + sessionId;
    const query = expression => evaluate(codeFrame, expression);
    const codeEntry = await until(() => held.find(entry => entry.kind === "code"));
    await until(async () => (await query(`window['claude.web'].LocalSessions.getSession(${JSON.stringify(sessionId)})`))?.isRunning);
    let preview = null;
    try {
      preview = await until(() => query(`window['claude.web'].Launch.startBrowserPreview(${JSON.stringify(path.join(root, "scratch"))},${JSON.stringify(sessionId)})`), 20000);
    } catch { result.browserFixtureDiagnostics = await rpc('/runtime-diagnostics'); }
    result.checks.browserFixtureAvailable = preview === previewId;
    for (let i = 0; preview === previewId && i < 2; i++) {
      const tab = await query(`window['claude.web'].Launch.openPreviewTab(${JSON.stringify(previewId)},${JSON.stringify(path.join(root, "scratch"))})`);
      assert.equal(typeof tab, "string");
      await query(`window['claude.web'].Launch.navigatePreview(${JSON.stringify(previewId)},${JSON.stringify(`http://127.0.0.1:${upstream.address().port}/reload-probe-page`)},${JSON.stringify(tab)})`);
    }
    const beforeTabs = preview === previewId ? await query(`window['claude.web'].Launch.getPreviewTabs(${JSON.stringify(previewId)})`) : null;
    const draft = "UI_LAB_UNSENT_DRAFT";
    const draftSet = await query(`(() => {
      const e=[...document.querySelectorAll('textarea,[contenteditable="true"]')].find(e=>e.getBoundingClientRect().width>20);
      if(!e)return false;e.focus();
      if(e.tagName==='TEXTAREA'){Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(draft)});e.dispatchEvent(new Event('input',{bubbles:true}));}
      else document.execCommand('insertText',false,${JSON.stringify(draft)});
      return true;
    })()`);
    assert.equal(draftSet, true);
    await delay(1500);
    const requestCount = held.filter(entry => entry.kind === 'code').length;
    result.reload = { code: { runningBefore: true, setupComplete: true, tabsBefore: beforeTabs?.tabs?.length } };
    await rpc("/reload-frontend", { id: codeFrame.id });
    await delay(5000);
    const after = (await evaluateFrontend(`(async()=>({
      session:await window['claude.web'].LocalSessions.getSession(${JSON.stringify(sessionId)}),
      tabs:${preview === previewId ? `await window['claude.web'].Launch.getPreviewTabs(${JSON.stringify(previewId)})` : 'null'},
      draftPreserved:[...document.querySelectorAll('textarea,[contenteditable="true"]')].some(e=>(e.value||e.innerText||'').includes(${JSON.stringify(draft)}))
    }))()`)).value;
    const afterSession = after.session, afterTabs = after.tabs, draftPreserved = after.draftPreserved;
    const ids = value => (value?.tabs || []).map(tab => tab.tabId).sort();
    result.reload = { desktopPidUnchanged: (await rpc('/status')).pid===control.pid,
      code: { runningBefore: true, runningAfter: afterSession?.isRunning===true,
        upstreamAborted: codeEntry.aborted, extraRequests: held.filter(entry => entry.kind === 'code').length-requestCount,
        tabsBefore: ids(beforeTabs), tabsAfter: ids(afterTabs), draftPreserved } };
    result.reload.code.tabsPreserved = beforeTabs === null ? null : JSON.stringify(ids(beforeTabs))===JSON.stringify(ids(afterTabs));
    finishHeld();
    await until(async () => !(await evaluateFrontend(`window['claude.web'].LocalSessions.getSession(${JSON.stringify(sessionId)})`)).value?.isRunning);
    result.reload.code.finishedAfterRelease = true;
    // A renderer-owned completion uses the same request lifetime as Chat,
    // without sending anything to a real provider or altering live chats.
    const conv=crypto.randomUUID();
    await evaluateFrontend(`(async()=>{
      await fetch('/api/organizations/local/chat_conversations',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({uuid:${JSON.stringify(conv)}})});
      window.__chatReloadProbe=fetch('/api/organizations/local/chat_conversations/${conv}/completion',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({prompt:'UI_LAB_CHAT_RELOAD',turn_message_uuids:{human_message_uuid:crypto.randomUUID(),assistant_message_uuid:crypto.randomUUID()}})}).then(async r=>{const reader=r.body.getReader();while(!(await reader.read()).done){} }).catch(()=>{});
      return true;
    })()`);
    const chatEntry = await until(() => held.find(entry=>entry.kind==='chat'));
    const chatFrame = (await evaluateFrontend('true')).frame;
    await rpc('/reload-frontend', {id:chatFrame.id});
    await delay(5000);
    result.reload.rendererOwnedChat = { upstreamAborted: chatEntry.aborted,
      scope: 'renderer-owned REST completion, not a Cowork VM execution' };
    result.checks.reloadProbeExecuted = true;
    finishHeld();
  } else await until(async () => {
    for (const frame of await frames()) {
      try { if(await evaluate(frame, "document.body?.innerText?.includes('UI_LAB_ROUTING_OK')")) return true; } catch {}
    }
    return false;
  }, 45000);
  if (!reloadProbe) result.checks.nativeCodeReplyRendered = true;
  // The manager's copied resource file and captured screenshots are the native
  // UI check. Payload preservation is covered independently by runtime CI.
  for (const file of fs.readdirSync(root).filter((file) => /^frame-\d+\.png$/.test(file))) {
    fs.copyFileSync(path.join(root, file), path.join(output, file));
  }
} catch (error) {
  result.errors.push(error.stack || String(error));
  process.exitCode = 1;
} finally {
  if (reloadProbe) result.heldStreamObservations = held.map(entry => ({ kind: entry.kind, aborted: entry.aborted,
    finished: entry.response.writableFinished }));
  finishHeld();
  if (control) {
    try {
      const current = await frames();
      result.finalFrames = current;
      result.frameDiagnostics = [];
      for (const frame of current) {
        try {
          result.frameDiagnostics.push({ url: frame.url, ui: await evaluate(frame,
            "({text:document.body?.innerText?.slice(0,12000), controls:[...document.querySelectorAll('button,a,[role=tab]')].slice(0,80).map(e=>({text:e.textContent?.trim().slice(0,100),label:e.getAttribute('aria-label'),title:e.getAttribute('title')}))})") });
          await rpc("/screenshot", { id: frame.id, name: `final-${frame.contentsId}.png` });
          fs.copyFileSync(path.join(root, `final-${frame.contentsId}.png`), path.join(output, `final-${frame.contentsId}.png`));
        } catch {}
      }
    } catch {}
  }
  fs.writeFileSync(path.join(output, "native-results.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(output, "manager-output.txt"), managerOutput);
  for (const name of ["desktop.log", "logs/main.log", "logs/renderer.log"]) {
    const file=path.join(root,name);
    if(fs.existsSync(file)) fs.writeFileSync(path.join(output,path.basename(name)),fs.readFileSync(file).subarray(-40000));
  }
  child.stdin.end();
  await Promise.race([once(child, "exit"), delay(10000)]);
  if (child.exitCode === null) child.kill("SIGTERM");
  upstream.closeAllConnections();
  upstream.close();
}
