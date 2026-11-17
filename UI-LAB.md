# Desktop UI compatibility lab

## Independent runtime branch

`feature-durable-runtime-20261117` is an isolated implementation branch, not
an installed upgrade. Its focused CI runs contracts and the native fixture;
it never launches or reconfigures an installed production Desktop.

The stable loopback service owns a single compatibility core and its listener.
GUI exit/relaunch does not close the service's stdin or inference connections.
The GUI adopts a healthy process only after checking its owned executable,
instance, PID and loopback health receipt. Explicit Stop still terminates it.
Old pipe-owned versions require an idle, explicit migration; they are never
silently killed by a newly opened manager.

Private atomic configuration generations contain credentials; health and UI
status contain only hashes, process IDs and apply state. The local client key
is separate from the upstream credential, so a new upstream key does not
invalidate an already running Desktop. Code tasks retain their configuration
through tool phases, using current/legacy Claude Code session metadata and
native session leases. Unknown clients remain pinned until explicit native
idle evidence; there is no HTTP-idle expiry that silently changes a task's key.

Code and Cowork native idle snapshots, absence of drafts/recording/requests,
and a final core-side admission barrier precede a core replacement. A missing
or stale bridge never counts as idle. Only one core writes the conversation
store. Candidates run from immutable version directories; failed startup
restores the previous core. New requests wait at the stable listener during
the transition. Frontend reload and SDK refresh are deferred; a native Busy
result prevents refresh. Native binary/profile/CA/context changes remain
explicit Desktop restart operations.

Local extension verdicts identify their source as device settings, preserve
the normal native signature/installation checks, and can be disabled in the
manager. Recorded cloud admission for Remote Control/remote device bridges
is disabled in local mode; local browser and MCP capabilities are separate.
Fake-IP DNS is diagnosed, not converted into a private-network allow rule.
Changing a system network proxy/DNS policy is outside an application hot
reload and is not performed by this branch.

The focused native fixture checks manager detach/adoption during a held Code
reply, old/new task routing after a credential change, and live browser
consent configuration. The reload observation covers a simple Code stream,
tabs and draft, and a renderer-owned REST Chat request; it does not establish
Cowork VM/tool execution, native dictation continuity or every possible tool.
The optional SenseVoice helper still lives in the manager; a GUI restart must
wait for an active recording to finish. The stable service listener itself
retains its existing code until explicit Stop; compatibility-core and UI
generations are the parts replaced while the listener keeps its port.

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

The profile may also hold `web: {buildId, gatedImports, features, hashingAlgorithm}` from the owner's
current official bootstrap response. This contains resource metadata, not
the account object or its cookies. A web cache is used only when its own build
ID matches that metadata and its embedded build time is at least as recent
as the installed document. Current evaluated SHA-256 feature results replace
the old recorded rule definitions only for that matched web document; account
attributes are not imported. Disabled results remain disabled, and the local
Cowork choice still takes precedence. Unknown or broken caches fall back to the package.

Model selector metadata can be captured from the version-compatible public
model catalog independently of the web resource build. Provider-qualified
models retain the matching native model's capability declaration, and the
selector API uses that same catalog instead of reducing every model to a
synthetic Medium-only choice. A configured inference route owns its local
availability; a reference account's disabled state is not imported as a quota
or subscription decision for that route.

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
