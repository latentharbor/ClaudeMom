import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localCloudAccess, extensionInstallPolicy, isFakeIp } from './local-policy.mjs';
test('local admission disables cloud transports without changing browser or unrelated account policy', () => {
  const features = [{ feature: 'marble_heron', status: 'available' }, { feature: 'dramatic_shrimp', status: 'available' },
    { feature: 'cowork_browser_pane', status: 'available' }, { feature: 'x', status: 'blocked_by_org_admin' }];
  assert.deepEqual(localCloudAccess(features).map(x => x.status),
    ['blocked_by_platform', 'blocked_by_platform', 'available', 'blocked_by_org_admin']);
  assert.equal(features[0].status, 'available');
});
test('extension verdicts explicitly belong to local device settings and preserve every requested ID', () => {
  const body = { extensions: { 'test.extension': { extension_id: 'test.extension', manifest: { name: 'Fixture' } } } };
  const allowed = extensionInstallPolicy(body, true);
  assert.equal(allowed.policy_source, 'local_device');
  assert.equal(allowed.results['test.extension'].can_install, true);
  assert.match(allowed.results['test.extension'].reason, /no organization policy/);
  assert.equal(extensionInstallPolicy(body, false).results['test.extension'].can_install, false);
  assert.throws(() => extensionInstallPolicy({ extensions: { x: { extension_id: 'other' } } }, true));
});
test('Fake-IP diagnostic is restricted to the benchmarking range, never a private-network allow rule', () => {
  for (const ip of ['198.18.0.1', '198.19.255.254']) assert.equal(isFakeIp(ip), true);
  for (const ip of ['198.20.0.1', '192.168.100.10', '127.0.0.1', '198.19.999.1', 'example.com']) assert.equal(isFakeIp(ip), false);
});
