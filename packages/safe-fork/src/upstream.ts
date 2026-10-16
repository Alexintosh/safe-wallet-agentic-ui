import { requestRpc, rpcDiagnostics, type RpcDiagnostic } from "../../safe-core/src/index";
const READS = new Set(["eth_chainId", "eth_blockNumber", "net_version", "web3_clientVersion", "eth_getBlockByNumber", "eth_getBlockByHash", "eth_getTransactionByHash", "eth_getTransactionReceipt", "eth_getBlockReceipts", "eth_getBalance", "eth_getCode", "eth_getStorageAt", "eth_getTransactionCount", "eth_getProof", "eth_getLogs", "eth_call", "eth_gasPrice", "eth_feeHistory", "eth_estimateGas", "eth_maxPriorityFeePerGas"]);
/** Per-fork, loopback-only observation boundary. Never forwards writes to the real chain. */
export function forkUpstream(url: string, signal: AbortSignal) {
  const failures: RpcDiagnostic[] = []; const path = `/rpc/${crypto.randomUUID()}`;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, maxRequestBodySize: 2_000_000,
    async fetch(req, listener) {
      // The bounded upstream RPC timeout can exceed Bun's default idle limit.
      listener.timeout(req, 60);
      if (req.method !== "POST" || new URL(req.url).pathname !== path) return new Response(null, { status: 404 });
      const item = await req.json() as { id?: unknown; method?: string; params?: unknown[] };
      if (!item.method || !READS.has(item.method)) return Response.json({ jsonrpc: "2.0", id: item.id ?? null, error: { code: -32601, message: "Fork upstream accepts read methods only" } });
      try {
        const result = await requestRpc(url, item.method, item.params ?? [], { stage: "fork.upstream-read", hop: "fork-upstream", signal });
        return Response.json({ jsonrpc: "2.0", id: item.id ?? null, result });
      } catch (error) {
        const details = rpcDiagnostics(error); failures.push(...details); if (failures.length > 4) failures.splice(0, failures.length - 4);
        return Response.json({ jsonrpc: "2.0", id: item.id ?? null, error: { code: details[0]?.rpcCode ?? -32000, message: error instanceof Error ? error.message : "Fork upstream failed" } });
      }
    },
  });
  return { url: `http://127.0.0.1:${server.port}${path}`, failures, stop: () => server.stop(true) };
}
