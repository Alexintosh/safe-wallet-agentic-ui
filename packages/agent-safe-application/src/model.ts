import type { Address, Hex } from "viem";
import type { SafeTransactionData } from "../../safe-core/src/index";

export interface ChainConfig { chainId: number; name: string; rpcUrl: string; confirmations: number }
export interface Call { to: Address; value: string; data: Hex; label: string }
export type Assertion =
  | { kind: "native-delta"; account: Address; delta: string }
  | { kind: "token-delta"; token: Address; account: Address; delta: string }
  | { kind: "allowance"; token: Address; owner: Address; spender: Address; amount: string };
export interface Proposal {
  id: string; chainId: number; safeAddress: Address; mode: "offchain" | "onchain"; intent: string;
  transaction: SafeTransactionData; transactionHash: Hex; calls: Call[]; assertions: Assertion[]; createdAt: number;
  operations: OperationInput[];
}
export interface SafeState {
  version: string; nonce: string; owners: Address[]; threshold: number;
  blockNumber: string; blockHash: Hex; configurationHash: Hex; singleton: Hex; guard: Hex; modules: readonly Address[];
}
export interface AssertionResult { label: string; passed: boolean; before: string; after: string; expected: string }
export interface Simulation {
  id: string; passed: boolean; fresh?: boolean; expiresAt: number; blockNumber: string; blockHash: Hex;
  assertions: AssertionResult[]; emulatedOwners: readonly Address[]; gasUsed: string;
  configurationHash: Hex; mode: "emulated" | "actual"; error?: string;
}
export interface Attempt { hash: Hex; kind: "approve" | "execute"; status: string; successful: boolean | null;
  blockNumber: string | null; confirmations: number; expectedData: Hex; sender: Address; submittedAt: number }
export interface View { proposal: Proposal; state: SafeState; signatures: { owner: Address; signature: Hex }[];
  approvals: { owner: Address; approved: boolean }[]; simulation: Simulation | null; attempts: Attempt[] }
export type OperationInput =
  | { kind: "native"; to: Address; value: string }
  | { kind: "erc20-transfer"; token: Address; to: Address; amount: string }
  | { kind: "erc20-approve"; token: Address; spender: Address; amount: string }
  | { kind: "call"; to: Address; value: string; data: Hex; label: string; assertions: Assertion[] };
