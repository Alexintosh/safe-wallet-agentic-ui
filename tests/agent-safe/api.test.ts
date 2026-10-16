import { RpcDiagnosticError, safeTransactionHash, ZERO_ADDRESS } from "../../packages/safe-core/src/index";
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../apps/agent-safe/src/app";
import { Settings } from "../../apps/agent-safe/src/config";
import { AgentSafeService } from "../../packages/agent-safe-application/src/index";
import { AgentSafeStore } from "../../packages/agent-safe-storage/src/index";

test("API authentication, host/origin isolation, typed schemas and durable reusable scoped links", async () => {
 const dir = mkdtempSync(join(tmpdir(), "agent-safe-api-")); const store = new AgentSafeStore(":memory:"); const settings = new Settings(dir);
 const svc = new AgentSafeService(store, settings.chains); const origin = "http://127.0.0.1:19777";
 const app = createApp({ service: svc, settings, origin: () => origin, token: "secret", assets: "plugins/agent-safe/assets/web" });
 const req = (path: string, init: RequestInit = {}) => app.handle(new Request(origin + path, { ...init, headers: { host: "127.0.0.1:19777", ...(init.headers as Record<string,string> ?? {}) } }));
 try {
  expect((await req("/api/doctor")).status).toBe(401);
  expect((await req("/api/doctor", { headers: { authorization: "Bearer secret", origin: "https://evil.example" } })).status).toBe(403);
  expect((await req("/api/doctor", { headers: { authorization: "Bearer secret", host: "evil.example" } })).status).toBe(403);
  expect((await req("/api/doctor", { headers: { authorization: "Bearer secret" } })).status).toBe(200);
  expect((await req("/api/proposals", { method: "POST", headers: { authorization: "Bearer secret", "content-type": "application/json" }, body: JSON.stringify({ chainId: 1 }) })).status).toBe(400);
  svc.inspect = async () => { throw new Error("wrapped", { cause: new RpcDiagnosticError([{ stage: "prepare.compile", hop: "upstream", method: "eth_call", httpStatus: 429, rpcCode: -32016, detail: "over rate limit" }]) }); };
  const rpcFailure = await (await req("/api/safes/8453/0x1111111111111111111111111111111111111111", { headers: { authorization: "Bearer secret" } })).json() as any;
  expect(rpcFailure.error).toContain("eth_call; HTTP 429; RPC -32016");
  expect(rpcFailure.diagnostics[0].stage).toBe("prepare.compile");
  const missingSession = await req("/session/proposal");
  expect(missingSession.status).toBe(401);
  expect((await missingSession.json() as any).error).toContain("No signing session");
  expect((await (await req("/session/proposal", { headers: { cookie: "agent_safe=unknown" } })).json() as any).error).toContain("not recognized");
  const tx = { to: ZERO_ADDRESS, value: "0", data: "0x" as const, operation: 0 as const, safeTxGas: "0", baseGas: "0", gasPrice: "0", gasToken: ZERO_ADDRESS, refundReceiver: ZERO_ADDRESS, nonce: "0" };
  store.addProposal("a", { id: "a", chainId: 1, safeAddress: ZERO_ADDRESS, transaction: tx, transactionHash: safeTransactionHash({ chainId: 1, safeAddress: ZERO_ADDRESS }, tx) });
  const link = await (await req("/api/proposals/a/signing-sessions", { method: "POST", headers: { authorization: "Bearer secret", "content-type": "application/json" }, body: "{}" })).json() as { url: string };
  const token = new URLSearchParams(new URL(link.url).hash.slice(1)).get("token");
  const init = { method: "POST", headers: { origin, "x-agent-safe": "browser", "content-type": "application/json" }, body: JSON.stringify({ token }) };
  const exchange = await req("/session/exchange", init); expect(exchange.status).toBe(200);
  expect(exchange.headers.get("set-cookie")).toContain("HttpOnly; SameSite=Strict; Path=/session");
  const reused = await req("/session/exchange", init);
  expect(reused.status).toBe(200);
  expect(exchange.headers.get("set-cookie")).not.toContain("Max-Age");
  const originalView = svc.view.bind(svc); svc.view = async () => ({ ok: true }) as any;
  const cookie = exchange.headers.get("set-cookie")!.split(";")[0]!;
  expect((await req("/session/proposal", { headers: { cookie } })).status).toBe(200);
  const repeatedLink = await (await req("/api/proposals/a/signing-sessions", { method: "POST", headers: { authorization: "Bearer secret", "content-type": "application/json" }, body: "{}" })).json() as any;
  expect(repeatedLink.url).toBe(link.url);
  expect(repeatedLink.expiresAt).toBeNull();
  const before = Date.now; Date.now = () => before() + 10 * 365 * 86400000;
  try {
    expect((await req("/session/exchange", init)).status).toBe(200);
    expect((await req("/session/proposal", { headers: { cookie } })).status).toBe(200);
  } finally { Date.now = before; }
  svc.view = originalView;
  expect((await req("/openapi/json", { headers: { authorization: "Bearer secret" } })).status).toBe(200);
 } finally { store.close(); rmSync(dir, { recursive: true }); }
});


