// Native idle evidence and deferred UI/tool refresh. Never send transcripts,
// account tokens, file names or prompts to this control endpoint.
(function () {
  'use strict';
  if (window.top !== window || location.origin !== 'https://claude.ai' || window.__claudeMomRuntimeBridge) return;
  window.__claudeMomRuntimeBridge = true;
  const endpoint = '/__codex_plus/runtime-state';
  const fetch = window.fetch.bind(window);
  let token, polling = false, stopped = false, lastPrepareAttempt = 0;
  const loadedRevision = document.querySelector('meta[name="claudemom-ui-revision"]')?.content || '';
  const pending = new Set();
  const busy = s => s.isRunning !== false || s.isStopping === true || s.pendingAgentRuns > 0 ||
    s.pendingInput === true || s.sideChatInFlight === true || s.cwdMove === true || s.outputStyleRefresh === true ||
    Array.isArray(s.backgroundTasks) && s.backgroundTasks.some(t => !['completed', 'stopped', 'failed'].includes(t.status));
  const idOf = s => typeof s.cliSessionId === 'string' ? s.cliSessionId : s.sessionId;
  async function state() {
    const response = await fetch(endpoint, { cache: 'no-store', signal: AbortSignal.timeout(4000) });
    if (!response.ok) throw Error('Runtime unavailable');
    const value = await response.json();
    if (value.schema !== 1 || typeof value.token !== 'string') throw Error('Unsupported runtime');
    token = value.token;
    return value;
  }
  async function report(extra = [], confirmation = {}) {
    const api = window['claude.web'];
    if (!api?.LocalSessions?.getAll || !api?.LocalAgentModeSessions?.getAll) throw Error('Native idle status unavailable');
    const [code, cowork] = await Promise.all([api.LocalSessions.getAll(), api.LocalAgentModeSessions.getAll()]);
    if (!Array.isArray(code) || !Array.isArray(cowork)) throw Error('Unknown native session list');
    const active = [...new Set([...code, ...cowork].filter(busy).map(idOf).concat([...pending], extra))];
    if (active.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id))) throw Error('Unknown task identity');
    const draft = [...document.querySelectorAll('textarea,[contenteditable="true"]')]
      .some(e => (e.value || e.innerText || '').trim().length > 0);
    const response = await fetch(endpoint, { method: 'POST', cache: 'no-store',
      headers: { 'content-type': 'application/json', 'x-claudemom-runtime-token': token },
      body: JSON.stringify({ schema: 1, active, idle: active.length === 0, draft,
        uiRevision: document.querySelector('meta[name="claudemom-ui-revision"]')?.content || '',
        toolsReady: typeof api.LocalSessions.applyModelByRestart === 'function', ...confirmation }),
      signal: AbortSignal.timeout(4000) });
    if (!response.ok) throw Error('Runtime is changing');
      return { code, cowork, active, draft };
  }
  function wrapSend(api) {
    if (!api?.sendMessage || api.sendMessage.__claudeMomGuarded) return;
    const original = api.sendMessage.bind(api);
    const guarded = async function (id, ...args) {
      pending.add(id);
      try {
        // Admission must reach the service before native work can begin.
        let ready = false;
        for (let i = 0; i < 30 && !ready; i++) {
          try { await state(); await report([id]); ready = true; }
          catch { await new Promise(resolve => setTimeout(resolve, 500)); }
        }
        if (!ready) throw Error('ClaudeMom is applying an update. Try sending again shortly.');
        return await original(id, ...args);
      } finally { pending.delete(id); }
    };
    guarded.__claudeMomGuarded = true;
    try { api.sendMessage = guarded; } catch { /* Native wrappers may be immutable. Idle polling still fails closed. */ }
  }
  async function poll() {
    if (stopped || polling) return;
    polling = true;
    try {
      const current = await state();
      wrapSend(window['claude.web']?.LocalSessions);
      wrapSend(window['claude.web']?.LocalAgentModeSessions);
      const snapshot = await report();
      window.__claudeMomRuntimeBridgeStatus = { code: snapshot.code.length, cowork: snapshot.cowork.length,
        active: snapshot.active.length, draft: snapshot.draft, loadedRevision,
        missingModel: snapshot.code.filter(s => typeof s.model !== 'string').length };
      const uiChanged = loadedRevision && current.revision !== loadedRevision;
      const retired = new Set(current.retiredSessions || []);
      const normalize = id => id?.replace(/^local_/, '');
      const stale = snapshot.code.filter(s => retired.has(normalize(idOf(s))) || retired.has(normalize(s.sessionId)));
      if ((uiChanged || current.pendingCoreRevision || stale.length) && snapshot.active.length === 0 && !snapshot.draft &&
          current.activeWork === 0 && current.activeDictation === 0 && Date.now() - lastPrepareAttempt > 10000) {
        lastPrepareAttempt = Date.now();
        const confirmedIdle = [];
        // This native method checks private side chats, pending input, agent
        // runs and cwd/output-style changes which list snapshots cannot prove.
        for (const session of uiChanged || current.pendingCoreRevision ? snapshot.code : stale) {
          if (!session.sessionId?.startsWith('local_') || busy(session) || typeof session.model !== 'string') return;
          const result = await window['claude.web'].LocalSessions.applyModelByRestart(session.sessionId, session.model);
          if (!['restarted', 'applies_on_next_start'].includes(result)) return;
          confirmedIdle.push(idOf(session), session.sessionId);
          sessionStorage.setItem('claudeMom.lastNativeRefresh', result);
        }
        const final = await report([], { confirmedIdle, preparedRevision: current.pendingCoreRevision || '' });
        const latest = await state();
        if (final.active.length || final.draft || latest.activeWork || latest.activeDictation) return;
        if (uiChanged) {
          sessionStorage.setItem('claudeMom.lastUiRefresh', current.revision);
          location.reload();
          return;
        }
      }
    } catch (error) { window.__claudeMomRuntimeBridgeError = String(error.message).slice(0, 256); }
    finally { polling = false; }
  }
  const timer = setInterval(poll, 2000);
  addEventListener('pagehide', () => { stopped = true; clearInterval(timer); }, { once: true });
  void poll();
})();
