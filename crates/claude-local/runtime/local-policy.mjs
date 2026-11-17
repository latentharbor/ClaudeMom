// These services require actual cloud admission and cannot be provided by the
// local compatibility backend. Do not advertise inherited recording grants.
const CLOUD_ONLY = new Set(['dramatic_shrimp', 'marble_heron', 'claude_code_web',
  'cowork_remote_control', 'claude_code_remote_control']);
export function localCloudAccess(features) {
  return features.map(feature => CLOUD_ONLY.has(feature?.feature)
    ? { ...feature, status: 'blocked_by_platform' } : feature);
}

export function extensionInstallPolicy(body, localAllowed) {
  if (!body || !body.extensions || typeof body.extensions !== 'object' || Array.isArray(body.extensions) ||
      Object.keys(body.extensions).length > 100) throw Error('Invalid extension request');
  const entries = Object.entries(body.extensions);
  if (entries.some(([id, value]) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(id) || value?.extension_id !== id)) {
    throw Error('Invalid extension identity');
  }
  return { policy_source: 'local_device', results: Object.fromEntries(entries.map(([id]) => [id, {
    can_install: localAllowed === true,
    reason: localAllowed === true
      ? 'Allowed by local device settings. Claude still verifies the extension and asks for installation consent; no organization policy was consulted.'
      : 'Desktop extension installation is disabled in local device settings.',
  }])) };
}

export function isFakeIp(address) {
  const bytes = String(address).split('.').map(Number);
  return bytes.length === 4 && bytes.every(x => Number.isInteger(x) && x >= 0 && x <= 255) &&
    bytes[0] === 198 && (bytes[1] === 18 || bytes[1] === 19);
}
