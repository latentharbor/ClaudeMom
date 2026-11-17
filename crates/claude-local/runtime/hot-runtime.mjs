import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import { runtimeConfig } from './runtime.mjs';

const uuid = /^[a-zA-Z0-9_-]{1,128}$/;
export function requestSession(headers, raw) {
  const header = headers['x-claude-code-session-id'];
  if (typeof header === 'string' && uuid.test(header)) return header.replace(/^local_/, '');
  try {
    const user = JSON.parse(raw).metadata?.user_id;
    const id = typeof user === 'string' && user.startsWith('{') ? JSON.parse(user).session_id
      : typeof user === 'string' ? user.match(/_session_([a-zA-Z0-9_-]+)$/)?.[1] : null;
    return typeof id === 'string' && uuid.test(id) ? id.replace(/^local_/, '') : null;
  } catch { return null; }
}

// A snapshot belongs to a complete native task, including intervals spent in
// tools. Connection completion never releases a task's routing configuration.
export function createHotRuntime(env) {
  const scope = new AsyncLocalStorage();
  let current = runtimeConfig(env);
  let revision = '';
  const sessions = new Map();
  const active = new Set();
  const runtime = new Proxy({}, { get: (_, key) => (scope.getStore() || current)[key] });
  return {
    runtime,
    get current() { return current; },
    get revision() { return revision; },
    get retiredSessions() { return [...sessions].filter(([, snapshot]) => snapshot !== current).map(([id]) => id); },
    apply(nextEnv, nextRevision) {
      const next = runtimeConfig(nextEnv); // validate the entire candidate first
      current = next;
      revision = nextRevision;
    },
    tasks(ids) {
      const next = new Set(ids.map(id => id.replace(/^local_/, '')));
      for (const id of next) if (!sessions.has(id)) sessions.set(id, current);
      active.clear();
      for (const id of next) active.add(id);
    },
    confirmIdle(ids) {
      for (const value of ids) {
        const id = value.replace(/^local_/, '');
        if (!active.has(id)) sessions.delete(id);
      }
    },
    run(id, fn) {
      if (id && !sessions.has(id)) {
        // Unknown clients stay pinned until an explicit native idle observation.
        if (sessions.size >= 4096) throw Error('Too many unreleased task snapshots');
        sessions.set(id, current);
      }
      return scope.run(id ? sessions.get(id) : current, fn);
    },
  };
}

export function constantToken(supplied, expected) {
  if (typeof supplied !== 'string' || typeof expected !== 'string' || !expected) return false;
  const a = Buffer.from(supplied), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function validateTaskReport(value) {
  if (!value || value.schema !== 1 || !Array.isArray(value.active) || value.active.length > 4096 ||
      value.active.some(id => typeof id !== 'string' || !uuid.test(id)) ||
      typeof value.idle !== 'boolean' || typeof value.draft !== 'boolean' ||
      typeof value.toolsReady !== 'boolean') throw Error('Invalid native task report');
  if (value.uiRevision !== undefined && (typeof value.uiRevision !== 'string' ||
      !/^(?:[a-f0-9]{64})?$/.test(value.uiRevision))) throw Error('Invalid UI revision');
  if (value.confirmedIdle !== undefined && (!Array.isArray(value.confirmedIdle) || value.confirmedIdle.length > 4096 ||
      value.confirmedIdle.some(id => typeof id !== 'string' || !uuid.test(id)))) throw Error('Invalid idle identities');
  if (value.preparedRevision !== undefined && !/^(?:[a-f0-9]{64})?$/.test(value.preparedRevision)) throw Error('Invalid prepared revision');
  return value;
}
