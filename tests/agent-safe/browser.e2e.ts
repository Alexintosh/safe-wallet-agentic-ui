// Explicit test: injected test wallet signs only against a disposable Anvil.
import { signTypedData, SignTypedDataVersion } from "@metamask/eth-sig-util";
import { mnemonicToAccount } from "viem/accounts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApp } from "../../apps/agent-safe/src/app";
import { Settings } from "../../apps/agent-safe/src/config";
import { AgentSafeService } from "../../packages/agent-safe-application/src/index";
import { AgentSafeStore } from "../../packages/agent-safe-storage/src/index";
import { accounts, fixture, recipient } from "./fixture";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const f = await fixture(); const dir = mkdtempSync(join(tmpdir(), "agent-safe-browser-"));
const settings = new Settings(dir); settings.save({ chainId: 8453, name: "Isolated", rpcUrl: f.url, confirmations: 1 });
const store = new AgentSafeStore(":memory:"); const service = new AgentSafeService(store, settings.chains, { anvilBinary: process.env.NO_SIM === "1" ? "/nonexistent/anvil" : `${process.env.HOME}/.foundry/bin/anvil` });
let origin = "http://127.0.0.1:0"; const app = createApp({ service, settings, origin: () => origin, token: "test-token", assets: resolve("plugins/agent-safe/assets/web") });
app.listen({ hostname: "127.0.0.1", port: 0, idleTimeout: 255 }); origin = `http://127.0.0.1:${app.server!.port}`;
const browser = await chromium.launch({ headless: true });
let deniedCalls=0;
const deniedRpc=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>{deniedCalls++;return Response.json({jsonrpc:'2.0',id:1,error:{code:-32016,message:'over rate limit'}},{status:429});}});
try {
 for (const mode of ["offchain", "onchain"] as const) {
  const safe = await f.deploy(mode === "offchain" ? 2 : 1, mode === "offchain" ? 2 : 1);
  const proposal = await (await fetch(`${origin}/api/proposals`, { method: "POST", headers: { authorization: "Bearer test-token", "content-type": "application/json" }, body: JSON.stringify({ chainId: 8453, safeAddress: safe, mode, intent: "Send exactly 1000 wei", operations: [{ kind: "native", to: recipient, value: "1000" }] }) })).json() as { id: string; signing: { url: string } };
  if (process.env.NO_SIM !== "1") await service.simulate(proposal.id);
  const link = proposal.signing;
  if(!(link as any).handoff?.prompt || !(link as any).handoff?.proposal?.transactionHash)throw new Error('Signing response omitted handoff');
  if(mode==='offchain')settings.save({chainId:8453,name:'Isolated unavailable RPC',rpcUrl:`http://127.0.0.1:${deniedRpc.port}`,confirmations:1});
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); const errors: string[] = []; page.setDefaultTimeout(15000);
  page.on("pageerror", (e: Error) => errors.push(e.message));
  const activeAccounts=[0,1];
  await page.exposeFunction("testWalletRequest", async ({ method, params, providerIndex=0 }: { method: string; params?: any[]; providerIndex?: number }) => {
    const signer=accounts[activeAccounts[providerIndex]!]!;
    if (["eth_requestAccounts", "eth_accounts"].includes(method)) return [signer.address];
    if (method === "eth_chainId") return "0x2105";
    if (method === "eth_signTypedData_v4") return signTypedData({ privateKey: Buffer.from(mnemonicToAccount("test test test test test test test test test test test junk", { addressIndex: activeAccounts[providerIndex]! }).getHdKey().privateKey!), data: JSON.parse(params![1]), version: SignTypedDataVersion.V4 });
    if (method === "eth_sendTransaction") {
      const tx = params![0]; if (tx.to.toLowerCase() !== safe.toLowerCase() || tx.chainId !== "0x2105") throw new Error("Test wallet rejects wrong Safe/chain");
      const hash = await f.wallet(0).sendTransaction({ to: tx.to, data: tx.data, value: BigInt(tx.value) });
      await f.publicClient.waitForTransactionReceipt({ hash }); return hash;
    }
    throw new Error(`Unexpected wallet request ${method}`);
  });
  await page.addInitScript(() => {
    const g=globalThis as any;
    g.testProviders=[0,1].map(providerIndex=>{
      const listeners=new Map<string,Set<(...args:any[])=>void>>();
      return {request:(args:any)=>g.testWalletRequest({...args,providerIndex}),
        on:(event:string,fn:any)=>{if(!listeners.has(event))listeners.set(event,new Set());listeners.get(event)!.add(fn);},
        removeListener:(event:string,fn:any)=>listeners.get(event)?.delete(fn),
        emit:(event:string,value:any)=>listeners.get(event)?.forEach(fn=>fn(value))};
    });
    g.ethereum={providers:g.testProviders};
  });
  await page.goto(origin);
  await page.getByText("Your Safes. Your proposals.",{exact:true}).waitFor();
  const row=page.getByRole("row").filter({hasText:proposal.id});
  await row.getByRole("button",{name:"Remove from list",exact:true}).click();
  await row.getByRole("button",{name:"Archive proposal",exact:true}).click();
  await page.getByLabel("Show archived proposals").check();
  await page.getByRole("row").filter({hasText:proposal.id}).getByRole("button",{name:"Restore",exact:true}).click();
  await page.goto(link.url);
  await page.getByText("Hash independently reproduced in this browser").waitFor().catch(async(e:Error)=>{console.error(await page.locator("body").innerText());throw e;});
  if(!page.url().includes("/proposals/"+proposal.id))throw new Error("Proposal ID missing from URL");
  if(mode!=="offchain")await page.getByRole("button",{name:"Refresh chain state",exact:true}).click();
  const second=await browser.newPage(); await second.goto(link.url);
  await second.getByText("Hash independently reproduced in this browser").waitFor();
  await second.getByText("No wallet extension detected in this browser.",{exact:true}).waitFor();
  await second.getByRole("button",{name:"Connect wallet",exact:true}).click();
  await second.getByText(/No wallet found/).waitFor();
  await second.close();
  await page.reload(); await page.getByText("Hash independently reproduced in this browser").waitFor().catch(async(e:Error)=>{console.error(await page.locator("body").innerText());throw e;});
  if (process.env.NO_SIM === "1" && mode!=="offchain") await page.getByText("Simulation not run. Anvil is optional; you can sign now.").waitFor();
  await page.getByRole("button", { name: "Connect wallet", exact: true }).click();
  await page.getByRole("button", { name: mode === "onchain" ? "Approve hash on-chain" : "Sign proposal", exact: true }).click();
  if(mode==='offchain'){
    await page.getByText(`Signature saved from ${accounts[0]!.address}. Current ownership and nonce will be checked before execution.`,{exact:true}).waitFor();
    await page.getByLabel('Wallet provider').selectOption('1');
    if(!await page.getByRole('button',{name:'Sign proposal',exact:true}).isDisabled())throw new Error('Previous wallet remained connected after provider selection');
    await page.getByRole('button',{name:'Connect wallet',exact:true}).click();
    if(await page.getByLabel('Wallet provider').inputValue()!=='1')throw new Error('Selected provider reset after rendering');
    await page.evaluate((address:string)=>(globalThis as any).testProviders[0].emit('accountsChanged',[address]),accounts[0]!.address);
    if(!(await page.locator('#connection').innerText()).includes(accounts[1]!.address))throw new Error('Old provider event changed active wallet');
    activeAccounts[1]=0;
    await page.evaluate((address:string)=>(globalThis as any).testProviders[1].emit('accountsChanged',[address]),accounts[0]!.address);
    await page.getByText('The connected account has already signed this proposal.',{exact:true}).waitFor();
    activeAccounts[1]=1;
    await page.evaluate((address:string)=>(globalThis as any).testProviders[1].emit('accountsChanged',[address]),accounts[1]!.address);
    await page.getByRole('button',{name:'Sign proposal',exact:true}).click();
    await page.getByText(`Signature saved from ${accounts[1]!.address}. Current ownership and nonce will be checked before execution.`,{exact:true}).waitFor();
    const sigPanel=page.locator('section').filter({has:page.getByRole('heading',{name:'Saved off-chain signatures',exact:true})});
    for(const owner of accounts.slice(0,2))await sigPanel.getByText(owner.address,{exact:true}).waitFor();
    await page.context().grantPermissions(['clipboard-read','clipboard-write']);
    await page.getByRole('button',{name:'Copy signer prompt and payload',exact:true}).click();
    await page.getByText(/Signer prompt, complete proposal and all saved signatures copied/).waitFor();
    const copied=await page.evaluate(()=>(navigator as Navigator & { clipboard: { readText(): Promise<string> } }).clipboard.readText());
    const envelope=JSON.parse(copied.split('Complete handoff JSON:\n')[1]!);
    if(envelope.signatures.length!==2||copied.includes(origin)||copied.includes('Proposal URL:'))throw new Error('Handoff clipboard omitted signatures or required sender URL');
    console.log('PASS portable clipboard includes both signatures without sender URL');
    console.log('PASS provider selection, account events, two distinct saved signatures with no RPC');
    if(deniedCalls!==0)throw new Error(`Signing made ${deniedCalls} upstream RPC calls`);
    await page.reload();await page.getByText(/2 cryptographically verified signature/).waitFor();
    settings.save({chainId:8453,name:'Isolated',rpcUrl:f.url,confirmations:1});
    await page.getByRole('button',{name:'Execute transaction',exact:true}).waitFor();
    if(!await page.getByRole('button',{name:'Execute transaction',exact:true}).isDisabled())throw new Error('Disconnected execution must require a wallet');
    await page.getByRole('button',{name:'Connect wallet',exact:true}).click();
  }
  if(mode === "onchain")await page.getByText("1 / 1", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Execute transaction", exact: true }).click();
  await page.getByText(/Safe execution succeeded/).waitFor({ timeout: 30000 }).catch(async (e: Error) => { console.error(await page.locator("body").innerText()); throw e; });
  if (errors.length) throw new Error(errors.join("\n"));
  await page.screenshot({ path: `/tmp/agent-safe-real-${mode}.png`, fullPage: true });
  const view = await service.view(proposal.id);
  if (!view.attempts.some(a => a.kind === "execute" && a.successful)) throw new Error("No successful Safe execution");
  await page.goto(origin); await page.getByText("Your Safes. Your proposals.",{exact:true}).waitFor();
  await page.screenshot({path:'/tmp/agent-safe-dashboard.png',fullPage:true});
  console.log(`PASS real API/browser/Anvil ${mode}; proxy runtime ${await f.publicClient.getCode({ address: safe })}`);
  await page.close();
 }
} finally { deniedRpc.stop(true); await browser.close(); await app.stop(); store.close(); rmSync(dir, { recursive: true }); await f.close(); }
