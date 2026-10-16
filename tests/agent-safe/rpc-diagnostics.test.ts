import { test, expect } from "bun:test";
import { requestRpc, rpcDiagnostics, RpcDiagnosticError } from "../../packages/safe-core/src/index";
import { AnvilForkRunner } from "../../packages/safe-fork/src/index";
import { forkUpstream } from "../../packages/safe-fork/src/upstream";
import { fixture, accounts, recipient } from "./fixture";
import type { Hex } from "viem";

test("RPC caller deadline is configurable while parent cancellation remains authoritative", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch() {
    await Bun.sleep(80);
    return Response.json({ jsonrpc: "2.0", id: 1, result: "0x1" });
  } });
  const url = `http://127.0.0.1:${server.port}`;
  try {
    await expect(requestRpc(url, "evm_mine", [], { stage: "fork.mine", hop: "anvil-local", timeoutMs: 10 })).rejects.toBeInstanceOf(RpcDiagnosticError);
    expect(await requestRpc<string>(url, "evm_mine", [], { stage: "fork.mine", hop: "anvil-local", timeoutMs: 500 })).toBe("0x1");
    await expect(requestRpc(url, "evm_mine", [], { stage: "fork.mine", hop: "anvil-local", timeoutMs: 500,
      signal: AbortSignal.timeout(10) })).rejects.toBeInstanceOf(RpcDiagnosticError);
    await expect(requestRpc(url, "evm_mine", [], { stage: "fork.mine", hop: "anvil-local", timeoutMs: 0 })).rejects.toThrow("positive integer");
  } finally { server.stop(true); }
});

test("RPC error preserves method/stage/status/code, scrubs endpoint credentials, and bounds rate-limit retries", async () => {
  let count = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { count++; return Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32016, message: "over rate limit token=VERY_SECRET_KEY https://rpc.test/v2/VERY_SECRET_KEY" } }, { status: 429 }); } });
  try {
    let error: unknown;
    try { await requestRpc(`http://127.0.0.1:${server.port}/?key=VERY_SECRET_KEY`, "eth_call", [{ secret: "not logged" }], { stage: "prepare.compile", hop: "upstream" }); } catch (e) { error = e; }
    expect(count).toBe(3);
    const d = rpcDiagnostics(new Error("viem wrapper", { cause: error }));
    expect(d[0]).toMatchObject({ stage: "prepare.compile", hop: "upstream", method: "eth_call", httpStatus: 429, rpcCode: -32016 });
    expect(JSON.stringify(d)).not.toContain("VERY_SECRET_KEY"); expect(JSON.stringify(d)).not.toContain("not logged");
    expect(d[0]?.detail).toContain("over rate limit");
    count = 0;
    await expect(requestRpc(`http://127.0.0.1:${server.port}`, "eth_sendTransaction", [], { stage: "fork.send", hop: "anvil-local" })).rejects.toBeInstanceOf(RpcDiagnosticError);
    expect(count).toBe(1);
  } finally { server.stop(true); }
}, 10_000);

test("fork observation boundary reports upstream 403 and never forwards real-chain writes", async () => {
  let count = 0;
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { count++; return Response.json({ error: { code: -32602, message: "Archive requests require a personal token" } }, { status: 403 }); } });
  const proxy = forkUpstream(`http://127.0.0.1:${upstream.port}`, AbortSignal.timeout(5000));
  try {
    const denied = await fetch(proxy.url, { method: "POST", body: JSON.stringify({ id: 1, method: "eth_sendRawTransaction", params: ["0x"] }) });
    expect((await denied.json() as any).error.code).toBe(-32601); expect(count).toBe(0);
    await expect(requestRpc(proxy.url, "eth_getTransactionReceipt", ["0x"], { stage: "test", hop: "anvil-local" })).rejects.toThrow("Archive requests");
    expect(proxy.failures[0]).toMatchObject({ hop: "fork-upstream", method: "eth_getTransactionReceipt", httpStatus: 403, rpcCode: -32602 });
  } finally { proxy.stop(); upstream.stop(true); }
});

test("receipt wait mines queued fork-only transaction before polling; no upstream receipt lookup", async () => {
  const f = await fixture(); let remoteReceipts = 0;
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const body = await req.json() as any;
    if (body.method === "eth_getTransactionReceipt") { remoteReceipts++; return Response.json({ error: { code: -32602, message: "Archive requests require a personal token" } }, { status: 403 }); }
    return fetch(f.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } });
  try {
    const runner = new AnvilForkRunner({ forkRpcUrls: { 8453: `http://127.0.0.1:${upstream.port}` }, createEvm: () => null,
      anvilBinary: "/nonexistent-default-anvil",
      chainLaunchOptions: { 8453: { binary: `${process.env.HOME}/.foundry/bin/anvil`, args: ["--no-mining"] } } });
    await runner.run({ chainId: 8453, forkBlockNumber: String(await f.publicClient.getBlockNumber()) }, async ctx => {
      await ctx.rpc("evm_setAutomine", [false]);
      const hash = await ctx.rpc<Hex>("eth_sendTransaction", [{ from: accounts[0]!.address, to: recipient, value: "0x1", gas: "0x5208" }]);
      const receipt = await ctx.waitForReceipt(hash);
      expect(receipt.transactionHash).toBe(hash); expect(BigInt(receipt.status)).toBe(1n);
    });
    expect(remoteReceipts).toBe(0);
    expect(await f.publicClient.getBalance({ address: recipient })).toBe(0n);
  } finally { upstream.stop(true); await f.close(); }
}, 30_000);

test("Ethereum forks activate Osaka CLZ at post-Fusaka blocks while explicit hardfork overrides remain authoritative", async () => {
  const f = await fixture();
  const target = "0x1000000000000000000000000000000000000002";
  try {
    // PUSH1 1; CLZ; PUSH1 0; MSTORE; PUSH1 32; PUSH1 0; RETURN.
    await f.rpc("anvil_setCode", [target, "0x60011e60005260206000f3"]);
    await f.rpc("evm_mine", []);
    const block = String(await f.publicClient.getBlockNumber());
    const options = { forkRpcUrls: { 1: f.url }, createEvm: () => null,
      anvilBinary: `${process.env.HOME}/.foundry/bin/anvil` };
    await new AnvilForkRunner(options).run({ chainId: 1, forkBlockNumber: block }, async ctx => {
      const output = await ctx.rpc<Hex>("eth_call", [{ to: target, data: "0x" }, "latest"]);
      expect(BigInt(output)).toBe(255n);
    });
    await new AnvilForkRunner({ ...options, chainLaunchOptions: { 1: {
      binary: options.anvilBinary, args: ["--hardfork", "prague"],
    } } }).run({ chainId: 1, forkBlockNumber: block }, async ctx => {
      await expect(ctx.rpc("eth_call", [{ to: target, data: "0x" }, "latest"])).rejects.toThrow();
    });
  } finally { await f.close(); }
}, 30_000);
