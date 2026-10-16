# Agent Safe technical reference

Independent Safe operations through a Codex skill, authenticated local API and
wallet signing page. It needs Bun >=1.3.8 and a working RPC for chain operations. Anvil is optional. It uses neither
Farming Control's runtime/data nor the Safe hosted transaction service.

Build: `bun scripts/build-agent-safe.ts`. Installable directory:
`plugins/agent-safe`. Its bundled JavaScript includes runtime dependencies and UI;
no checkout or node_modules is needed after installation. The skill automatically
starts a dedicated loopback daemon when invoked. Use a new Codex task after install.

From an empty task: “Use Agent Safe. My Safe is 0x… on Base. Inspect it and help me
prepare a transaction.” The agent resolves chain/network, reads nonce/owners,
prepares an exact plan and immediately returns a scoped URL. Anvil is optional. Open the URL on the
same computer, connect an injected wallet and explicitly sign/approve/execute.
For another computer, export the handoff and import it in that signer's Agent Safe.

Supported: Safe 1.3.0/1.4.1 singleton bytecode, EOA owners, native/ERC20 transfer,
approval and normal calls with exact postconditions. Batches reuse Protocol Kit's
MultiSendCallOnly. Two modes ship together: EIP-712 signature transport via local
store/handoff, and native Safe approveHash/approvedHashes. No new contracts or
social coordination service. The local store is the offchain coordination backend;
remote signers exchange handoffs and signatures explicitly. No hosted public relay.

Wallet support is EIP-6963 discovery plus EIP-1193 injection (MetaMask and compatible
providers, including Ambire where it exposes this interface). WalletConnect/mobile
QR pairing is outside v1. Automated browser coverage uses a deterministic injected
test wallet; individual real extension versions require a user-wallet smoke test.

Simulation is optional and off by default for wallet actions. The saved proposal
response includes a signing URL immediately. Missing, failed or expired simulation
does not prevent signing/execution; hash, chain, current owner, nonce and threshold
checks still apply. The UI offers a separate simulation action and an optional
actual-authorization execution fork. Results and freshness remain visible.

RPC errors identify method, stage, local/upstream hop and sanitized HTTP/RPC codes.
Read rate limits receive at most two retries. Anvil mines locally before receipt
polling so a newly submitted fork-only hash is not queried on the upstream network.

Private state defaults to ~/.local/share/agent-safe. AGENT_SAFE_DATA_DIR isolates
instances; AGENT_SAFE_ANVIL selects the binary. Networks can be configured via the
CLI `network` plan/apply command without exposing credentials in UI or handoffs.
Signing links have no time limit and can be opened repeatedly in different
browsers on this computer. Schema v2 stores proposal-scoped link tokens; the saved
loopback port keeps URLs stable across restarts. Restart preserves proposals,
signatures, attempts and signing links. Optional simulation freshness is separate. `recover ID HASH` binds already-broadcast transaction evidence.
No CLI command signs or broadcasts on a real network.

## Workspace

Opening the local root shows all saved proposals grouped by network/Safe. Each
proposal has an immutable ID and stable `/proposals/ID` URL, independent of the
conversation that created it. Saved details load without RPC; current chain reads
are separate and cached observations carry their observation timestamp. Remove
from list archives locally, with confirmation; Show archived proposals allows
restore. Signatures, approvals, attempts and links are preserved, not revoked.
The CLI exposes `dashboard` and `saved ID`; typed archive API details are in the
plugin runtime reference. Schema v3 adds tracking metadata in the existing store.

## Development and release

- `bunx tsc --noEmit -p tsconfig.agent-safe.json`
- `bun test tests/agent-safe` (opens only disposable loopback Anvil listeners)
- `bun scripts/build-agent-safe.ts`
- `bun scripts/export-agent-safe.ts /absolute/fresh/output`

