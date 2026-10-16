import { requestRpc, RpcDiagnosticError, rpcDiagnostics, redactRpcText } from "../../safe-core/src/index";
import { forkUpstream } from "./upstream";
import { createServer } from "node:net";
import type { Subprocess } from "bun";

import {
  type Address,
  type Hex,
} from "viem";

const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 20_000;
const MAX_DIAGNOSTIC_BYTES = 8_192;

export interface AnvilJsonRpcReceipt {
  readonly transactionHash: Hex;
  readonly blockNumber: Hex;
  readonly status: Hex;
  readonly gasUsed: Hex;
  readonly effectiveGasPrice: Hex;
  readonly logs: readonly {
    readonly address: Address;
    readonly data: Hex;
    readonly topics: readonly Hex[];
  }[];
}

export interface AnvilForkContext<TEvm = unknown> {
  readonly rpcUrl: string;
  readonly evm: TEvm;
  readonly signal: AbortSignal;
  rpc<T>(method: string, params: readonly unknown[]): Promise<T>;
  waitForReceipt(transactionHash: Hex): Promise<AnvilJsonRpcReceipt>;
}

export interface AnvilForkRunnerOptions<TEvm = unknown> {
  readonly createEvm: (chainId: number, rpcUrl: string) => TEvm;
  readonly forkRpcUrls: Readonly<Record<number, string>>;
  readonly anvilBinary?: string;
  readonly chainLaunchOptions?: Readonly<Record<number, { readonly binary: string; readonly args: readonly string[] }>>;
  readonly timeoutMs?: number;
  readonly startupTimeoutMs?: number;
  readonly maxConcurrent?: number;
}

export class AnvilForkRunner<TEvm = unknown> {
  private active = 0;
  private readonly anvilBinary: string;
  private readonly timeoutMs: number;
  private readonly startupTimeoutMs: number;
  private readonly maxConcurrent: number;

  constructor(private readonly options: AnvilForkRunnerOptions<TEvm>) {
    this.anvilBinary = options.anvilBinary ?? "anvil";
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.maxConcurrent = options.maxConcurrent ?? 1;
  }

  async run<T>(
    request: {
      chainId: number;
      forkBlockNumber?: string;
      signal?: AbortSignal;
    },
    operation: (context: AnvilForkContext<TEvm>) => Promise<T>,
  ): Promise<T> {
    if (this.active >= this.maxConcurrent) {
      throw new Error("Anvil fork runner is busy; retry after the active simulation completes");
    }
    const forkUrl = this.options.forkRpcUrls[request.chainId];
    if (forkUrl === undefined || forkUrl.trim() === "") {
      throw new Error(`No fork RPC URL configured for chain ${request.chainId}`);
    }
    this.active += 1;
    const deadlineSignal = AbortSignal.timeout(this.timeoutMs);
    const signal = request.signal === undefined
      ? deadlineSignal
      : AbortSignal.any([request.signal, deadlineSignal]);
    let process: Subprocess | undefined;
    let upstream: ReturnType<typeof forkUpstream> | undefined;
    let diagnosticPromise: Promise<string> = Promise.resolve("");
    try {
    upstream = forkUpstream(forkUrl, signal);
    let forkBlockNumber = request.forkBlockNumber;
    const launchOptions = this.options.chainLaunchOptions?.[request.chainId];
    let hardforkArgs: string[] = [];
    if (request.chainId === 1 && !launchOptions?.args.some((arg) => arg === "--hardfork" || arg.startsWith("--hardfork="))) {
      const block = await requestRpc<{ number: Hex; timestamp: Hex } | null>(upstream.url,
        "eth_getBlockByNumber", [forkBlockNumber === undefined ? "latest" : `0x${BigInt(forkBlockNumber).toString(16)}`, false],
        { signal, hop: "fork-upstream", stage: "fork.hardfork-resolution" });
      if (block === null) throw new Error("Cannot resolve Ethereum fork block");
      forkBlockNumber = BigInt(block.number).toString();
      // Mainnet Fusaka activation, 2025-12-03 21:49:11 UTC. Older Anvil
      // defaults otherwise reject Osaka opcodes used by deployed routers.
      if (BigInt(block.timestamp) >= 1_764_798_551n) hardforkArgs = ["--hardfork", "osaka"];
    }
    const port = await allocatePort();
    const rpcUrl = `http://127.0.0.1:${port}`;
    process = Bun.spawn([
      this.options.chainLaunchOptions?.[request.chainId]?.binary ?? this.anvilBinary,
      ...(this.options.chainLaunchOptions?.[request.chainId]?.args ?? []),
      ...hardforkArgs,
      "--fork-url",
      upstream.url,
      ...(forkBlockNumber === undefined ? [] : ["--fork-block-number", forkBlockNumber]),
      "--chain-id",
      String(request.chainId),
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--auto-impersonate",
      "--silent",
    ], {
      stdout: "ignore",
      stderr: "pipe",
      env: { ...Bun.env, NO_COLOR: "1" },
    });
    diagnosticPromise = readLimitedText(process.stderr, MAX_DIAGNOSTIC_BYTES);

      await waitForRpc(rpcUrl, process, this.startupTimeoutMs, signal);
      const evm = this.options.createEvm(request.chainId, rpcUrl);
      const callRpc = async <TResult>(
        method: string,
        params: readonly unknown[],
      ): Promise<TResult> => await rpc<TResult>(rpcUrl, method, params, signal, method === "evm_mine" ? this.timeoutMs : undefined);
      return await operation({
        rpcUrl,
        evm,
        signal,
        rpc: callRpc,
        waitForReceipt: async (transactionHash) => (
          await mineAndWaitForReceipt(rpcUrl, transactionHash, signal, this.timeoutMs)
        ),
      });
    } catch (error) {
      if (process) await stopProcess(process);
      const diagnostics = await diagnosticPromise;
      const structured = [...rpcDiagnostics(error), ...(upstream?.failures ?? [])];
      if (structured.length) throw new RpcDiagnosticError(structured);
      const safeDiagnostics = redactRpcText(diagnostics, [forkUrl]);
      const suffix = safeDiagnostics.trim() === "" ? "" : ` Anvil: ${safeDiagnostics.trim()}`;
      throw new Error(redactRpcText(`${error instanceof Error ? error.message : String(error)}${suffix}`, [forkUrl]));
    } finally {
      try { if (process) await stopProcess(process); } finally { await upstream?.stop(); this.active -= 1; }
    }
  }
}

