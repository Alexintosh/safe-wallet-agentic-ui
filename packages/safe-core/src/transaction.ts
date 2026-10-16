import {
  concatHex, encodeFunctionData, getAddress, hashTypedData, isAddress, isHex,
  padHex, recoverTypedDataAddress, type Address, type Hex,
} from "viem";

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;
export interface SafeTransactionData {
  readonly to: Address;
  readonly value: string;
  readonly data: Hex;
  readonly operation: 0 | 1;
  readonly safeTxGas: string;
  readonly baseGas: string;
  readonly gasPrice: string;
  readonly gasToken: Address;
  readonly refundReceiver: Address;
  readonly nonce: string | number;
}
export interface SafeIdentity { readonly chainId: number; readonly safeAddress: Address }
export const safeTypes = { EIP712Domain: [
  { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" },
], SafeTx: [
  { name: "to", type: "address" }, { name: "value", type: "uint256" },
  { name: "data", type: "bytes" }, { name: "operation", type: "uint8" },
  { name: "safeTxGas", type: "uint256" }, { name: "baseGas", type: "uint256" },
  { name: "gasPrice", type: "uint256" }, { name: "gasToken", type: "address" },
  { name: "refundReceiver", type: "address" }, { name: "nonce", type: "uint256" },
] } as const;
export function uint(value: unknown, name = "amount"): string {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) value = String(value);
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value) || BigInt(value) >= 2n ** 256n) {
    throw new Error(`${name} must be a canonical uint256 decimal string`);
  }
  return value;
}
export function address(value: unknown): Address {
  if (typeof value !== "string" || !isAddress(value, { strict: true })) throw new Error("Invalid address");
  return getAddress(value);
}
export function hex(value: unknown): Hex {
  if (typeof value !== "string" || !isHex(value) || value.length % 2 !== 0) throw new Error("Invalid hex bytes");
  return value.toLowerCase() as Hex;
}
export function identity(chainId: unknown, safeAddress: unknown): SafeIdentity {
  if (typeof chainId !== "number" || !Number.isSafeInteger(chainId) || chainId <= 0) throw new Error("Invalid chain ID");
  return { chainId, safeAddress: address(safeAddress) };
}
export function normalizeTransaction(input: unknown): SafeTransactionData {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Safe transaction object required");
  const v = input as Record<string, unknown>;
  const names = ["to", "value", "data", "operation", "safeTxGas", "baseGas", "gasPrice", "gasToken", "refundReceiver", "nonce"];
  if (Object.keys(v).length !== names.length || names.some(k => !(k in v))) throw new Error("All exact Safe transaction fields are required; unknown fields forbidden");
  if (v.operation !== 0 && v.operation !== 1) throw new Error("Invalid operation");
  return { to: address(v.to), value: uint(v.value), data: hex(v.data), operation: v.operation,
    safeTxGas: uint(v.safeTxGas), baseGas: uint(v.baseGas), gasPrice: uint(v.gasPrice),
    gasToken: address(v.gasToken), refundReceiver: address(v.refundReceiver), nonce: uint(v.nonce, "nonce") };
}
export function typedData(id: SafeIdentity, tx: SafeTransactionData) {
  return { domain: { chainId: BigInt(id.chainId), verifyingContract: id.safeAddress }, types: safeTypes, primaryType: "SafeTx" as const,
    message: { ...tx, value: BigInt(tx.value), safeTxGas: BigInt(tx.safeTxGas), baseGas: BigInt(tx.baseGas),
      gasPrice: BigInt(tx.gasPrice), nonce: BigInt(tx.nonce) } };
}
export function safeTransactionHash(id: SafeIdentity, tx: SafeTransactionData): Hex { return hashTypedData(typedData(id, tx)); }
export async function signatureOwner(id: SafeIdentity, tx: SafeTransactionData, signature: Hex): Promise<Address> {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature) || ![27, 28].includes(Number.parseInt(signature.slice(-2), 16))) {
    throw new Error("Only 65-byte EOA EIP-712 signatures (v=27/28) are supported");
  }
  return getAddress(await recoverTypedDataAddress({ ...typedData(id, tx), signature }));
}
export function packSignatures(signatures: readonly { owner: Address; signature: Hex }[]): Hex {
  const sorted = [...signatures].sort((a, b) => a.owner.toLowerCase().localeCompare(b.owner.toLowerCase()));
  if (new Set(sorted.map(s => s.owner.toLowerCase())).size !== sorted.length) throw new Error("Duplicate owner signature");
  return hex(concatHex(sorted.map(s => s.signature)));
}
export function approvedSignature(owner: Address): Hex { return hex(concatHex([padHex(owner, { size: 32 }), padHex("0x", { size: 32 }), "0x01"])); }

export const safeAbi = [
  { type: "function", name: "VERSION", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "nonce", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "getOwners", stateMutability: "view", inputs: [], outputs: [{ type: "address[]" }] },
  { type: "function", name: "getThreshold", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "getModulesPaginated", stateMutability: "view", inputs: [{ name: "start", type: "address" }, { name: "pageSize", type: "uint256" }], outputs: [{ type: "address[]" }, { type: "address" }] },
  { type: "function", name: "approvedHashes", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "hash", type: "bytes32" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approveHash", stateMutability: "nonpayable", inputs: [{ name: "hashToApprove", type: "bytes32" }], outputs: [] },
  { type: "function", name: "getTransactionHash", stateMutability: "view", inputs: safeTypes.SafeTx, outputs: [{ type: "bytes32" }] },
  { type: "function", name: "execTransaction", stateMutability: "payable", inputs: [
    ...safeTypes.SafeTx.slice(0, 9), { name: "signatures", type: "bytes" },
  ], outputs: [{ type: "bool" }] },
] as const;
export function transactionArgs(tx: SafeTransactionData) {
  return [tx.to, BigInt(tx.value), tx.data, tx.operation, BigInt(tx.safeTxGas), BigInt(tx.baseGas), BigInt(tx.gasPrice), tx.gasToken, tx.refundReceiver] as const;
}
export function executionCalldata(tx: SafeTransactionData, signatures: Hex): Hex {
  return encodeFunctionData({ abi: safeAbi, functionName: "execTransaction", args: [...transactionArgs(tx), signatures] });
}
