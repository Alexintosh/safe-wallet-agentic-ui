import Safe from "@safe-global/protocol-kit";
import { normalizeTransaction } from "./transaction";
import type { Address, Hex } from "viem";

/** Shared SDK compilation. Policies (which calls are allowed) belong to consumers. */
export async function compileSafeCalls(input: {
  provider: Parameters<typeof Safe.init>[0]["provider"]; safeAddress: Address;
  chainId: number; calls: readonly { to: Address; value: string; data: Hex; operation: 0 }[];
  nonce?: number;
}) {
  const kit = await Safe.init({ provider: input.provider, safeAddress: input.safeAddress,
    ...(input.chainId === 1 ? { isL1SafeSingleton: true } : {}) });
  const built = await kit.createTransaction({ transactions: input.calls.map(({ to, value, data, operation }) => ({ to, value, data, operation })), onlyCalls: true,
    ...(input.nonce === undefined ? {} : { options: { nonce: input.nonce } }) });
  const [owners, threshold, transactionHash] = await Promise.all([kit.getOwners(), kit.getThreshold(), kit.getTransactionHash(built)]);
  return { safeVersion: kit.getContractVersion(), owners, threshold, transactionHash: transactionHash as Hex,
    transaction: normalizeTransaction(built.data) };
}
