// Explicit helper for a context-free skill evaluation. Disposable loopback only.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture, recipient } from "./fixture";
import { Settings } from "../../apps/agent-safe/src/config";
const f = await fixture();
const dir = mkdtempSync(join(tmpdir(), "agent-safe-fresh-agent-"));
new Settings(dir).save({ chainId: 8453, name: "Base (isolated Anvil fixture)", rpcUrl: f.url, confirmations: 1 });
const safe = await f.deploy(2, 3);
console.log(JSON.stringify({ directory: dir, safe, chainId: 8453, recipient }));
await new Promise<void>(resolve => { process.on("SIGTERM", () => resolve()); process.on("SIGINT", () => resolve()); });
await f.close();
