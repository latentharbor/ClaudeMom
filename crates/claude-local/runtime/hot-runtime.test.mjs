import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHotRuntime, requestSession, validateTaskReport } from './hot-runtime.mjs';

const env = key => ({ CLAUDE_LOCAL_MANAGED: '1', CLAUDE_LOCAL_GATEWAY_URL: 'https://example.invalid',
  CLAUDE_LOCAL_GATEWAY_KEY: key, CLAUDE_LOCAL_GATEWAY_MODEL: 'test/model' });

test('routing remains pinned across an HTTP-free tool phase, and advances only after native idle', async () => {
  const hot = createHotRuntime(env('first'));
  hot.tasks(['local_abc']);
  let resume;
  const pending = hot.run('abc', async () => {
    await new Promise(resolve => { resume = resolve; });
    return hot.runtime.key;
  });
  hot.apply(env('second'), 'second');
  assert.equal(hot.run('abc', () => hot.runtime.key), 'first');
  assert.equal(hot.run('new', () => hot.runtime.key), 'second');
  resume();
  assert.equal(await pending, 'first');
  hot.tasks([]);
  assert.equal(hot.run('abc', () => hot.runtime.key), 'second');
});

test('invalid candidate retains the last valid configuration without leaking it', () => {
  const hot = createHotRuntime(env('private-fixture'));
  assert.throws(() => hot.apply({ ...env('changed'), CLAUDE_LOCAL_GATEWAY_URL: 'file:///etc' }, 'bad'));
  assert.equal(hot.current.key, 'private-fixture');
});

test('current and legacy Claude Code session metadata bind the same native lease', () => {
  assert.equal(requestSession({}, JSON.stringify({ metadata: { user_id: JSON.stringify({ session_id: 'id-123' }) } })), 'id-123');
  assert.equal(requestSession({}, JSON.stringify({ metadata: { user_id: 'user_hash_account_hash_session_id-123' } })), 'id-123');
  assert.equal(requestSession({ 'x-claude-code-session-id': 'local_id-123' }, '{}'), 'id-123');
  assert.equal(requestSession({}, '{}'), null);
  assert.throws(() => validateTaskReport({ schema: 1, active: [], idle: true }));
});
