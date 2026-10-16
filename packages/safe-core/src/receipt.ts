import { keccak256, toHex, type Address, type Hex } from "viem";

const SAFE_EXECUTION_SUCCESS_TOPIC = keccak256(toHex("ExecutionSuccess(bytes32,uint256)"));
const SAFE_EXECUTION_FAILURE_TOPIC = keccak256(toHex("ExecutionFailure(bytes32,uint256)"));
const HEX_32 = /^0x[0-9a-fA-F]{64}$/u;
const HEX_64 = /^0x[0-9a-fA-F]{128}$/u;

export type SafeExecutionReceiptRejectionCode =
  | "execution_failure"
  | "success_missing"
  | "success_duplicate"
  | "success_malformed"
  | "transaction_hash_mismatch";

export class SafeExecutionReceiptVerificationError extends Error {
  constructor(readonly code: SafeExecutionReceiptRejectionCode, message: string) {
    super(message);
    this.name = "SafeExecutionReceiptVerificationError";
  }
}

export interface SafeExecutionReceiptLog {
  readonly address: Address;
  readonly data: Hex;
  readonly logIndex?: number;
  readonly topics: readonly Hex[];
}

export interface VerifiedSafeExecutionSuccess {
  readonly safeAddress: Address;
  readonly transactionHash: Hex;
  readonly paymentRaw: string;
  readonly encoding: "non_indexed" | "indexed";
  /** Canonical RPC log index when the receipt reader preserves it. */
  readonly receiptLogIndex: number | null;
  /** Stable fallback inside the exact supplied receipt, never a substitute for logIndex. */
  readonly receiptLogOffset: number;
}

/**
 * Verifies the exact Safe-level success proof independently of outer receipt
 * status. Both historical Safe event layouts are accepted; ambiguous or
 * incomplete evidence fails closed.
 */
export function verifySafeExecutionSuccess(
  receipt: { readonly logs: readonly SafeExecutionReceiptLog[] },
  expected: { readonly safeAddress: Address; readonly transactionHash: Hex },
): VerifiedSafeExecutionSuccess {
  if (!HEX_32.test(expected.transactionHash)) {
    throw new TypeError("Expected Safe transaction hash must be exactly 32 bytes");
  }

  const safeAddress = expected.safeAddress.toLowerCase();
  const scoped = receipt.logs.filter((log) => log.address.toLowerCase() === safeAddress);
  const failures = scoped.filter((log) => log.topics[0]?.toLowerCase() === SAFE_EXECUTION_FAILURE_TOPIC.toLowerCase());
  if (failures.length > 0) {
    throw new SafeExecutionReceiptVerificationError(
      "execution_failure",
      "Exact Safe emitted ExecutionFailure",
    );
  }

  const successes = receipt.logs.flatMap((log, receiptLogOffset) => (
    log.address.toLowerCase() === safeAddress
    && log.topics[0]?.toLowerCase() === SAFE_EXECUTION_SUCCESS_TOPIC.toLowerCase()
      ? [{ log, receiptLogOffset }]
      : []
  ));
  if (successes.length === 0) {
    throw new SafeExecutionReceiptVerificationError(
      "success_missing",
      "Exact Safe emitted no ExecutionSuccess event",
    );
  }
  if (successes.length !== 1) {
    throw new SafeExecutionReceiptVerificationError(
      "success_duplicate",
      "Exact Safe emitted more than one ExecutionSuccess event",
    );
  }

  const success = successes[0]!;
  if (
    success.log.logIndex !== undefined
    && (!Number.isSafeInteger(success.log.logIndex) || success.log.logIndex < 0)
  ) {
    throw new SafeExecutionReceiptVerificationError(
      "success_malformed",
      "Safe ExecutionSuccess event has an invalid receipt log index",
    );
  }
  const decoded = decodeSuccess(success.log);
  if (decoded.transactionHash.toLowerCase() !== expected.transactionHash.toLowerCase()) {
    throw new SafeExecutionReceiptVerificationError(
      "transaction_hash_mismatch",
      "Safe ExecutionSuccess transaction hash does not match the expected Safe transaction hash",
    );
  }
  return {
    safeAddress: expected.safeAddress,
    transactionHash: decoded.transactionHash,
    paymentRaw: decoded.paymentRaw,
    encoding: decoded.encoding,
    receiptLogIndex: success.log.logIndex ?? null,
    receiptLogOffset: success.receiptLogOffset,
  };
}

function decodeSuccess(
  log: SafeExecutionReceiptLog,
): Omit<
  VerifiedSafeExecutionSuccess,
  "safeAddress" | "receiptLogIndex" | "receiptLogOffset"
> {
  if (log.topics.length === 1 && HEX_64.test(log.data)) {
    return {
      transactionHash: `0x${log.data.slice(2, 66)}` as Hex,
      paymentRaw: BigInt(`0x${log.data.slice(66)}`).toString(),
      encoding: "non_indexed",
    };
  }
  if (log.topics.length === 2 && HEX_32.test(log.topics[1] ?? "") && HEX_32.test(log.data)) {
    return {
      transactionHash: log.topics[1]!,
      paymentRaw: BigInt(log.data).toString(),
      encoding: "indexed",
    };
  }
  throw new SafeExecutionReceiptVerificationError(
    "success_malformed",
    "Safe ExecutionSuccess event has a malformed indexed or non-indexed payload",
  );
}
