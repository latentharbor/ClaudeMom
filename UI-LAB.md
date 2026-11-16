# Desktop UI compatibility lab

This branch keeps the official Desktop application intact. The managed
proxy uses the installed version's HTML, scripts and bundled gated-import
manifest as an offline baseline. A newer official web document is retained
when its build ID matches a captured current bootstrap dependency manifest.
Thus the older packaged SPA cannot replace a newer official web deployment,
and a recorded API template cannot silently select mismatched imports.
Explicit developer recordings remain opt-in.

An optional private `claude-local/desktop-features.json` can contain a response
captured by the owner from the official Desktop feature endpoint:

```json
{
  "schema": 1,
  "desktopVersion": "5.11492.5",
  "source": "official-desktop-features",
  "capturedAt": "2026-11-16T04:00:00Z",
  "features": {
    "123": { "value": false, "on": false, "off": true, "source": "defaultValue" }
  }
}
```

Values remain evaluated values, including disabled features; this is not a
request to enable everything. A version mismatch rejects the profile, an old
profile is labeled, and explicit local computer-use controls take precedence.
No session cookie, account entitlement, inference model or thinking payload is
changed by this feature response. A feature entry does not implement its cloud
backend or establish that a cloud feature works.

The profile may also hold `web: {buildId, gatedImports}` from the owner's
current official bootstrap response. This contains resource metadata, not
the account object or its cookies. A web cache is used only when its own build
ID matches that metadata and its embedded build time is at least as recent
as the installed document. Unknown or broken caches fall back to the package.

The lab build has a different application identifier, port and state directory
(`~/.claude-mom-ui-lab`). It cannot launch the production Desktop, import live
sessions or change certificate trust. The owned Desktop copy has separate
profile, CLI, logs, scratch and cache paths. Its bootstrap suppresses protocol
registration, startup items, global shortcuts, external links and updates.
The outer macOS file sandbox protects live account/session directories and
denies home-directory writes outside the lab. HOME is not reassigned.

Only the test copy is ad-hoc signed. Its Chromium nested sandbox is disabled
because it runs inside the outer seatbelt profile. This is test infrastructure,
not a change to the installed application's signature or system security.

`UI lab` runs runtime contracts, host/isolation tests and application builds
on GitHub, then starts the actual isolated Desktop fixture and retains native
screenshots and a result file. The private fixture contains public application
files and an evaluated feature response, not personal credentials or history.
All sessions used in this check are fictional. Native cloud services, Remote
Control, dictation, computer-use execution and full page-by-page visual parity
are not established by these checks.

The runtime's health response exposes `uiResources`, `uiBuildId`, and
`desktopFeaturesSource` so tests and users can distinguish installed resources
from a developer recording. Updating Desktop requires a matching new feature
reference; an old reference is never silently reused under another version.
