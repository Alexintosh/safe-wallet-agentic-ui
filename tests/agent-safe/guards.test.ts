import { test, expect } from "bun:test";
import { AgentSafeService, canonical, strictJson } from "../../packages/agent-safe-application/src/index";
import { AgentSafeStore } from "../../packages/agent-safe-storage/src/index";
import { typedData } from "../../packages/safe-core/src/index";
import { keccak256, toHex } from "viem";
import { accounts, fixture, recipient } from "./fixture";

test("strict handoff parser rejects duplicate keys and excess depth", () => {
  expect(() => strictJson('{"nonce":1,"nonce":2}')).toThrow("Duplicate");
  expect(() => strictJson("[".repeat(60) + "0" + "]".repeat(60))).toThrow();
});
test("1/1 batch, immutable plan CAS, tamper rejection, wrong owner, expiry, unchanged live chain", async () => {
  const f = await fixture(); const store = new AgentSafeStore(":memory:"); let now = Date.now();
  const svc = new AgentSafeService(store, new Map([[8453, { chainId: 8453, name: "test", rpcUrl: f.url, confirmations: 1 }]]), { anvilBinary: `${process.env.HOME}/.foundry/bin/anvil`, now: () => now });
  try {
    const safe = await f.deploy(1, 1);
    const input = { chainId: 8453, safeAddress: safe, mode: "offchain" as const, intent: "Two transfers", operations: [
      { kind: "native" as const, to: recipient, value: "100" }, { kind: "native" as const, to: recipient, value: "200" }] };
    const plan = await svc.prepare(input, false); expect(store.list()).toHaveLength(0);
    await expect(svc.applyPlan(plan.id, { ...input, intent: "changed" })).rejects.toThrow("input changed");
    const p = await svc.applyPlan(plan.id, input); expect(p.transaction.operation).toBe(1);
    const nonceBefore = (await svc.inspect(8453, safe)).nonce;
    const balanceBefore = await f.publicClient.getBalance({ address: recipient });
    expect((await svc.simulate(p.id)).passed).toBe(true);
    expect((await svc.inspect(8453, safe)).nonce).toBe(nonceBefore);
    expect(await f.publicClient.getBalance({ address: recipient })).toBe(balanceBefore);
    const unknownSignature = await accounts[1]!.signTypedData(typedData(p, p.transaction));
    expect((await svc.addSignature(p.id, unknownSignature)).recoveredSigner).toBe(accounts[1]!.address);
    expect((await svc.view(p.id)).signatures).toHaveLength(0);
    const handoff = svc.handoff(p.id); handoff.proposal.transaction = { ...handoff.proposal.transaction, value: "999" };
    handoff.digest = keccak256(toHex(canonical({ schema: handoff.schema, proposal: handoff.proposal, signatures: handoff.signatures })));
    await expect(svc.importHandoff(JSON.stringify(handoff))).rejects.toThrow("hash mismatch");
    const signature = await accounts[0]!.signTypedData(typedData(p, p.transaction)); await svc.addSignature(p.id, signature);
    now += 600_001;
    expect(await svc.action(p.id, "sign", accounts[0]!.address)).toHaveProperty("typedData");
    expect((await svc.view(p.id)).simulation?.fresh).toBe(false);
    expect((await svc.view(p.id)).signatures).toHaveLength(1);
    const fresh = await svc.prepare(input, false);
    await f.rpc("anvil_setStorageAt", [safe, "0x5", "0x" + "1".padStart(64, "0")]); await f.rpc("evm_mine", []);
    await expect(svc.applyPlan(fresh.id, input)).rejects.toThrow("state changed");
  } finally { store.close(); await f.close(); }
}, 120_000);
