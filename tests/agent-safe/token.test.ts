import { test, expect } from "bun:test";
import { parseAbi, type Hex } from "viem";
import { fixture, recipient } from "./fixture";
import token from "./fixtures/test-token.json";
import { AgentSafeService } from "../../packages/agent-safe-application/src/index";
import { AgentSafeStore } from "../../packages/agent-safe-storage/src/index";

test("ERC20 transfer and exact allowance postconditions; incorrect custom assertion fails", async () => {
  const f = await fixture(); const store = new AgentSafeStore(":memory:");
  const svc = new AgentSafeService(store, new Map([[8453, { chainId: 8453, name: "test", rpcUrl: f.url, confirmations: 1 }]]), { anvilBinary: `${process.env.HOME}/.foundry/bin/anvil` });
  try {
    const safe = await f.deploy(1, 1);
    const tx = await f.wallet(0).deployContract({ abi: token.abi, bytecode: token.bytecode as Hex });
    const tokenAddress = (await f.publicClient.waitForTransactionReceipt({ hash: tx })).contractAddress!;
    const mint = await f.wallet(0).writeContract({ address: tokenAddress, abi: parseAbi(["function mint(address account,uint256 amount)"]), functionName: "mint", args: [safe, 10000n] });
    await f.publicClient.waitForTransactionReceipt({ hash: mint });
    const p = await svc.prepare({ chainId: 8453, safeAddress: safe, mode: "onchain", intent: "Transfer token and approve exact amount", operations: [
      { kind: "erc20-transfer", token: tokenAddress, to: recipient, amount: "1000" },
      { kind: "erc20-approve", token: tokenAddress, spender: recipient, amount: "500" }] });
    const proof = await svc.simulate(p.id); expect(proof.passed).toBe(true); expect(proof.assertions).toHaveLength(5);
    const bad = await svc.prepare({ chainId: 8453, safeAddress: safe, mode: "offchain", intent: "Deliberately incorrect test postcondition", operations: [
      { kind: "call", to: recipient, value: "0", data: "0x", label: "No-op test", assertions: [{ kind: "token-delta", token: tokenAddress, account: safe, delta: "1" }] }] });
    expect((await svc.simulate(bad.id)).passed).toBe(false);
    expect(await svc.action(bad.id, "sign", (await svc.inspect(8453, safe)).owners[0]!)).toHaveProperty("typedData");
  } finally { store.close(); await f.close(); }
}, 120_000);
