"use strict";
// Included only in the owned test copy; never written into /Applications.
const fs = require("node:fs"), path = require("node:path"), http = require("node:http"), crypto = require("node:crypto");
const electron = require("electron");
const root = process.env.CLAUDE_MOM_LAB_ROOT;
if (!root || path.basename(root) !== ".claude-mom-ui-lab") throw Error("Missing isolated UI lab root");
const observerPath=path.join(root,"ui-observer.cjs");
const observer=fs.existsSync(observerPath)?require(observerPath).install(electron,root):null;
const { app, globalShortcut, shell, autoUpdater } = electron;
const { createLabCertificatePolicy, certificateVerifyProc, withLabChildCA } = require("./lab-certificate-policy.cjs");
const childProcess = require("node:child_process"), spawn = childProcess.spawn;
childProcess.spawn = function(command, args, options) {
  return spawn.call(this, command, args, withLabChildCA(command, options, root, process.resourcesPath));
};
const matchesProxyCertificate = createLabCertificatePolicy(
  fs.readFileSync(path.join(root, "claude-local/ca/ca.pem")),
  fs.readFileSync(path.join(root, "claude-local/ca/server.crt")),
);
const installCertificatePolicy = (session) => session.setCertificateVerifyProc(certificateVerifyProc(matchesProxyCertificate));
app.on("session-created", (...args) => installCertificatePolicy(args.at(-1)));
app.whenReady().then(() => installCertificatePolicy(electron.session.defaultSession));
const home = path.join(root, "profile-home");
const owned = { userData: path.join(home, "Library/Application Support/Claude"),
  sessionData: path.join(root, "browser-session"), appData: path.join(home, "Library/Application Support"),
  home, temp: path.join(root, "tmp"), logs: path.join(root, "logs"), crashDumps: path.join(root, "crashes") };
for (const value of Object.values(owned)) fs.mkdirSync(value, { recursive: true, mode: 0o700 });
app.setName("Claude UI Lab");
app.userAgentFallback = app.userAgentFallback.replace(/ClaudeUILab(?=\/)/g, "Claude").replace(/claude-ui-lab(?=\/)/g, "Claude");
const setPath = app.setPath.bind(app);
for (const [key, value] of Object.entries(owned)) setPath(key, value);
app.setPath = (key, value) => setPath(key, owned[key] || value);
app.setAppLogsPath = () => setPath("logs", owned.logs);
app.setAsDefaultProtocolClient = () => false;
app.removeAsDefaultProtocolClient = () => false;
app.setLoginItemSettings = () => {};
globalShortcut.register = () => false;
globalShortcut.registerAll = () => {};
shell.openExternal = async () => {};
autoUpdater.checkForUpdates = () => null;
autoUpdater.setFeedURL = () => {};
app.commandLine.appendSwitch("use-mock-keychain");
app.commandLine.appendSwitch("no-first-run");
app.commandLine.appendSwitch("no-default-browser-check");
// Chromium cannot nest its seatbelt inside sandbox-exec. The outer profile
// denies writes outside this copy and access to all live Claude state.
app.commandLine.appendSwitch("no-sandbox");
const token = crypto.randomBytes(24).toString("hex");
function frames() {
  return electron.webContents.getAllWebContents().flatMap((wc) => {
    try { return wc.mainFrame.framesInSubtree.map((frame) => ({ id: `${wc.id}:${frame.processId}:${frame.routingId}`, wc, frame })); }
    catch { return []; }
  });
}
const server = http.createServer(async (req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(403); return res.end("{}"); }
  try {
    if(req.method==="POST"&&req.url==="/observe")return res.end(JSON.stringify(await observer.start()));
    if(req.method==="GET"&&req.url==="/observe")return res.end(JSON.stringify(observer.report()));
    const entries = frames();
    if (req.method === "GET" && req.url === "/status") {
      return res.end(JSON.stringify({ pid: process.pid, data: app.getPath("userData"),
        frames: entries.map(({ id, wc, frame }) => ({ id, url: frame.url, contentsId: wc.id })) }));
    }
    let raw = "";
    for await (const part of req) { raw += part; if (raw.length > 65536) throw Error("Command too large"); }
    const payload = JSON.parse(raw);
    const entry = entries.find(({ id }) => id === payload.id);
    if (!entry || !/^(app:\/\/localhost|file:|https:\/\/claude\.ai(?:\/|$))/.test(entry.frame.url)) throw Error("Not an owned UI frame");
    if (req.method === "POST" && req.url === "/evaluate") {
      return res.end(JSON.stringify({ result: await entry.frame.executeJavaScript(payload.expression, true) }));
    }
    if (req.method === "POST" && req.url === "/screenshot") {
      if (!/^[a-z0-9-]+\.png$/.test(payload.name)) throw Error("Invalid output name");
      const image = await entry.wc.capturePage();
      fs.writeFileSync(path.join(root, payload.name), image.toPNG(), { mode: 0o600 });
      return res.end(JSON.stringify({ saved: payload.name }));
    }
    res.writeHead(404); res.end("{}");
  } catch (error) { res.writeHead(400); res.end(JSON.stringify({ error: error.message })); }
});
server.listen(0, "127.0.0.1", () => fs.writeFileSync(path.join(root, "control.json"),
  JSON.stringify({ port: server.address().port, token, pid: process.pid }), { mode: 0o600 }));
app.on("before-quit", () => server.close());
require("./ui-lab-original-main.cjs");