The source export includes only Agent Safe apps/packages/tests/plugin and its own
package/TypeScript configuration. It builds without Farming Control aliases,
runtime, SQLite or private source. Keep the generated release lockfile with a
published source release after `bun install`. No monorepo publication is needed.
The test contract fixture comes from LocalSafe under its included MIT notice;
Safe dependencies retain their upstream licenses. License selection for original
project source is left to the repository owner before public distribution.

Architectural seams: safe-core owns hash/SDK compiler/receipt parsing; safe-fork
owns shared Anvil process lifecycle/execution; agent-safe-application owns immutable
proposals, postconditions, authorization and reconciliation; agent-safe-storage owns
its separate SQLite schema; apps/agent-safe composes typed API/CLI/settings and
sessions; apps/agent-safe-web is the stable wallet UI. FC compatibility wrappers
consume shared primitives. FC positions, protocol adapters, accounting and database
migrations do not change. See [the architecture decision](adr/0002-agent-safe-independent-runtime.md) for the intentional durable-proposal exception.


Version 0.1.6 removes RPC from EIP-712 signing and signature persistence. Link
responses include the complete handoff and ready-to-share prompt. The signing UI
can copy both. Execution and onchain approveHash remain chain operations. Offchain
browser regression configures an always-429 provider and asserts zero calls through
successful signing, signature persistence and reload, then restores RPC for execution.


Simulation starts Anvil with the configured RPC and no explicit fork block by
default. All Safe reads and checks occur inside Anvil; the actual fork block/hash
is recorded in the report. The simulation endpoint returns saved data and that
report directly without a before/after live-status lookup.

Version 0.1.7 preserves wallet provider selection across renders, clears the previous
connection when selecting another provider, and handles account changes on the active
provider. The UI displays the connected address and each cryptographically verified
saved signer independently of cached chain state. Browser coverage signs with two
distinct owners while RPC returns 429, checks stale-provider events, reloads the saved
signatures and executes only on a disposable local Anvil.

Version 0.1.8 explicitly includes the Safe EIP712Domain type (chainId uint256,
verifyingContract address) in wallet signing payloads. Omitting it allowed viem
to infer a domain that wallet signers did not infer, yielding different digests.
Tests use @metamask/eth-sig-util independently for hashing and browser signatures,
including a regression demonstrating the previous wrong recovered signer. Existing
proposal IDs and Safe hashes remain unchanged.

Version 0.1.9 exports handoff/v2 envelopes containing every locally saved signature.
Import validates each claimed signer, then atomically merges proposal and signatures.
The v1 proposal-only format remains accepted. The clipboard prompt requires no sender
URL: recipients import and sign or execute in their own instance. Re-export after signing
to include new signatures. Import plan responses include importedSigners and handoffDigest;
execution still validates current chain state. Tests cover independent receiver execution
after the sender is closed, replay merging, tampering and legacy compatibility.

Version 0.1.10 exposes Execute transaction on the saved proposal screen, including
after offline signing and reload. The existing execution action refreshes current
authorizations and nonce before requesting the wallet transaction. Pending submission
tracking uses the saved proposal ID even without a chain observation. Browser tests
execute directly from the saved screen with no separate Refresh action.

## Standalone repository setup

```sh
bun install --frozen-lockfile
bun run check
bun run build
bunx playwright install chromium
bun run test:browser
```

Install Foundry/Anvil to run the test suite. Browser tests use disposable local
Anvil accounts, never real wallets. They cover both authorization modes, two
independent offchain signers, portable handoffs, and execution from saved proposals.

The installable Codex plugin is `plugins/agent-safe`; its skill is
`plugins/agent-safe/skills/agent-safe/SKILL.md`. Rebuild the plugin after source changes.
Runtime data remains outside this repository, under `~/.local/share/agent-safe`
unless `AGENT_SAFE_DATA_DIR` is set. Do not copy that directory into Git.

This is a source snapshot extracted from Farming Control; its unrelated Git history
and operational data are not included. The original shared primitives remain there
for existing Farming Control consumers. PLAN.md and the ADR retain historical context.
