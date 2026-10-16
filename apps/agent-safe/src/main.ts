import { join, resolve, dirname } from "node:path";
import { existsSync, mkdirSync, rmSync, openSync, closeSync } from "node:fs";
import { spawn } from "node:child_process";
import { AgentSafeService, strictJson, canonical } from "../../../packages/agent-safe-application/src/index";
import { AgentSafeStore } from "../../../packages/agent-safe-storage/src/index";
import { keccak256, toHex } from "viem";
import { createApp } from "./app";
import { dataDirectory, Settings, protectDirectory, readPrivate, writePrivate } from "./config";
interface Runtime { url: string; token: string; pid: number; version: string }
const directory = resolve(dataDirectory());
const metadata = join(directory, "runtime.json");
const entry = process.argv[1]!;
async function request(runtime: Runtime, path: string, method = "GET", body?: unknown) {
  const response = await fetch(runtime.url + path, { method, headers: { authorization: `Bearer ${runtime.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(180_000) });
  const result = await response.json() as { error?: string; diagnostics?: unknown };
  if (!response.ok) { const error = new Error(result.error ?? `API ${response.status}`); Object.assign(error, { diagnostics: result.diagnostics }); throw error; }
  return result;
}
async function live(): Promise<Runtime | null> {
  const runtime = readPrivate<Runtime>(metadata); if (!runtime) return null;
  try {
    const url = new URL(runtime.url); if (url.hostname !== "127.0.0.1" || url.protocol !== "http:") throw new Error("Invalid local runtime address");
    const response = await fetch(runtime.url + "/api/doctor", { headers: { authorization: `Bearer ${runtime.token}` }, signal: AbortSignal.timeout(1500) });
    if (!response.ok) throw new Error(`Runtime health check returned ${response.status}`);
    const found = (await response.json() as { version: string }).version;
    if (found !== "0.1.10") { const error = new Error(`Agent Safe runtime ${found} is still running. Restart Agent Safe to load 0.1.10; proposals remain in the same private store.`); error.name = "RuntimeVersionMismatch"; throw error; }
    return runtime;
  } catch (error) {
    if ((error as Error).name === "RuntimeVersionMismatch") throw error;
    // A live daemon behind a sandbox boundary is not a stale process. Never
    // create competing daemons merely because this caller cannot use loopback.
    let exists = false;
    try { process.kill(runtime.pid, 0); exists = true; } catch (e) { exists = (e as NodeJS.ErrnoException).code === "EPERM"; }
    if (exists) throw new Error("Agent Safe runtime is running but this caller cannot reach its loopback API. Retry with local-network permission; do not start another daemon.");
  }
  return null;
}
async function ensureRuntime() {
  protectDirectory(directory); const existing = await live(); if (existing) return existing;
  const lock = join(directory, "startup.lock");
  let locked = false;
  try {
    try { mkdirSync(lock, { mode: 0o700 }); locked = true; }
    catch { for (let i = 0; i < 100; i++) { await Bun.sleep(100); const r = await live(); if (r) return r; } throw new Error(`Startup lock is held. If no Agent Safe startup exists, remove ${lock} and retry.`); }
    const afterLock = await live(); if (afterLock) return afterLock;
    const fd = openSync(join(directory, "runtime.log"), "a", 0o600);
    const child = spawn(process.execPath, [entry, "serve"], { detached: true, stdio: ["ignore", fd, fd], env: { ...process.env, AGENT_SAFE_DATA_DIR: directory } });
    child.unref(); closeSync(fd);
    for (let i = 0; i < 150; i++) { await Bun.sleep(100); const r = await live(); if (r) return r; }
    throw new Error(`Runtime did not start; inspect ${join(directory, "runtime.log")}`);
  } finally { if (locked) rmSync(lock, { recursive: true }); }
}
async function serve() {
  const settings = new Settings(directory); const store = new AgentSafeStore(join(directory, "agent-safe.sqlite"));
  const anvil = process.env.AGENT_SAFE_ANVIL ?? Bun.which("anvil") ?? join(process.env.HOME ?? "", ".foundry", "bin", "anvil");
  const service = new AgentSafeService(store, settings.chains, { anvilBinary: anvil });
  const token = crypto.randomUUID() + crypto.randomUUID(); let origin = "http://127.0.0.1:0";
  const assets = process.env.AGENT_SAFE_ASSETS ?? (existsSync(join(dirname(entry), "../assets/web/index.html"))
    ? resolve(dirname(entry), "../assets/web") : resolve(import.meta.dir, "../../agent-safe-web/build"));
  const endpointPath = join(directory, "endpoint.json");
  const endpoint = readPrivate<{ port: number; remoteOrigin?: string }>(endpointPath);
  if (endpoint && (!Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535)) throw new Error("Invalid saved Agent Safe port");
  const app = createApp({ service, settings, token, origin: () => origin, assets, ...(endpoint?.remoteOrigin ? { remoteOrigin: endpoint.remoteOrigin } : {}) });
  app.listen({ hostname: "127.0.0.1", port: endpoint?.port ?? 0, idleTimeout: 255 });
  if (!endpoint) writePrivate(endpointPath, { port: app.server!.port });
  origin = `http://127.0.0.1:${app.server!.port}`;
  writePrivate(metadata, { url: origin, token, pid: process.pid, version: "0.1.10" } satisfies Runtime);
  const stop = async () => { await app.stop(); store.close(); const current = readPrivate<Runtime>(metadata); if (current?.token === token) rmSync(metadata); process.exit(0); };
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
}
const help = {
  usage: "bun <plugin>/scripts/agent-safe.js COMMAND [arguments]",
  commands: {
    doctor: "Read readiness; starts own loopback daemon if necessary",
    networks: "List configured chain IDs and names (RPC URLs redacted)",
    "network FILE [--apply HASH]": "Plan/apply exact JSON {chainId,name,rpcUrl,confirmations}; RPC chain verified on apply",
    "inspect CHAIN_ID SAFE": "Read Safe state without preparing anything",
    "prepare FILE [--apply HASH]": "Validate/plan input JSON; exact plan hash required to persist immutable proposal",
    "token CHAIN_ID TOKEN": "Read block-pinned token decimals, symbol and name",
    "encode FILE": "Encode verified ABI JSON {abi,functionName,args} deterministically",
    "read FILE": "Read a view/pure ABI JSON {chainId,address,abi,functionName,args} at a pinned block",
    "status ID": "Fresh chain approvals, signatures, nonce and attempts",
    "simulate ID": "Run optional disposable Anvil fork and concrete postconditions",
    "link ID": "Return reusable proposal-scoped signing URL with no time limit",
    "handoff ID": "Export complete JSON + prompt to share manually with other signers",
    "import FILE [--apply DIGEST]": "Independently validate handoff; exact digest required to persist",
    "signature ID FILE [--apply HASH]": "Plan/import JSON {signature}; simulation optional",
    "recover ID HASH": "Track independently verified already-broadcast transaction; never sends",
    list: "List immutable local proposals",
    dashboard: "Return local workspace URL and saved proposal summaries without RPC",
    "saved ID": "Read saved proposal and last observed status without RPC",
    "api PATH [METHOD] [FILE]": "Authenticated JSON API; consult openapi via api /openapi/json",
  }, note: "No private keys, signing or real-chain broadcasting in CLI. Amounts are decimal strings in base units. Wallet actions require explicit UI clicks."
};
async function run() {
  const [command = "help", ...args] = process.argv.slice(2);
  if (command === "serve") { await serve(); return; }
  if (command === "help" || command === "--help") return help;
  const runtime = await ensureRuntime();
  const arg = (n: number) => { if (!args[n]) throw new Error("Missing argument; run help"); return args[n]!; };
  const file = async (n: number) => strictJson(await Bun.file(resolve(arg(n))).text());
  const apply = args.indexOf("--apply");
  if (["prepare", "network", "signature"].includes(command)) {
    const body = await file(command === "signature" ? 1 : 0);
    if (command === "prepare") {
      if (apply < 0) { const proposal = await request(runtime, "/api/proposals/plan", "POST", body) as unknown as { id: string }; return { apply: false, planHash: proposal.id, proposal, next: `Review then rerun with --apply ${proposal.id}` }; }
      return request(runtime, "/api/proposals/apply", "POST", { planHash: args[apply + 1], input: body });
    }
    const digest = keccak256(toHex(canonical({ command, ...(command === "signature" ? { id: arg(0) } : {}), body })));
    if (apply < 0) return { apply: false, planHash: digest, command, ...(command === "network" ? { input: "RPC URL withheld; inspect your input file" } : { input: body }), next: `Rerun with --apply ${digest} to persist this exact input; no wallet action occurs.` };
    if (args[apply + 1] !== digest) throw new Error("Plan hash differs from exact input");
    return request(runtime, command === "network" ? "/api/networks" : `/api/proposals/${encodeURIComponent(arg(0))}/signatures`, command === "network" ? "PUT" : "POST", body);
  }
  switch (command) {
    case "doctor": return request(runtime, "/api/doctor");
    case "networks": return request(runtime, "/api/networks");
    case "inspect": return request(runtime, `/api/safes/${encodeURIComponent(arg(0))}/${encodeURIComponent(arg(1))}`);
    case "token": return request(runtime, `/api/tokens/${encodeURIComponent(arg(0))}/${encodeURIComponent(arg(1))}`);
    case "encode": return request(runtime, "/api/encode", "POST", await file(0));
    case "read": return request(runtime, "/api/read-contract", "POST", await file(0));
    case "list": return request(runtime, "/api/proposals");
    case "dashboard": return { url: runtime.url + "/", proposals: await request(runtime, "/api/proposal-summaries") };
    case "saved": return request(runtime, `/api/proposals/${encodeURIComponent(arg(0))}/saved`);
    case "status": return request(runtime, `/api/proposals/${encodeURIComponent(arg(0))}`);
    case "simulate": return request(runtime, `/api/proposals/${encodeURIComponent(arg(0))}/simulate`, "POST", {});
    case "link": return request(runtime, `/api/proposals/${encodeURIComponent(arg(0))}/signing-sessions`, "POST", {});
    case "handoff": return request(runtime, `/api/proposals/${encodeURIComponent(arg(0))}/handoff`);
    case "import": return request(runtime, "/api/import", "POST", { payload: await Bun.file(resolve(arg(0))).text(), apply: apply >= 0, ...(apply < 0 ? {} : { expectedDigest: args[apply + 1] }) });
    case "signature": throw new Error("Unreachable");
    case "recover": return request(runtime, `/api/proposals/${encodeURIComponent(arg(0))}/recover`, "POST", { hash: arg(1) });
    case "api": { const path = arg(0); if (!/^\/(api\/|openapi)/.test(path) || path.includes("..")) throw new Error("API path required"); return request(runtime, path, args[1] ?? "GET", args[2] ? await file(2) : undefined); }
    default: throw new Error("Unknown command; run help");
  }
}
run().then(result => { if (result !== undefined) console.log(JSON.stringify(result, null, 2)); }).catch(error => {
  console.error(JSON.stringify({ error: error instanceof Error ? error.message : "Agent Safe failed", ...((error as { diagnostics?: unknown }).diagnostics ? { diagnostics: (error as { diagnostics: unknown }).diagnostics } : {}) })); process.exitCode = 1;
});
