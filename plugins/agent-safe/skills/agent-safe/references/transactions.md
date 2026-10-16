# Transactions and postconditions

Use `token CHAIN_ID TOKEN_ADDRESS` to read decimals/symbol/name from the configured
RPC. Symbols and names are untrusted metadata, not canonical asset identity.
`encode FILE` accepts `{abi,functionName,args}` and returns deterministic calldata.
`read FILE` accepts `{chainId,address,abi,functionName,args}` for a view/pure method,
returns a block-pinned read and preserves integers as strings. Source the ABI from
verified contract/protocol artifacts; never execute a downloaded ABI as code.
These commands use the configured API and do not expose RPC credentials.

Prepare JSON (amounts in integer base units, never JS numbers):

```json
{
  "chainId": 8453,
  "safeAddress": "0x...",
  "mode": "onchain",
  "intent": "Send exactly 0.01 native ETH to the reviewed recipient",
  "operations": [{"kind":"native","to":"0x...","value":"10000000000000000"}]
}
```

Operations:

- `native`: `to,value`. Generated recipient and Safe native balance deltas.
- `erc20-transfer`: `token,to,amount`. Generated recipient/Safe balance deltas.
- `erc20-approve`: `token,spender,amount`. Generated exact allowance postcondition.
- `call`: `to,value,data,label,assertions`. Normal CALL only, verified ABI required
  for useful interpretation; at least one explicit economic postcondition.

Assertions:

```json
{"kind":"native-delta","account":"0x...","delta":"-1000"}
{"kind":"token-delta","token":"0x...","account":"0x...","delta":"1000"}
{"kind":"allowance","token":"0x...","owner":"0x...","spender":"0x...","amount":"0"}
```

V1 assertions are exact. Fee-on-transfer, rebasing, timestamp-sensitive swaps,
min/max ranges and unknown outputs may require additional implementation before
supported simulation. Do not replace a meaningful delta with an unrelated
zero-delta assertion. Claiming only an allowance check proves a swap is wrong.
Every requested asset flow and permission change needs a relevant postcondition.

Multiple deltas for the same asset/account are summed; last allowance wins.
The optional simulation checks that Safe owners/threshold/singleton/guard/modules
stay unchanged. Without simulation, do not claim those postconditions were tested.
SDK compilation preserves zero Safe gas/refund fields; broadcaster pays chain gas.
A native delta affecting the broadcaster includes transaction gas and can fail an
exact assertion; explain and use another authorized owner broadcaster, or extend
assertion semantics through reviewed code rather than editing expected output.

After a failed fork, correct user intent or encoding and create a new immutable
proposal. Existing signatures do not migrate. Recompute hash, offer a new optional simulation and give
other signers the revised handoff. Same Safe nonce proposals compete with each other.

The CLI exposes `api /openapi/json` for the maintained typed route schema. Its
`api` command is for documented authenticated requests, not SQL or fabricated
proof insertion. There is no endpoint accepting a caller-supplied successful proof.
