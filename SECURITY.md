# Security

## Reporting a vulnerability

Use GitHub's private vulnerability reporting:
**[Report a vulnerability](https://github.com/lionrayonnant/FPVThePlanet/security/advisories/new)**
(Security tab → Advisories → Report a vulnerability). It opens a private thread
with the maintainer and is the only channel that is not a public issue.

Please do not open a public issue for a vulnerability, and please do not
disclose one publicly before a fix is out.

Include what you would want to receive: the version or commit, how the game is
running (dev server, standalone server, installed app), a reproduction, and
what an attacker gets out of it. A proof of concept is welcome; an actual
exploit against someone else's instance is not.

This is a one-person project with no security team behind it. Expect a first
response within a week. If a report is valid and I cannot fix it quickly, I
will say so rather than leave the thread silent, and I will credit you in the
advisory and the changelog unless you would rather I did not.

## Supported versions

The latest release only. There are no maintenance branches, and a fix ships in
the next version rather than being backported.

## What the security boundaries actually are

Knowing these saves everyone time, because two of the three ways to run this
game are not exposed to a network at all.

**Installed app and `npm run dev`.** The server binds `127.0.0.1` on an
ephemeral port and the loopback is the boundary. There is no authentication,
deliberately: anything that can reach the socket is already running as you.

**Hosted instance (`--mode shared`).** This is the one that faces a network. It
never acquires terrain — `FPVTP_ACQUIRE` is not set and must never be set on a
public instance — it stores no scenes, and it demands an operator key on
`/__map-api/*`. Findings here are the most valuable ones: path traversal out of
the static root, anything that writes outside the data directory, authentication
bypass on the map API, and resource exhaustion that a single client can trigger.

**The browser client.** Injection into the DOM from anything the player does not
control — a place name coming back from search, a scene manifest fetched over
the network, a value read back out of `localStorage` — is in scope.

**The terrain acquisition pipeline.** Off by default, enabled only with
`FPVTP_ACQUIRE=1` in the environment, refused outright in `--mode shared`. It
decodes untrusted binary from a remote server, so decoder findings — an
allocation driven by an attacker-controlled length, a buffer overread, a path
written from remote data — are in scope even though the feature is opt-in.

**The desktop auto-updater.** Updates are read from this repository's GitHub
Releases over HTTPS. `FPVTP_UPDATE_URL` overrides that feed at runtime, which is
a deliberate escape hatch for self-hosting and not a vulnerability by itself.

## Out of scope

- The Google Earth `rocktree` protocol itself, and anything about Google's
  servers. The game speaks a protocol it does not own; how that endpoint
  behaves is not something this project can fix.
- Missing code signing on the Windows installer. There is no certificate, so
  SmartScreen warns on first launch. This is known and accepted, and it is
  written down in `sim/electron-builder.yml`.
- Denial of service against your own machine in `local` mode — see the
  boundaries above.
- Anything requiring a compromised machine, a malicious npm dependency you
  installed yourself, or physical access.
- Findings from an automated scanner with no demonstrated impact.

## What this project already does

Not a guarantee, just so you do not spend an afternoon rediscovering it: the
HTTP surface and the pure modules are fuzzed on every CI run (`npm run fuzz`,
property-based and seeded — see `sim/docs/handoff-archive/fuzzing.md`), the
Electron renderer runs with `contextIsolation: true` and `nodeIntegration:
false`, no window opens outside the system browser, and acquisition is gated
behind an environment variable that the hosted mode refuses.
