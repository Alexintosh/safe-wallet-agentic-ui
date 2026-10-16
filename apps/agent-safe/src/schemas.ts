import { t } from "elysia";
const addr = t.String({ pattern: "^0x[0-9a-fA-F]{40}$" });
const uint = t.String({ pattern: "^(0|[1-9][0-9]*)$", maxLength: 78 });
const bytes = t.String({ pattern: "^0x([0-9a-fA-F]{2})*$", maxLength: 200_000 });
const obj = { additionalProperties: false } as const;
export const assertionSchema = t.Union([
  t.Object({ kind: t.Literal("native-delta"), account: addr, delta: t.String({ pattern: "^-?(0|[1-9][0-9]*)$", maxLength: 79 }) }, obj),
  t.Object({ kind: t.Literal("token-delta"), token: addr, account: addr, delta: t.String({ pattern: "^-?(0|[1-9][0-9]*)$", maxLength: 79 }) }, obj),
  t.Object({ kind: t.Literal("allowance"), token: addr, owner: addr, spender: addr, amount: uint }, obj),
]);
export const operationSchema = t.Union([
  t.Object({ kind: t.Literal("native"), to: addr, value: uint }, obj),
  t.Object({ kind: t.Literal("erc20-transfer"), token: addr, to: addr, amount: uint }, obj),
  t.Object({ kind: t.Literal("erc20-approve"), token: addr, spender: addr, amount: uint }, obj),
  t.Object({ kind: t.Literal("call"), to: addr, value: uint, data: bytes, label: t.String({ minLength: 1, maxLength: 400 }), assertions: t.Array(assertionSchema, { minItems: 1, maxItems: 100 }) }, obj),
]);
export const prepareSchema = t.Object({ chainId: t.Integer({ minimum: 1 }), safeAddress: addr, mode: t.Union([t.Literal("onchain"), t.Literal("offchain")]), intent: t.String({ minLength: 1, maxLength: 4000 }), operations: t.Array(operationSchema, { minItems: 1, maxItems: 32 }) }, obj);
export const networkSchema = t.Object({ chainId: t.Integer({ minimum: 1 }), name: t.String({ minLength: 1, maxLength: 100 }), rpcUrl: t.String({ minLength: 1, maxLength: 2000 }), confirmations: t.Integer({ minimum: 1, maximum: 10000 }) }, obj);
export const actionSchema = t.Object({ action: t.Union([t.Literal("sign"), t.Literal("approve"), t.Literal("execute")]), account: addr, simulate: t.Optional(t.Boolean()) }, obj);
export const importSchema = t.Object({ payload: t.String({ maxLength: 1_000_000 }), apply: t.Optional(t.Boolean()), expectedDigest: t.Optional(bytes) }, obj);
export const signatureSchema = t.Object({ signature: bytes }, obj);
export const hashSchema = t.Object({ hash: t.String({ pattern: "^0x[0-9a-fA-F]{64}$" }) }, obj);
export const submittedSchema = t.Object({ hash: t.String({ pattern: "^0x[0-9a-fA-F]{64}$" }), ticket: t.String({ maxLength: 100 }) }, obj);
