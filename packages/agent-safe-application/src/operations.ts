import { encodeFunctionData, erc20Abi, type Address, type Hex } from "viem";
import { address, hex, uint } from "../../safe-core/src/index";
import type { Assertion, Call, OperationInput } from "./model";

export function validateAssertions(input: unknown): Assertion[] {
  if (!Array.isArray(input) || input.length > 100) throw new Error("Assertions array required (max 100)");
  return input.map((v: Record<string, unknown>) => {
    if (!v || typeof v !== "object") throw new Error("Invalid assertion");
    if (v.kind === "allowance") return { kind: "allowance", token: address(v.token), owner: address(v.owner), spender: address(v.spender), amount: uint(v.amount) };
    if (v.kind === "native-delta" || v.kind === "token-delta") {
      if (typeof v.delta !== "string" || !/^-?(0|[1-9][0-9]*)$/.test(v.delta)) throw new Error("Invalid signed delta");
      uint(v.delta.replace(/^-/, ""));
      return v.kind === "native-delta" ? { kind: v.kind, account: address(v.account), delta: v.delta }
        : { kind: v.kind, token: address(v.token), account: address(v.account), delta: v.delta };
    }
    throw new Error("Unsupported assertion");
  });
}
export function buildOperations(operations: readonly OperationInput[], safe: Address): { calls: Call[]; assertions: Assertion[] } {
  if (!Array.isArray(operations) || operations.length < 1 || operations.length > 32) throw new Error("Provide 1–32 operations");
  const assertions: Assertion[] = [];
  const calls: Call[] = operations.map(op => {
    if (op.kind === "native") {
      const to = address(op.to); const value = uint(op.value);
      if (to === safe) throw new Error("Self-transfer is not a supported native intent");
      assertions.push({ kind: "native-delta", account: to, delta: value }, { kind: "native-delta", account: safe, delta: `-${value}` });
      return { to, value, data: "0x", label: `Native transfer ${value} wei` };
    }
    if (op.kind === "erc20-transfer") {
      const token = address(op.token); const to = address(op.to); const amount = uint(op.amount);
      if (to === safe) throw new Error("Self-transfer is not supported");
      assertions.push({ kind: "token-delta", token, account: to, delta: amount }, { kind: "token-delta", token, account: safe, delta: `-${amount}` });
      return { to: token, value: "0", data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, BigInt(amount)] }), label: `ERC-20 transfer ${amount} raw units` };
    }
    if (op.kind === "erc20-approve") {
      const token = address(op.token); const spender = address(op.spender); const amount = uint(op.amount);
      assertions.push({ kind: "allowance", token, owner: safe, spender, amount });
      return { to: token, value: "0", data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, BigInt(amount)] }), label: `ERC-20 allowance ${amount} raw units` };
    }
    if (op.kind === "call") {
      if (!op.label || op.label.length > 500) throw new Error("Explicit call description required");
      const extra = validateAssertions(op.assertions);
      if (extra.length === 0) throw new Error("Explicit calls require concrete postconditions");
      assertions.push(...extra);
      return { to: address(op.to), value: uint(op.value), data: hex(op.data), label: op.label };
    }
    throw new Error("Unsupported operation");
  });
  // Sum deltas for a batch; an allowance checks its final requested value.
  const merged = new Map<string, Assertion>();
  for (const a of assertions) {
    const key = a.kind === "allowance" ? `${a.kind}:${a.token}:${a.owner}:${a.spender}` : `${a.kind}:${a.kind === "token-delta" ? a.token : "native"}:${a.account}`;
    const prev = merged.get(key);
    merged.set(key, a.kind !== "allowance" && prev && prev.kind !== "allowance" ? { ...a, delta: String(BigInt(a.delta) + BigInt(prev.delta)) } : a);
  }
  return { calls, assertions: [...merged.values()] };
}