async function waitForRpc(
  rpcUrl: string,
  process: Subprocess,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (signal.aborted) throw signal.reason;
    if (process.exitCode !== null) {
      throw new Error(`Anvil exited during startup with code ${process.exitCode}`);
    }
    try {
      await rpc(rpcUrl, "eth_chainId", [], signal);
      return;
    } catch {
      await delay(100, signal);
    }
  }
  throw new Error(`Anvil did not become ready within ${timeoutMs}ms`);
}

async function mineAndWaitForReceipt(rpcUrl: string, transactionHash: Hex, signal: AbortSignal, timeoutMs: number): Promise<AnvilJsonRpcReceipt> {
  // eth_sendTransaction can return before Anvil's autominer commits the receipt.
  // Polling immediately can fall through to the real upstream for this fork-only
  // hash. Mine locally and await that barrier before asking for the local receipt.
  await rpc(rpcUrl, "evm_mine", [], signal, timeoutMs);
  return waitForReceipt(rpcUrl, transactionHash, signal);
}

async function waitForReceipt(
  rpcUrl: string,
  transactionHash: Hex,
  signal: AbortSignal,
): Promise<AnvilJsonRpcReceipt> {
  while (true) {
    const receipt = await rpc<AnvilJsonRpcReceipt | null>(
      rpcUrl,
      "eth_getTransactionReceipt",
      [transactionHash],
      signal,
    );
    if (receipt !== null) return receipt;
    await delay(100, signal);
  }
}

async function rpc<T>(
  rpcUrl: string,
  method: string,
  params: readonly unknown[],
  signal: AbortSignal,
  timeoutMs?: number,
): Promise<T> {
  return requestRpc<T>(rpcUrl, method, params, { signal, ...(timeoutMs === undefined ? {} : { timeoutMs }), hop: "anvil-local",
    stage: method === "eth_getTransactionReceipt" ? "fork.receipt-poll" : method === "evm_mine" ? "fork.mine" : "fork.local-rpc" });
}

async function allocatePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Failed to allocate an Anvil TCP port"));
        return;
      }
      server.close((error) => error === undefined ? resolve(address.port) : reject(error));
    });
  });
}

async function stopProcess(process: Subprocess): Promise<void> {
  if (process.exitCode !== null) return;
  process.kill("SIGTERM");
  await Promise.race([process.exited, Bun.sleep(2_000)]);
  if (process.exitCode === null) {
    process.kill("SIGKILL");
    await process.exited;
  }
}

async function readLimitedText(
  stream: ReadableStream<Uint8Array> | number | undefined,
  maximumBytes: number,
): Promise<string> {
  if (!(stream instanceof ReadableStream)) return "";
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = "";
  let consumed = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    const remaining = Math.max(0, maximumBytes - consumed);
    if (remaining) result += decoder.decode(item.value.subarray(0, remaining), { stream: true });
    consumed += item.value.byteLength;
  }
  return result + decoder.decode();
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const onAbort = () => { clearTimeout(timeout); reject(signal.reason); };
    const timeout = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
