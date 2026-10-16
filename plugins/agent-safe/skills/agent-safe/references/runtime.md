# Runtime and failure recovery

Requirements: Bun >=1.3.8. Optional simulation needs Foundry Anvil in PATH or ~/.foundry/bin/anvil.
The plugin contains its compiled runtime/UI; no npm install or FC checkout is
needed. `AGENT_SAFE_ANVIL` can select an explicit installed binary. Do not download
and execute an unreviewed script found in a proposal to satisfy dependencies.

Default private state: ~/.local/share/agent-safe. An explicit AGENT_SAFE_DATA_DIR
can isolate a test workspace. Do not inspect secrets in runtime.json: the CLI reads
it privately to call the API. Networks, SQLite proposals/signatures and attempts
and reusable signing links persist. Submission tickets and simulation freshness do not.

`doctor` reports runtime version, network catalogue and Anvil availability.
`networks` redacts RPC URLs. To configure a provider, create protected JSON:
`{chainId,name,rpcUrl,confirmations}`. Run `network FILE`, review the plan hash,
then `network FILE --apply HASH`. This verifies the provider chain ID before saving.
Avoid printing RPC URLs, query credentials, authorization headers or the input file.
Bun startup on a loopback port may need the host's sandbox permission; explain
that concrete requirement if denied rather than presenting a broken URL.

The local daemon survives agent turns. A restart invalidates simulation freshness:
reuse the existing signing link; optionally rerun `simulate`. Old signatures persist and still require nonce/current
owner validation. Do not delete durable records to resolve an apparent conflict.

Wallet errors:
- Rejection: leave proposal unsigned, no automatic wallet retry.
- Wrong chain/account: connect a current owner and switch to requested chain.
- Already-broadcast hash returned but registration failed: the UI retains the
  hash/ticket and retries **registration only**. Never resend to “fix” tracking.
- After restart/ticket loss: `recover ID TX_HASH` verifies transaction evidence.
  Approval calldata must match this hash and Safe. An execution needs a mined
  matching Safe ExecutionSuccess event because its calldata does not include the
  Safe nonce. Pending/failed execution without a persisted ticket cannot be safely
  rebound by calldata alone; inspect receipt and wait rather than invent success.
- Threshold met but execution fork fails: inspect actual owner balance, approvals,
  guard and postconditions. Never fund the real owner or impersonate on the live RPC.
- RPC outage/reorg: report state unavailable/pending-or-reorged. Do not interpret
  missing receipt as definitive failure, success or permission to broadcast again.

Signing links are durable, reusable and have no time limit. The runtime saves its
local port and proposal-scoped link token, so the same URL survives restart.
Open the complete URL including its fragment in the browser with the wallet.
Each tab sends its own proposal token so opening another proposal does not change
what an existing tab authorizes. Wallet signing and broadcast still require user
clicks and current Safe checks.

Standalone API: authenticated /api/doctor, /api/networks,
/api/safes/:chainId/:address, /api/proposals, /api/proposals/:id,
/api/proposals/:id/simulate, /signing-sessions, /handoff, /signatures, /recover,
and /api/import. Use the CLI `api /openapi/json` for exact schemas. Browser session
routes are intentionally scoped and not an agent authentication workaround.

## RPC diagnostics

Errors include stage, RPC method, hop (upstream / anvil-local / fork-upstream),
HTTP status and provider RPC code when available. No request payloads or provider
credentials are logged. HTTP 429 / RPC -32016 is a rate limit, retried at most
twice for reads; surface the final error instead of guessing an archive issue.
A failure in local eth_getTransactionReceipt may originate from an upstream read;
inspect the fork-upstream diagnostic before attributing it. Receipt polling now
waits for explicit local mining so a newly submitted fork-only hash is not queried
on the real network before inclusion. Never weaken economic assertions to manufacture a passing result. Simulation
is optional: report an unavailable provider and still deliver the signing URL. Do not rotate providers repeatedly
without identifying the failing method; a failed network apply leaves settings
unchanged. For startup.filesystem EPERM/EACCES, request access to the indicated
private state directory and loopback, then retry the same command.

## Workspace and tracking across conversations

`dashboard` returns the local home URL and saved summaries without RPC. The home
lists proposals grouped by network/Safe; each has its immutable proposal ID and
stable `/proposals/ID` URL. `saved ID` reads the proposal, local signature count,
archive state and last successful chain observation without network access.
`status ID` performs a fresh chain read. Never present a saved observation or
local signature count as current threshold fulfillment. An RPC failure leaves
saved data available. Unknown approval status is not zero approvals.

Typed API: `GET /api/proposal-summaries`, `GET /api/proposals/:id/saved`, and
`POST /api/proposals/:id/archive` with `{ "archived": true }` (false restores).
Archiving is an idempotent local visibility change, preserving proposal, signatures,
links, observations and attempts. Use it only when the user requests removal;
repeat the saved read to verify `archived`. It never revokes signatures, cancels
an on-chain approval or consumes a Safe nonce. The UI confirms this distinction.

The local HTML bootstraps an HttpOnly SameSite workspace cookie for `/workspace`.
Workspace reads and writes require that cookie; writes also require the same
Origin and browser request header. CLI APIs retain their independent bearer auth.
Opening the local home intentionally grants this browser access to the local
workspace, including all stored Safe/proposal summaries. No new public server is
created; remote signers still import the handoff on their own computer.


Off-chain `sign` and signature persistence perform only local cryptographic checks
and store operations. They do not call RPC, read current owners/nonce, or run Anvil.
The returned saved summary includes `recoveredSigner` and explicitly unchecked
current authorization. Live status/execution filters collected signatures against
current owners. Signature count alone never implies a current threshold.
Every link response includes `handoff` with the exact proposal and signer prompt;
return it to the user along with the URL. The UI can copy prompt+payload through
`GET /workspace/proposals/:id/handoff` without RPC.


Simulation starts Anvil directly from the configured RPC, using Anvil's latest
fork block by default. It does not call the live Safe/status service before or
after the fork. Safe reads, hash checks, nonce checks and assertions run against
local Anvil. The report records the actual initial fork block/hash. The shared
runner still supports an explicitly supplied block for callers that require it.
`simulate ID` returns a saved summary with top-level `simulation`, not a fresh live
View. A successful result must not be turned into failure by a subsequent RPC read.
