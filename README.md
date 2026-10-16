# Agent Safe — AI Agent Toolkit for Safe Multisig Wallets

Operate your Safe wallet through a conversation. Prepare transactions, collect signatures and execute from a local signing UI—with your own wallet.

## Why Agent Safe?

Your multisig should remain usable when a hosted frontend is compromised or an API goes down.

Agent Safe provides an independent way to operate Safe smart accounts, without Safe’s hosted frontend, Transaction Service or backend stack. Running the signing UI locally removes the hosted frontend from your signing workflow and gives you another route to your funds when those services are unavailable.

**Your agent prepares. Your wallet signs. You decide what executes.**

## How to use it

With [Bun](https://bun.sh) installed, give Codex this repository and ask:

> Install the Agent Safe plugin from `plugins/agent-safe`.

Then start a new conversation:

> My Safe is `0x…` on Base. Prepare a transfer of 1 USDC to `0x…` using offchain signatures.

1. **Review** the transaction with your agent. Optionally simulate it on an Anvil fork.
2. **Sign** through the local link using Rabby, MetaMask or a compatible wallet.
3. **Collect and execute.** Share the proposal and collected signatures with the other signers. Each imports them into their own Agent Safe and signs locally. Once the threshold is met, execute through your wallet.

Native onchain approvals are also supported. Other signers never need access to your local URL.

[Setup & technical reference](docs/reference.md) · [Signer handoffs](plugins/agent-safe/skills/agent-safe/references/handoff.md) · [Architecture](docs/adr/0002-agent-safe-independent-runtime.md)
