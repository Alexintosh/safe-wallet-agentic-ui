import { redactRpcText } from "../../../packages/safe-core/src/index";
import { mkdirSync, chmodSync, lstatSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { mainnet, optimism, arbitrum, base, polygon, gnosis, sepolia } from "viem/chains";
import type { ChainConfig } from "../../../packages/agent-safe-application/src/index";

export function dataDirectory() { return process.env.AGENT_SAFE_DATA_DIR ?? join(homedir(), ".local", "share", "agent-safe"); }
export function protectDirectory(dir: string) {
  try { mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (lstatSync(dir).isSymbolicLink()) throw new Error("Refusing symlink data directory");
    chmodSync(dir, 0o700);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES") throw new Error(`[startup.filesystem; ${code}] Agent Safe needs read/write permission for its private data directory ${dir}, plus loopback access for its local API. Retry this command with sandbox permission. No wallet signature or chain transaction is involved.`);
    throw error;
  }
}
export function writePrivate(path: string, value: unknown) {
  const tmp = `${path}.${crypto.randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600, flag: "wx" }); renameSync(tmp, path);
}
export function readPrivate<T>(path: string): T | null {
  try { const stat = lstatSync(path); if (stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error("Runtime file permissions must be 0600");
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
}
export class Settings {
  readonly chains: Map<number, ChainConfig>;
  constructor(readonly directory: string) {
    protectDirectory(directory);
    const defaults = [mainnet, optimism, arbitrum, base, polygon, gnosis, sepolia].map(c => ({ chainId: c.id, name: c.name, rpcUrl: c.rpcUrls.default.http[0], confirmations: 12 }));
    this.chains = new Map((readPrivate<ChainConfig[]>(join(directory, "networks.json")) ?? defaults).map(c => [c.chainId, c]));
  }
  list() { return [...this.chains.values()].map(({ rpcUrl, ...c }) => ({ ...c, rpcConfigured: Boolean(rpcUrl) })); }
  save(config: ChainConfig) {
    const url = new URL(config.rpcUrl);
    if (!["http:", "https:"].includes(url.protocol) || !Number.isSafeInteger(config.chainId) || config.chainId < 1 || config.confirmations < 1 || !Number.isSafeInteger(config.confirmations)) throw new Error("Invalid network configuration");
    this.chains.set(config.chainId, config); writePrivate(join(this.directory, "networks.json"), [...this.chains.values()]); return this.list();
  }
  redact(message: string) {
    return redactRpcText(message, [...this.chains.values()].map(c => c.rpcUrl));
  }
}
