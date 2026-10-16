# Independent Agent Safe runtime and shared Safe primitives

Status: accepted for implementation, 2026-09-09. Operator authorization: implement
the independent plugin described in `docs/agent-safe-plugin-plan.md`.

Agent Safe is a separate product hosted in this workspace. It imports no Farming
Control application, database, settings or retained-runtime initialization.
`packages/safe-core` owns protocol-neutral Safe payload/hash/receipt primitives;
`packages/safe-fork` owns the single disposable Anvil runner and Safe fork executor.
Existing Farming Control entrypoints become compatibility adapters. Protocol
recipe assertions stay with their current consumers.

Unlike Farming Control's ephemeral executable plans, Agent Safe persists immutable
proposals and owner signatures in its own database for asynchronous cosigning.
This is an intentional product-specific persistence contract. Simulation evidence
is durable; freshness is invalidated on restart; signing links persist without time limits.
Neither expiration nor deletion revokes a Safe signature or approved hash on-chain.

Both authorization modes are initial requirements: EIP-712 signatures and native
Safe `approveHash`. No new contracts, registry or proposal-discovery service.
Operators transport handoff payloads themselves; Agent Safe generates and verifies
them but does not send email/messages. An optional relay only transports off-chain
proposals/signatures. Each receiving agent independently hashes and may request optional simulation.

Signing UI is static, versioned code. Local APIs are session scoped, authenticated,
and origin checked. Wallet signing and submission require explicit operator actions.
Simulation is optional by operator decision on 2026-09-10. Saving/importing a proposal
returns its signing URL immediately. No missing, failed or stale simulation blocks
signing/execution. An explicitly selected execution simulation uses actual signatures
or approved hashes and broadcaster balance; it is off by default. Hash validation always applies. Offchain EIP-712 signing and signature collection
are local-only; current owner, nonce and threshold validation applies to live
status and execution. Cryptographically valid collected signatures are not
a statement of current Safe authority. Unsupported Safe/owner configurations fail closed.

Release includes a standalone source export and plugin bundle. Clean-directory
build/tests must work without this monorepo or its TypeScript aliases.


The local workspace home lists all persisted proposals grouped by chain and Safe,
independently of RPC availability. Stable `/proposals/ID` pages bootstrap the local
browser workspace; proposal-scoped signing links remain reusable. Workspace API
access uses a same-origin HttpOnly cookie issued by local HTML; mutations require
same-origin JSON/browser headers. CLI APIs remain bearer authenticated. Schema v3
extends the existing product store with recoverable archive state and last observed
View/timestamp. These are observations, never authorization substitutes: execution and onchain approval
still call the current-state service; offchain signing uses the stored payload. No FC store/runtime or protocol adapters change.
