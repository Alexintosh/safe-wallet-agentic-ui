import { test, expect } from "bun:test";
import { AgentSafeStore } from "../../packages/agent-safe-storage/src/index";
import { AgentSafeService } from "../../packages/agent-safe-application/src/index";
import { typedData, type SafeTransactionData } from "../../packages/safe-core/src/index";
import { accounts, fixture, recipient } from "./fixture";
import type { Hex, Address } from "viem";

for (const version of ["1.3.0", "1.4.1"]) for (const mode of ["offchain", "onchain"] as const) test(`Anvil end-to-end 2/3 ${version} ${mode}: independent handoff, signature/approval, exact fork, broadcast and restart`, async () => {
  const f = await fixture(); const store = new AgentSafeStore(":memory:"); const otherStore = new AgentSafeStore(":memory:");
  const chains = new Map([[8453, { chainId: 8453, name: "Test isolated Anvil", rpcUrl: f.url, confirmations: 1 }]]);
  const options = { anvilBinary: `${process.env.HOME}/.foundry/bin/anvil` };
  let svc = new AgentSafeService(store, chains, options); const other = new AgentSafeService(otherStore, chains, options);
  try {
    const safe = await f.deploy(2, 3, version);
    const p = await svc.prepare({ chainId: 8453, safeAddress: safe, mode, intent: "Send 1000 wei", operations: [{ kind: "native", to: recipient, value: "1000" }] });
    expect((await svc.simulate(p.id)).passed).toBe(true);
    const handoff = svc.handoff(p.id); expect((await other.importHandoff(JSON.stringify(handoff))).id).toBe(p.id);
    await other.importHandoff(JSON.stringify(handoff), true); expect((await other.simulate(p.id)).passed).toBe(true);
    for (let i = 0; i < 2; i++) {
      if (mode === "offchain") {
        const signature = await accounts[i]!.signTypedData(typedData(p, p.transaction));
        await (i === 0 ? svc : other).addSignature(p.id, signature);
        if (i === 1) await svc.addSignature(p.id, signature);
      } else {
        const s = i === 0 ? svc : other;
        const action = await s.action(p.id, "approve", accounts[i]!.address);
        if (!("transaction" in action)) throw new Error("Missing transaction");
        const hash = await f.wallet(i).sendTransaction({ to: action.transaction!.to, data: action.transaction!.data });
        await f.publicClient.waitForTransactionReceipt({ hash });
        await s.submitted(p.id, hash, action.ticket!);
      }
    }
    const ready = await svc.view(p.id); expect(mode === "offchain" ? ready.signatures.length : ready.approvals.filter(a => a.approved).length).toBe(2);
    const action = await svc.action(p.id, "execute", accounts[0]!.address, { simulate: true });
    if (!("transaction" in action)) throw new Error("Missing transaction");
    expect((await svc.view(p.id)).simulation?.mode).toBe("actual");
    const before = await f.publicClient.getBalance({ address: recipient });
    const hash = await f.wallet(0).sendTransaction({ to: action.transaction!.to, data: action.transaction!.data });
    await f.publicClient.waitForTransactionReceipt({ hash });
    const done = await svc.submitted(p.id, hash, action.ticket!);
    expect(done.attempts.find(a => a.hash === hash)?.successful).toBe(true);
    expect(await f.publicClient.getBalance({ address: recipient })).toBe(before + 1000n);
    svc = new AgentSafeService(store, chains, options);
    expect((await svc.view(p.id)).simulation).toBe(null);
    expect((await svc.recoverAttempt(p.id, hash)).attempts.find(a => a.hash === hash)?.status).toBe("confirmed");
    await expect(svc.action(p.id, "execute", accounts[0]!.address)).rejects.toThrow("nonce changed");
  } finally { store.close(); otherStore.close(); await f.close(); }
}, 180_000);

test("no Anvil installed: sign and execute in both modes without simulation; opt-in still runs it", async () => {
 const f = await fixture(); const store = new AgentSafeStore(":memory:");
 const svc = new AgentSafeService(store, new Map([[8453, { chainId: 8453, name: "test", rpcUrl: f.url, confirmations: 1 }]]), { anvilBinary: "/nonexistent/anvil" });
 try {
  for (const mode of ["offchain", "onchain"] as const) {
   const safe = await f.deploy(1, 1);
   const p = await svc.prepare({ chainId: 8453, safeAddress: safe, mode, intent: "Urgent transfer without simulation", operations: [{ kind: "native", to: recipient, value: "1" }] });
   if (mode === "offchain") {
    expect(await svc.action(p.id, "sign", accounts[0]!.address)).toHaveProperty("typedData");
    await svc.addSignature(p.id, await accounts[0]!.signTypedData(typedData(p, p.transaction)));
   } else {
    const approval = await svc.action(p.id, "approve", accounts[0]!.address);
    const hash = await f.wallet(0).sendTransaction({ to: approval.transaction!.to, data: approval.transaction!.data });
    await f.publicClient.waitForTransactionReceipt({ hash });
   }
   await expect(svc.action(p.id, "execute", accounts[0]!.address, { simulate: true })).rejects.toThrow();
   const execution = await svc.action(p.id, "execute", accounts[0]!.address);
   expect((await svc.view(p.id)).simulation).toBe(null);
   const hash = await f.wallet(0).sendTransaction({ to: execution.transaction!.to, data: execution.transaction!.data });
   await f.publicClient.waitForTransactionReceipt({ hash });
   expect((await svc.submitted(p.id, hash, execution.ticket!)).attempts[0]?.successful).toBe(true);
  }
 } finally { store.close(); await f.close(); }
}, 60_000);

