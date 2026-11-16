import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

const [manager, officialApp, reference, ca, cliCache, output] = process.argv.slice(2);
assert.ok(output && manager && officialApp && reference && ca && cliCache);
fs.mkdirSync(output, { recursive: true });
const root = path.join(os.homedir(), ".claude-mom-ui-lab");
const requests = [];
const upstream = http.createServer(async (req, res) => {
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
    return res.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
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
  "--ca", ca, "--upstreams", upstreamFile, "--cli-cache", cliCache], { stdio: "inherit" });
fs.unlinkSync(upstreamFile);
let managerOutput = "";
const child = spawn(path.join(manager, "Contents/MacOS/claude-mom"), ["--lab-run"], { stdio: ["pipe", "pipe", "pipe"] });
child.stdout.on("data", (data) => { managerOutput += data.toString(); });
child.stderr.on("data", (data) => { managerOutput += data.toString(); });
let control;
const result = { productionStateUsed: false, officialVersion: JSON.parse(fs.readFileSync(reference)).desktopVersion,
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
async function clickText(text) {
  for (const frame of await frames()) {
    try {
      if (await evaluate(frame, `(() => { const wanted=${JSON.stringify(text)}; const e=[...document.querySelectorAll('button,a,[role="tab"],[role="button"]')].find(e => e.textContent.trim()===wanted || e.getAttribute('aria-label')===wanted); if (!e) return false; e.click(); return true; })()`)) return frame;
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
  assert.equal(health.uiResources, "installed");
  assert.equal(health.desktopFeaturesSource, "official-reference");
  result.checks.installedResourceProvenance = true;
  result.checks.sameVersionOfficialFeatures = true;
  const status = await rpc("/status");
  assert.ok(status.data.startsWith(root + path.sep));
  result.checks.isolatedUserData = true;
  await until(async () => {
    for (const frame of await frames()) {
      try { if (await evaluate(frame, "document.body?.innerText?.includes('Code')")) return true; } catch {}
    }
    return false;
  });
  result.checks.codeEntryRendered = true;
  const clicked = await clickText("Code");
  result.checks.codeNavigationClicked = !!clicked;
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
  // The manager's copied resource file and captured screenshots are the native
  // UI check. Payload preservation is covered independently by runtime CI.
  for (const file of fs.readdirSync(root).filter((file) => /^frame-\d+\.png$/.test(file))) {
    fs.copyFileSync(path.join(root, file), path.join(output, file));
  }
} catch (error) {
  result.errors.push(error.stack || String(error));
  process.exitCode = 1;
} finally {
  if (control) {
    try {
      const current = await frames();
      result.finalFrames = current;
      for (const frame of current) {
        try {
          await rpc("/screenshot", { id: frame.id, name: `final-${frame.contentsId}.png` });
          fs.copyFileSync(path.join(root, `final-${frame.contentsId}.png`), path.join(output, `final-${frame.contentsId}.png`));
        } catch {}
      }
    } catch {}
  }
  fs.writeFileSync(path.join(output, "native-results.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(output, "manager-output.txt"), managerOutput);
  child.stdin.end();
  await Promise.race([once(child, "exit"), delay(10000)]);
  if (child.exitCode === null) child.kill("SIGTERM");
  upstream.closeAllConnections();
  upstream.close();
}
