<!--
Thanks for this. Delete any section that does not apply rather than writing
"n/a" in it — a short, honest description beats a filled-in form.

CONTRIBUTING.md has the rules that actually bite; the three below are the ones
a pull request gets sent back for.
-->

## What this changes

<!-- What the code does now that it did not do before, and why that is the
right change. Link the issue it closes. -->

Closes #

## How it was verified

<!-- What you ran, and what it said. `npm run selftest:ci` from sim/ is the
gate; the module's own selftest is what you should have been running while
working. If you added or changed behaviour, say which selftest covers it now.
If something could only be checked in a browser, say that too — "not verified
in flight" is a useful sentence, a silent gap is not. -->

- [ ] `npm run selftest:ci` passes from `sim/`
- [ ] The module's own selftest covers the new behaviour
- [ ] `CHANGELOG.md` has an entry under `## [Non publié]`

## Notes for review

<!-- Anything you are unsure about, a trade-off you made, a follow-up you would
rather open as its own issue than fold in here. -->

---

<!--
Reminders, so nothing is a surprise:

- Any file you touched leaves in ENGLISH — comments and selftest labels
  included. CHANGELOG entries stay French.
- PID gains and airframe constants are measured, never hand-edited. Retune with
  `npm run tune` and commit what the bench produced.
- The version is not bumped in a pull request. Releases are cut with
  `npm run release`.
- Nothing from `sim/public/scenes/` goes into a commit.
-->
