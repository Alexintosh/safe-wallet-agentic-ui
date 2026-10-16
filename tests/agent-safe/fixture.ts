import { createServer } from "node:net";
import { createPublicClient, createWalletClient, http, encodeFunctionData, parseAbi, parseEventLogs, parseEther, type Address, type Hex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";
import contracts130 from "./fixtures/safe-130-contracts.json";
import contracts from "./fixtures/safe-141-contracts.json";
export const accounts = [0, 1, 2].map(addressIndex => mnemonicToAccount("test test test test test test test test test test test junk", { addressIndex }));
export const recipient = "0x1000000000000000000000000000000000000001" as Address;
const testChain = { ...mainnet, id: 8453 };
const setupAbi = parseAbi(["function setup(address[] owners,uint256 threshold,address to,bytes data,address fallbackHandler,address paymentToken,uint256 payment,address paymentReceiver)"]);
const factoryAbi = parseAbi(["function createProxyWithNonce(address _singleton,bytes initializer,uint256 saltNonce) returns (address proxy)", "event ProxyCreation(address indexed proxy,address singleton)"]);
export async function fixture() {
  const port = await new Promise<number>(resolve => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); }); });
  const proc = Bun.spawn([process.env.AGENT_SAFE_ANVIL ?? `${process.env.HOME}/.foundry/bin/anvil`, "--host", "127.0.0.1", "--port", String(port), "--chain-id", "8453", "--silent"], { stdout: "ignore", stderr: "pipe" });
  const url = `http://127.0.0.1:${port}`;
  const publicClient = createPublicClient({ chain: testChain, transport: http(url, { retryCount: 0 }) });
  const rpc = async (method: string, params: unknown[]) => { const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }); const b = await r.json() as { result: unknown; error?: { message: string } }; if (b.error) throw new Error(b.error.message); return b.result; };
  try {
    for (let i = 0; i < 100; i++) { try { await publicClient.getChainId(); break; } catch { await Bun.sleep(50); } }
    for (const [address, contract] of Object.entries({ ...contracts, ...contracts130 })) {
      await rpc("anvil_setCode", [address, contract.code]);
      for (const [slot, value] of Object.entries(contract.storage)) await rpc("anvil_setStorageAt", [address, slot, value]);
    }
    await rpc("evm_mine", []);
    const wallet = (index: number) => createWalletClient({ chain: testChain, account: accounts[index]!, transport: http(url) });
    const deploy = async (threshold = 2, ownerCount = 3, version = "1.4.1") => {
      const zero = "0x0000000000000000000000000000000000000000";
      const initializer = encodeFunctionData({ abi: setupAbi, functionName: "setup", args: [accounts.slice(0, ownerCount).map(a => a.address), BigInt(threshold), zero, "0x", zero, zero, 0n, zero] });
      const hash = await wallet(0).writeContract({ address: version === "1.3.0" ? "0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2" : "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67", abi: factoryAbi, functionName: "createProxyWithNonce", args: [version === "1.3.0" ? "0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552" : "0x41675C099F32341bf84BFc5382aF534df5C7461a", initializer, BigInt(Date.now()) + BigInt(Math.floor(Math.random()*10000))] });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      const safe = parseEventLogs({ abi: version === "1.3.0" ? parseAbi(["event ProxyCreation(address proxy,address singleton)"]) : factoryAbi, logs: receipt.logs })[0]!.args.proxy;
      await rpc("anvil_setBalance", [safe, `0x${parseEther("10").toString(16)}`]); await rpc("evm_mine", []);
      return safe;
    };
    return { url, publicClient, wallet, rpc, deploy, close: async () => { proc.kill(); await proc.exited; } };
  } catch (e) { proc.kill(); await proc.exited; throw e; }
}
