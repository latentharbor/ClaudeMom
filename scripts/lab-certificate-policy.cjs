"use strict";
const { X509Certificate, timingSafeEqual } = require("node:crypto");
const path = require("node:path");

// An application-specific trust anchor for this isolated copy. The pin is
// the same public CA/leaf pair used by its owned loopback proxy, not a rule
// that accepts arbitrary certificates or suppresses TLS errors globally.
function createLabCertificatePolicy(caPem, leafPem) {
  const ca = new X509Certificate(caPem);
  const expected = new X509Certificate(leafPem);
  if (!ca.ca || !ca.verify(ca.publicKey) || expected.ca ||
      !expected.checkIssued(ca) || !expected.verify(ca.publicKey)) {
    throw new Error("Invalid isolated proxy certificate chain");
  }
  const datesValid = (cert, now) => now >= Date.parse(cert.validFrom) && now <= Date.parse(cert.validTo);
  return function matches(hostname, presentedPem, now = Date.now()) {
    try {
      const host = hostname.toLowerCase().replace(/\.$/, "");
      if (!/^(?:[a-z0-9-]+\.)*(?:claude\.ai|claude\.com|anthropic\.com)$/.test(host)) return false;
      const cert = new X509Certificate(presentedPem);
      if (cert.raw.length !== expected.raw.length || !timingSafeEqual(cert.raw, expected.raw) || cert.ca ||
          !datesValid(cert, now) || !datesValid(ca, now) || !cert.checkHost(host, { subject: "never" }) ||
          !cert.checkIssued(ca) || !cert.verify(ca.publicKey)) return false;
      const usages = cert.keyUsage;
      if (usages?.length && !usages.includes("1.3.6.1.5.5.7.3.1") && !usages.includes("2.5.29.37.0")) return false;
      return true;
    } catch { return false; }
  };
}

function certificateVerifyProc(matches) {
  return (request, callback) => {
    // Only supply the missing private authority. Do not override revoked,
    // expired, weak or otherwise rejected certificates, or normal TLS.
    callback(request.errorCode === -202 && matches(request.hostname, request.certificate.data) ? 0 : -3);
  };
}
function withLabChildCA(command, options, root, resourcesPath) {
  // Desktop reconstructs the CLI environment from its system trust bundle,
  // dropping the launcher's extra CA. Scope this addition to our own CLI
  // launcher and private config; no production or unrelated child is changed.
  if (path.basename(root) !== ".claude-mom-ui-lab" ||
      command !== path.join(resourcesPath, "../Helpers/disclaimer") ||
      options?.env?.CLAUDE_CONFIG_DIR !== path.join(root, "profile-home/.claude-desktop-local/claude-code")) return options;
  return { ...options, env: { ...options.env, NODE_EXTRA_CA_CERTS: path.join(root, "claude-local/ca/ca.pem") } };
}
module.exports = { createLabCertificatePolicy, certificateVerifyProc, withLabChildCA };