test("signing link survives store reopen and API restart; tab scope overrides another proposal cookie", async () => {
 const dir=mkdtempSync(join(tmpdir(), "agent-safe-session-")); const path=join(dir,"safe.sqlite");
 let store=new AgentSafeStore(path);
 try {
  store.addProposal("a",{id:"a"}); store.addProposal("b",{id:"b"});
  const token=store.signingToken("a"), other=store.signingToken("b");
  store.close(); store=new AgentSafeStore(path);
  expect(store.signingToken("a")).toBe(token);
  const svc=new AgentSafeService(store,new Settings(dir).chains);
  svc.view=async (id:string)=>({id}) as any;
  const origin="http://127.0.0.1:19778";
  const app=createApp({service:svc,settings:new Settings(dir),origin:()=>origin,token:"secret",assets:"plugins/agent-safe/assets/web"});
  const response=await app.handle(new Request(origin+"/session/proposal",{headers:{host:"127.0.0.1:19778",cookie:"agent_safe="+other,"x-agent-safe-session":token}}));
  expect(response.status).toBe(200); expect(await response.json()).toEqual({id:"a"});
 } finally {store.close();rmSync(dir,{recursive:true});}
});

test("workspace lists saved proposals without RPC, scopes local writes, archives/restores without deleting authorizations", async () => {
 const dir=mkdtempSync(join(tmpdir(),"agent-safe-workspace-"));const store=new AgentSafeStore(":memory:");const settings=new Settings(dir);
 const svc=new AgentSafeService(store,settings.chains); const origin="http://127.0.0.1:19779";
 const tx={to:ZERO_ADDRESS,value:"0",data:"0x" as const,operation:0 as const,safeTxGas:"0",baseGas:"0",gasPrice:"0",gasToken:ZERO_ADDRESS,refundReceiver:ZERO_ADDRESS,nonce:"0"};
 const proposal={id:"a",chainId:1,safeAddress:ZERO_ADDRESS,transaction:tx,transactionHash:safeTransactionHash({chainId:1,safeAddress:ZERO_ADDRESS},tx),mode:"offchain",intent:"Stored proposal",createdAt:1,calls:[],assertions:[],operations:[]};
 store.addProposal("a",proposal);store.addSignature("a",ZERO_ADDRESS,"0x1234");const token=store.signingToken("a");
 svc.client=()=>{throw new Error("RPC unavailable")};
 const app=createApp({service:svc,settings,origin:()=>origin,remoteOrigin:"https://mini.example.ts.net",token:"secret",assets:"plugins/agent-safe/assets/web"});
 const req=(path:string,headers:Record<string,string>={},body?:unknown)=>app.handle(new Request(origin+path,{method:body===undefined?"GET":"POST",headers:{host:"127.0.0.1:19779",...headers},...(body===undefined?{}:{body:JSON.stringify(body)})}));
 try {
  expect((await req("/workspace/proposals")).status).toBe(401);
  const home=await req("/"); const cookie=home.headers.get("set-cookie")!.split(";")[0]!;
  expect(cookie).toStartWith("agent_safe_workspace=");
  const rows=await (await req("/workspace/proposals",{cookie})).json() as any[];
  expect(rows).toHaveLength(1);expect(rows[0].proposal.id).toBe("a");expect(rows[0].view).toBeNull();expect(rows[0].signatureCount).toBe(1);
  expect((await req("/workspace/proposals/a",{cookie})).status).toBe(200);
  const mutation={cookie,origin,"content-type":"application/json","x-agent-safe":"browser"};
  expect((await req("/workspace/proposals/a/archive",{...mutation,origin:"https://evil.example"},{archived:true})).status).toBe(403);
  expect((await req("/workspace/proposals/a/archive",{cookie,"content-type":"application/json"},{archived:true})).status).toBe(403);
  expect((await req("/workspace/proposals/a/archive",mutation,{archived:true})).status).toBe(200);
  expect(svc.summary("a").archived).toBe(true);expect(store.getProposal<typeof proposal>("a")).toEqual(proposal);
  expect(store.signatures("a")).toHaveLength(1);expect(store.signingToken("a")).toBe(token);
  expect((await req("/workspace/proposals/a/archive",mutation,{archived:false})).status).toBe(200);
  expect(svc.summary("a").archived).toBe(false);
  expect((await req("/workspace/proposals/a/refresh",mutation,{})).status).toBe(400);
  expect((await req("/workspace/proposals/a",{cookie})).status).toBe(200);
  const link=await (await req("/workspace/proposals/a/link",mutation,{})).json() as any;
  expect(new URL(link.url).pathname).toBe("/proposals/a");expect(link.expiresAt).toBeNull();
  expect((await req("/proposals/a")).status).toBe(200);
  const remote = (host:string, requestOrigin:string) => app.handle(new Request(`http://${host}/workspace/proposals/a/archive`, { method:"POST", headers:{host,origin:requestOrigin,cookie,"content-type":"application/json","x-agent-safe":"browser"},body:JSON.stringify({archived:false}) }));
  expect((await remote("mini.example.ts.net","https://mini.example.ts.net")).status).toBe(200);
  expect((await remote("mini.example.ts.net","https://evil.example")).status).toBe(403);
  expect((await remote("other.example.ts.net","https://other.example.ts.net")).status).toBe(403);
  expect((await remote("mini.example.ts.net",origin)).status).toBe(403);
 } finally {store.close();rmSync(dir,{recursive:true});}
});
