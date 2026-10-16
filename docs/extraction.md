# Standalone extraction — 2026-10-16

Source repository: Alexintosh/farming-control, commit
`b347efd245a212de6e230c1727b07ae73071847a`.

This initial standalone commit is a source snapshot, not a copy of the original
repository history. It contains the two Agent Safe applications, four independent
packages, distributable plugin, skill references, existing test suite/fixtures,
source export/build scripts, product plan and architecture decision. Upstream
fixture license notices are preserved. No license for original source is newly
assigned by this extraction.

The source repository has unrelated working changes; they are not included.
No databases, runtime metadata, user proposals/signatures, wallet keys, credentials
or personal RPC configuration are included. Existing local installations and data
are not relocated or restarted. Farming Control still consumes its shared Safe
primitives; its existing source copies remain for compatibility.

Validation performed in this repository:
- Independent dependency install and standalone bun.lock: passed.
- TypeScript check: passed.
- Backend/plugin and browser asset build: passed.
- Existing unit/integration suite: 21 passed, 0 failed (165 assertions).
- Browser end-to-end: offchain and onchain flows passed on disposable Anvil,
  including two signers, portable signature handoff and execution from saved proposals.
- Skill validation and static plugin manifest/asset inspection: passed.

The operator explicitly authorized these isolated Agent Safe tests on 2026-10-16.
No test-gate change is implied for other products or modules.

Future Agent Safe development belongs here. Changes to shared primitives required
by Farming Control must be synchronized deliberately, not through cross-repository
filesystem imports. No ongoing automatic synchronization is configured.
