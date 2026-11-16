const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { execFileSync } = require("node:child_process");
const { before, after, test } = require("node:test");
const { X509Certificate } = require("node:crypto");
const { createLabCertificatePolicy, certificateVerifyProc } = require("./lab-certificate-policy.cjs");
let dir, ca, leaf, second, otherCa, forged;
function openssl(...args) { execFileSync("openssl", args, { cwd: dir, stdio: "ignore" }); }
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ui-lab-tls-"));
  openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "2", "-subj", "/CN=Lab Root");
  openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "other.key", "-out", "other.pem", "-days", "2", "-subj", "/CN=Other Root");
  fs.writeFileSync(path.join(dir, "extensions"), "subjectAltName=DNS:claude.ai,DNS:*.claude.ai,DNS:api.anthropic.com\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n");
  for (const [name, issuer] of [["leaf", "ca"], ["second", "ca"], ["forged", "other"]]) {
    openssl("req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", name + ".key", "-out", name + ".csr", "-subj", "/CN=claude.ai");
    openssl("x509", "-req", "-in", name + ".csr", "-CA", issuer + ".pem", "-CAkey", issuer + ".key", "-CAcreateserial", "-out", name + ".pem", "-days", "1", "-extfile", "extensions");
  }
  [ca, leaf, second, otherCa, forged] = ["ca", "leaf", "second", "other", "forged"].map(name => fs.readFileSync(path.join(dir, name + ".pem")));
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));
test("the owned proxy chain is accepted only for its valid DNS names", () => {
  const matches = createLabCertificatePolicy(ca, leaf);
  assert.equal(matches("claude.ai", leaf), true);
  assert.equal(matches("a.claude.ai", leaf), true);
  assert.equal(matches("api.anthropic.com", leaf), true);
  for (const host of ["example.com", "claude.ai.attacker.test", "nested.a.claude.ai", "elsewhere.anthropic.com", "127.0.0.1"]) assert.equal(matches(host, leaf), false);
});
test("forged and different leaves cannot reuse the allowed hostname", () => {
  const matches = createLabCertificatePolicy(ca, leaf);
  assert.equal(matches("claude.ai", forged), false);
  assert.equal(matches("claude.ai", second), false);
  assert.equal(matches("claude.ai", "not a certificate"), false);
  assert.throws(() => createLabCertificatePolicy(otherCa, leaf), /Invalid isolated/);
});
test("the pin never bypasses certificate validity dates", () => {
  const matches = createLabCertificatePolicy(ca, leaf), cert = new X509Certificate(leaf);
  assert.equal(matches("claude.ai", leaf, Date.parse(cert.validTo) + 1), false);
  assert.equal(matches("claude.ai", leaf, Date.parse(cert.validFrom) - 1), false);
});
test("only the missing-authority error receives scoped application trust", () => {
  const proc = certificateVerifyProc(createLabCertificatePolicy(ca, leaf));
  const call = (errorCode, hostname = "claude.ai", data = leaf) => {
    let result; proc({ errorCode, hostname, certificate: { data } }, code => { result = code; }); return result;
  };
  assert.equal(call(-202), 0);
  for (const error of [0, -200, -201, -206, -208]) assert.equal(call(error), -3);
  assert.equal(call(-202, "example.com"), -3);
  assert.equal(call(-202, "claude.ai", forged), -3);
});
