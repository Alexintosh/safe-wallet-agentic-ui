import { createPublicClient, defineChain, custom, keccak256, toHex, getAddress, type Address, type Hex, type PublicClient } from "viem";
import { rpcProvider, knownSingletonHashes, safeAbi, type SafeIdentity } from "../../safe-core/src/index";
import type { ChainConfig, SafeState } from "./model";

export function clientFor(config: ChainConfig, stage = "chain.read"): PublicClient {
  return createPublicClient({ chain: defineChain({ id: config.chainId, name: config.name,
    nativeCurrency: { name: "Native", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [config.rpcUrl] } } }),
    transport: custom(rpcProvider(config.rpcUrl, stage), { retryCount: 0 }) }) as PublicClient;
}
const SENTINEL = "0x0000000000000000000000000000000000000001" as Address;
export async function readSafe(client: PublicClient, id: SafeIdentity, pinned?: bigint): Promise<SafeState> {
  if (await client.getChainId() !== id.chainId) throw new Error("RPC chain ID differs from requested chain");
  const block = await client.getBlock(pinned === undefined ? { blockTag: "latest" } : { blockNumber: pinned });
  if (!block.hash || block.number === null) throw new Error("RPC returned unmined block");
  const at = { address: id.safeAddress, abi: safeAbi, blockNumber: block.number } as const;
  const [version, nonce, owners, threshold, singleton, guard, fallback] = await Promise.all([
    client.readContract({ ...at, functionName: "VERSION" }), client.readContract({ ...at, functionName: "nonce" }),
    client.readContract({ ...at, functionName: "getOwners" }), client.readContract({ ...at, functionName: "getThreshold" }),
    client.getStorageAt({ address: id.safeAddress, slot: "0x0", blockNumber: block.number }),
    client.getStorageAt({ address: id.safeAddress, slot: keccak256(toHex("guard_manager.guard.address")), blockNumber: block.number }),
    client.getStorageAt({ address: id.safeAddress, slot: keccak256(toHex("fallback_manager.handler.address")), blockNumber: block.number }),
  ]);
  if (!["1.3.0", "1.4.1"].includes(version)) throw new Error(`Unsupported Safe version ${version}; tested versions: 1.3.0, 1.4.1`);
  if (threshold < 1n || threshold > BigInt(owners.length) || owners.length > 100) throw new Error("Invalid Safe threshold/owner count");
  const codes = await Promise.all(owners.map(owner => client.getCode({ address: owner, blockNumber: block.number })));
  if (codes.some(code => code && code !== "0x")) throw new Error("Contract/delegated owners are not supported in v1");
  const modules: Address[] = []; let start = SENTINEL;
  for (let page = 0; page < 10; page++) {
    const [found, next] = await client.readContract({ ...at, functionName: "getModulesPaginated", args: [start, 20n] });
    modules.push(...found.map(o => getAddress(o)));
    if (next.toLowerCase() === SENTINEL.toLowerCase()) break;
    if (page === 9 || next === start) throw new Error("Module enumeration incomplete");
    start = next;
  }
  if (!singleton || BigInt(singleton) === 0n || !guard || !fallback) throw new Error("Unsupported Safe storage layout");
  const singletonAddress = getAddress(`0x${singleton.slice(-40)}`);
  const code = await client.getCode({ address: singletonAddress, blockNumber: block.number });
  if (!code || code === "0x") throw new Error("Safe singleton has no code");
  if (!knownSingletonHashes[version]?.includes(keccak256(code))) throw new Error("Unrecognized Safe singleton bytecode");
  const proxyCode = await client.getCode({ address: id.safeAddress, blockNumber: block.number });
  // Canonical SafeProxy 1.3/1.4 executable runtime, excluding compiler metadata.
  // Verified from the canonical SafeProxyFactory deployment in the fixture test.
  const proxyRuntime = "0x608060405273ffffffffffffffffffffffffffffffffffffffff600054167fa619486e0000000000000000000000000000000000000000000000000000000060003514156050578060005260206000f35b3660008037600080366000845af43d6000803e60008114156070573d6000fd5b3d6000f3fe";
  if (!proxyCode?.startsWith(proxyRuntime)) throw new Error("Unsupported Safe proxy runtime");
  const dependencyCodes = await Promise.all([...modules, getAddress(`0x${guard.slice(-40)}`), getAddress(`0x${fallback.slice(-40)}`)].map(address => client.getCode({ address, blockNumber: block.number })));
  return { version, nonce: String(nonce), owners: owners.map(o => getAddress(o)), threshold: Number(threshold),
    blockNumber: String(block.number), blockHash: block.hash, singleton, guard, modules,
    configurationHash: keccak256(toHex(JSON.stringify({ version, owners, threshold: String(threshold), singleton, singletonCode: keccak256(code), proxyCode, dependencyCodes, guard, fallback, modules }))) };
}
