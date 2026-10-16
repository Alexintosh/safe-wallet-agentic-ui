import {
  SafeExecutionReceiptVerificationError,
  verifySafeExecutionSuccess,
  type SafeTransactionData,
  executionCalldata,
} from "../../safe-core/src/index";
import {
  concatHex,
  encodeFunctionData,
  keccak256,
  padHex,
  toHex,
  type Address,
  type Hex,
} from "viem";

import type {
  AnvilForkContext,
  AnvilJsonRpcReceipt,
} from "./runner";

const SIMULATED_OWNER_BALANCE = "0x56bc75e2d63100000";
const SAFE_EXECUTION_SUCCESS_TOPIC = keccak256(toHex("ExecutionSuccess(bytes32,uint256)"));
const SAFE_EXECUTION_FAILURE_TOPIC = keccak256(toHex("ExecutionFailure(bytes32,uint256)"));

const safeExecutionAbi = [
  {
    type: "function",
    name: "approveHash",
    stateMutability: "nonpayable",
    inputs: [{ name: "hashToApprove", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "execTransaction",
    stateMutability: "payable",
    inputs: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
      { name: "operation", type: "uint8" },
      { name: "safeTxGas", type: "uint256" },
      { name: "baseGas", type: "uint256" },
      { name: "gasPrice", type: "uint256" },
      { name: "gasToken", type: "address" },
      { name: "refundReceiver", type: "address" },
      { name: "signatures", type: "bytes" },
    ],
    outputs: [{ name: "success", type: "bool" }],
  },
] as const;

export type SafeExecutionOutcome = "success" | "failure" | "missing";

export interface SafeForkExecution {
  readonly receipt: AnvilJsonRpcReceipt;
  readonly localTransactionHash: Hex;
  readonly outcome: SafeExecutionOutcome;
  readonly emulatedOwners: readonly Address[];
}

export class SafeForkExecutor {
  /** Actual authorization proof: no approveHash or synthetic funding. */
  async executeAuthorized(context: AnvilForkContext, input: {
    safeAddress: Address; transactionHash: Hex; transaction: SafeTransactionData;
    sender: Address; signatures: Hex;
  }): Promise<SafeForkExecution> {
    const localTransactionHash = await context.rpc<Hex>("eth_sendTransaction", [{
      from: input.sender, to: input.safeAddress, value: "0x0",
      data: executionCalldata(input.transaction, input.signatures), gas: "0xb71b00",
    }]);
    const receipt = await context.waitForReceipt(localTransactionHash);
    return { receipt, localTransactionHash,
      outcome: readSafeExecutionOutcome(receipt, input.safeAddress, input.transactionHash), emulatedOwners: [] };
  }
  async execute(
    context: AnvilForkContext,
    input: {
      safeAddress: Address;
      transactionHash: Hex;
      threshold: number;
      owners: readonly Address[];
      transaction: SafeTransactionData;
    },
  ): Promise<SafeForkExecution> {
    if (input.threshold < 1 || input.owners.length < input.threshold) {
      throw new Error("Safe owner and threshold metadata is invalid");
    }
    const signingOwners = [...input.owners]
      .sort((left, right) => left.toLowerCase().localeCompare(right.toLowerCase()))
      .slice(0, input.threshold);
    const executor = signingOwners[0]!;
    for (const owner of signingOwners) {
      await context.rpc("anvil_setBalance", [owner, SIMULATED_OWNER_BALANCE]);
    }
    for (const owner of signingOwners.slice(1)) {
      const approvalHash = await context.rpc<Hex>("eth_sendTransaction", [{
        from: owner,
        to: input.safeAddress,
        data: encodeFunctionData({
          abi: safeExecutionAbi,
          functionName: "approveHash",
          args: [input.transactionHash],
        }),
        value: "0x0",
        gas: "0x493e0",
      }]);
      const approvalReceipt = await context.waitForReceipt(approvalHash);
      if (BigInt(approvalReceipt.status) !== 1n) {
        throw new Error(`Fork-only Safe hash approval reverted for owner ${owner}`);
      }
    }
    const execData = encodeFunctionData({
      abi: safeExecutionAbi,
      functionName: "execTransaction",
      args: [
        input.transaction.to,
        BigInt(input.transaction.value),
        input.transaction.data,
        input.transaction.operation,
        BigInt(input.transaction.safeTxGas),
        BigInt(input.transaction.baseGas),
        BigInt(input.transaction.gasPrice),
        input.transaction.gasToken,
        input.transaction.refundReceiver,
        prevalidatedSignatures(signingOwners),
      ],
    });
    const localTransactionHash = await context.rpc<Hex>("eth_sendTransaction", [{
      from: executor,
      to: input.safeAddress,
      data: execData,
      value: "0x0",
      gas: "0xb71b00",
    }]);
    const receipt = await context.waitForReceipt(localTransactionHash);
    return {
      receipt,
      localTransactionHash,
      outcome: readSafeExecutionOutcome(receipt, input.safeAddress, input.transactionHash),
      emulatedOwners: signingOwners,
    };
  }
}

export function readSafeExecutionOutcome(
  receipt: {
    readonly logs: readonly {
      readonly address: Address;
      readonly data?: Hex;
      readonly topics: readonly Hex[];
    }[];
  },
  safeAddress: Address,
  expectedTransactionHash?: Hex,
): SafeExecutionOutcome {
  if (expectedTransactionHash !== undefined) {
    try {
      verifySafeExecutionSuccess({
        logs: receipt.logs.map((log) => ({
          address: log.address,
          data: log.data ?? "0x",
          topics: log.topics,
        })),
      }, { safeAddress, transactionHash: expectedTransactionHash });
      return "success";
    } catch (error) {
      if (error instanceof SafeExecutionReceiptVerificationError && error.code === "execution_failure") {
        return "failure";
      }
      return "missing";
    }
  }
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== safeAddress.toLowerCase()) continue;
    const topic = log.topics[0]?.toLowerCase();
    if (topic === SAFE_EXECUTION_SUCCESS_TOPIC.toLowerCase()) return "success";
    if (topic === SAFE_EXECUTION_FAILURE_TOPIC.toLowerCase()) return "failure";
  }
  return "missing";
}

function prevalidatedSignatures(owners: readonly Address[]): Hex {
  return concatHex(owners.map((owner) => concatHex([
    padHex(owner, { size: 32 }),
    padHex("0x", { size: 32 }),
    "0x01",
  ])));
}
