# Agent Safe

Independent Bun/TypeScript product. This repository is the development home for Agent Safe.

- Runtime/API/CLI: apps/agent-safe. Wallet UI: apps/agent-safe-web.
- Safe crypto/compilation: packages/safe-core. Anvil: packages/safe-fork.
- Application policy: packages/agent-safe-application. SQLite: packages/agent-safe-storage.
- Distributable plugin and agent skill: plugins/agent-safe. Tests: tests/agent-safe.
- Read README.md, PLAN.md and docs/adr/0002-agent-safe-independent-runtime.md before changing architecture.
- Keep imports within these packages; do not depend on Farming Control.
- Preserve exact integer amounts, immutable proposal identities and Safe hashes.
- Ask for onchain/offchain mode for new proposals. Preserve imported modes.
- Offchain signing must not depend on RPC or Anvil. Simulation is optional.
- Signing links have no time limit. Persist proposals, signatures and submission recovery.
- Handoffs include all collected signatures; remote signers use their own local instance.
- Real signing and broadcast happen only through explicit user wallet actions.
- Use dedicated temporary data directories and ports for tests. Never use retained user data.
- Do not commit credentials, database files, runtime metadata or user proposals.
- Keep UI text English and update the plugin skill when operator behavior changes.
- Validate with bun run check, bun run build and bun run test:browser for UI changes.
- Anvil is required for tests; it remains optional for normal product use.