test("offchain signing and signature persistence work with no configured RPC; execution still checks chain state", async () => {
 const f=await fixture();const store=new AgentSafeStore(":memory:");
 try {
  const preparation=new AgentSafeService(store,new Map([[8453,{chainId:8453,name:"test",rpcUrl:f.url,confirmations:1}]]));
  const safe=await f.deploy(1,1);
  const p=await preparation.prepare({chainId:8453,safeAddress:safe,mode:"offchain",intent:"Sign offline",operations:[{kind:"native",to:recipient,value:"1"}]});
  const offline=new AgentSafeService(store,new Map(),{anvilBinary:"/nonexistent/anvil"});
  const action=await offline.action(p.id,"sign",accounts[0]!.address);
  expect(action).toHaveProperty("typedData");
  const sig=await accounts[0]!.signTypedData(typedData(p,p.transaction));
  const saved=await offline.addSignature(p.id,sig);
  expect(saved.signatureCount).toBe(1);expect(saved.recoveredSigner).toBe(accounts[0]!.address);
  expect(saved.view).toBeNull();
  const restarted=new AgentSafeService(store,new Map());expect(restarted.summary(p.id).signatureCount).toBe(1);
  await expect(restarted.action(p.id,"execute",accounts[0]!.address)).rejects.toThrow("Configure RPC");
  await expect(restarted.addSignature(p.id,"0x1234")).rejects.toThrow("65-byte");
  expect(restarted.handoff(p.id).proposal.transactionHash).toBe(p.transactionHash);
 } finally {store.close();await f.close();}
});

test("simulation starts at Anvil latest without live Safe reads and returns result without live status", async () => {
 const f=await fixture();const store=new AgentSafeStore(":memory:");
 const svc=new AgentSafeService(store,new Map([[8453,{chainId:8453,name:"test",rpcUrl:f.url,confirmations:1}]]),{anvilBinary:`${process.env.HOME}/.foundry/bin/anvil`});
 try {
  const safe=await f.deploy(1,1);
  const p=await svc.prepare({chainId:8453,safeAddress:safe,mode:"offchain",intent:"Fork chooses latest",operations:[{kind:"native",to:recipient,value:"1"}]});
  await svc.view(p.id); // Cache a pre-simulation view with no report.
  await f.rpc("evm_mine",[]);await f.rpc("evm_mine",[]);
  const latest=BigInt((await f.rpc("eth_blockNumber",[]) as string));
  svc.client=()=>{throw new Error("Unexpected live client: simulation must read Safe only inside Anvil")};
  const {createApp}=await import("../../apps/agent-safe/src/app");
  const {Settings}=await import("../../apps/agent-safe/src/config");
  const {mkdtempSync,rmSync}=await import("node:fs");const dir=mkdtempSync("/tmp/agent-safe-fork-api-");
  try {
   const origin="http://127.0.0.1:19780";
   const app=createApp({service:svc,settings:new Settings(dir),origin:()=>origin,token:"test",assets:"plugins/agent-safe/assets/web"});
   const r=await app.handle(new Request(origin+"/api/proposals/"+p.id+"/simulate",{method:"POST",headers:{host:"127.0.0.1:19780",authorization:"Bearer test","content-type":"application/json"},body:"{}"}));
   const result=await r.json() as any;
   expect(r.status).toBe(200);expect(result.simulation.passed).toBe(true);
   expect(result.simulation.blockNumber).toBe(String(latest));expect(result.view.simulation.id).toBe(result.simulation.id);
   expect(result.simulation.assertions.every((a:any)=>a.passed)).toBe(true);
   expect(new AgentSafeService(store,new Map()).summary(p.id).simulation?.id).toBe(result.simulation.id);
   expect(BigInt((await f.rpc("eth_blockNumber",[]) as string))).toBe(latest);
  } finally {rmSync(dir,{recursive:true});}
 } finally {store.close();await f.close();}
});
