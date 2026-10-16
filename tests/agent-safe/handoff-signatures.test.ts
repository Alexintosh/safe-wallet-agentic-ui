import { test, expect } from 'bun:test';
import { keccak256, toHex } from 'viem';
import { AgentSafeStore } from '../../packages/agent-safe-storage/src/index';
import { AgentSafeService, canonical } from '../../packages/agent-safe-application/src/index';
import { typedData } from '../../packages/safe-core/src/index';
import { fixture, accounts, recipient } from './fixture';

test('independent signer imports collected signatures, merges replays and executes without sender access',async()=>{
 const f=await fixture();const a=new AgentSafeStore(':memory:');const b=new AgentSafeStore(':memory:');
 const chains=new Map([[8453,{chainId:8453,name:'fixture',rpcUrl:f.url,confirmations:1}]]);
 const sender=new AgentSafeService(a,chains), receiver=new AgentSafeService(b,chains);
 try{
  const safe=await f.deploy(2,2);
  const p=await sender.prepare({chainId:8453,safeAddress:safe,mode:'offchain',intent:'Independent handoff',operations:[{kind:'native',to:recipient,value:'1'}]});
  await sender.addSignature(p.id,await accounts[0]!.signTypedData(typedData(p,p.transaction)));
  const h=sender.handoff(p.id), payload=JSON.stringify(h);
  expect(h.signatures).toHaveLength(1);expect(payload).not.toContain('127.0.0.1');
  await receiver.importHandoff(payload);expect(b.list()).toHaveLength(0);
  const bad=structuredClone(h);bad.signatures[0]!.owner=accounts[1]!.address;
  bad.digest=keccak256(toHex(canonical({schema:bad.schema,proposal:bad.proposal,signatures:bad.signatures})));
  await expect(receiver.importHandoff(JSON.stringify(bad),true)).rejects.toThrow('owner mismatch');expect(b.list()).toHaveLength(0);
  await receiver.importHandoff(payload,true);expect(receiver.summary(p.id).signatureCount).toBe(1);
  await receiver.addSignature(p.id,await accounts[1]!.signTypedData(typedData(p,p.transaction)));
  await receiver.importHandoff(payload,true);expect(receiver.summary(p.id).signatureCount).toBe(2);
  const roundtrip=receiver.handoff(p.id);expect(roundtrip.digest).not.toBe(h.digest);expect(roundtrip.proposal.id).toBe(p.id);
  await sender.importHandoff(JSON.stringify(roundtrip),true);expect(sender.summary(p.id).signatureCount).toBe(2);
  const legacyBody={schema:'agent-safe-handoff/v1',proposal:p};
  await receiver.importHandoff(JSON.stringify({...legacyBody,digest:keccak256(toHex(canonical(legacyBody)))}),true);
  expect(receiver.summary(p.id).signatureCount).toBe(2);
  a.close(); // Sender is no longer available. Receiver has everything needed.
  const action=await receiver.action(p.id,'execute',accounts[1]!.address);
  const hash=await f.wallet(1).sendTransaction({to:action.transaction!.to,data:action.transaction!.data});
  await f.publicClient.waitForTransactionReceipt({hash});
  expect((await receiver.submitted(p.id,hash,action.ticket!)).attempts.some(x=>x.successful)).toBe(true);
 }finally{try{a.close();}catch{}b.close();await f.close();}
},60000);
