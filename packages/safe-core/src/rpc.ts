/** Sanitized RPC diagnostics. Request params and endpoint credentials are never logged. */
export interface RpcDiagnostic {
  stage: string; hop: "upstream" | "anvil-local" | "fork-upstream"; method: string;
  httpStatus?: number; rpcCode?: number; detail: string;
}
export function redactRpcText(input: string, urls: readonly string[] = []): string {
  let text = input;
  for (const url of urls) {
    text = text.replaceAll(url, "[RPC]");
    try {
      const u = new URL(url);
      const secrets = [u.username, u.password, ...u.searchParams.values(), ...u.pathname.split("/").filter(s => s.length >= 12)];
      for (const value of secrets) if (value.length >= 4) { text = text.replaceAll(value, "[redacted]"); text = text.replaceAll(decodeURIComponent(value), "[redacted]"); }
    } catch { /* not a URL */ }
  }
  return text.replace(/https?:\/\/[^\s"'\\<>]+/gi, "[RPC]")
    .replace(/(bearer\s+)[\w.+\-/=]+/gi, "$1[redacted]")
    .replace(/((?:api[_-]?key|token|password|authorization)\s*[=:]\s*)[^\s,;"}]+/gi, "$1[redacted]")
    .slice(0, 1200);
}
export class RpcDiagnosticError extends Error {
  readonly diagnostics: readonly RpcDiagnostic[];
  constructor(diagnostics: readonly RpcDiagnostic[]) {
    super(diagnostics.map(d => `[${d.stage}; ${d.hop}; ${d.method}${d.httpStatus === undefined ? "" : `; HTTP ${d.httpStatus}`}${d.rpcCode === undefined ? "" : `; RPC ${d.rpcCode}`}] ${d.detail}`).join("\n"));
    this.name = "RpcDiagnosticError"; this.diagnostics = diagnostics;
  }
}
export function rpcDiagnostics(error: unknown): readonly RpcDiagnostic[] {
  let e = error; const seen = new Set<unknown>();
  while (e && typeof e === "object" && !seen.has(e)) {
    seen.add(e); if (e instanceof RpcDiagnosticError) return e.diagnostics;
    e = (e as { cause?: unknown }).cause;
  }
  return [];
}
export interface RpcContext { stage: string; hop: RpcDiagnostic["hop"]; signal?: AbortSignal; timeoutMs?: number }
export async function requestRpc<T>(url: string, method: string, params: readonly unknown[] | object, context: RpcContext): Promise<T> {
  const timeoutMs = context.timeoutMs ?? 20_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new RangeError("RPC timeout must be a positive integer");
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = context.signal ? AbortSignal.any([context.signal, deadline]) : deadline;
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try { response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal }); }
    catch (error) { throw new RpcDiagnosticError([{ stage: context.stage, hop: context.hop, method, detail: redactRpcText((error as Error).message, [url]) }]); }
    const text = await response.text(); let body: { result?: T; error?: { code?: number; message?: string } } | undefined;
    try { body = JSON.parse(text); } catch { /* HTTP gateways can return HTML */ }
    if (response.ok && body && !body.error && "result" in body) return body.result as T;
    const rateLimited = response.status === 429 || body?.error?.code === -32016;
    // Retry only read-only rate limits, bounded; never replay a submission.
    if (rateLimited && attempt < 2 && /^(eth_(get\w+|call|chainId|blockNumber|gasPrice|feeHistory|maxPriorityFeePerGas)|net_version|web3_clientVersion)$/.test(method)) {
      const retryAfter = Number(response.headers.get("retry-after"));
      const delay = Math.min(5000, Math.max(500 * 2 ** attempt, Number.isFinite(retryAfter) ? retryAfter * 1000 : 0));
      await new Promise<void>((resolve, reject) => {
        if (signal.aborted) { reject(signal.reason); return; }
        const abort = () => { clearTimeout(timer); reject(signal.reason); };
        const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, delay);
        signal.addEventListener("abort", abort, { once: true });
      });
      continue;
    }
    const detail = typeof body?.error?.message === "string" ? body.error.message : response.ok ? "Malformed JSON-RPC response" : `HTTP gateway failure ${response.status} ${response.statusText}`;
    throw new RpcDiagnosticError([{ stage: context.stage, hop: context.hop, method, httpStatus: response.status,
      ...(typeof body?.error?.code === "number" ? { rpcCode: body.error.code } : {}), detail: redactRpcText(detail, [url]) }]);
  }
}
export function rpcProvider(url: string, stage: string, hop: RpcDiagnostic["hop"] = "upstream") {
  return { request: ({ method, params }: { method: string; params?: readonly unknown[] | object }) => requestRpc(url, method, params ?? [], { stage, hop }) };
}
