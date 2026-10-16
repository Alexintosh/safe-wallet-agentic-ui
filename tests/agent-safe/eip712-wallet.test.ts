import { expect, test } from 'bun:test';
import { signTypedData, SignTypedDataVersion, TypedDataUtils } from '@metamask/eth-sig-util';
import { privateKeyToAccount } from 'viem/accounts';
import { safeTransactionHash, signatureOwner, typedData, ZERO_ADDRESS } from '../../packages/safe-core/src/index';
const key=Buffer.from('11'.repeat(32),'hex');
const owner=privateKeyToAccount(`0x${key.toString('hex')}`).address;
const identity={chainId:8453,safeAddress:'0x1000000000000000000000000000000000000001' as const};
const transaction={to:ZERO_ADDRESS,value:'1',data:'0x' as const,operation:0 as const,safeTxGas:'0',baseGas:'0',gasPrice:'0',gasToken:ZERO_ADDRESS,refundReceiver:ZERO_ADDRESS,nonce:'1'};
const wire=()=>JSON.parse(JSON.stringify(typedData(identity,transaction),(_key,value)=>typeof value==='bigint'?String(value):value));
test('wire EIP-712 payload hashes and signs identically in an independent wallet implementation',async()=>{
 const data=wire();
 const hash=`0x${TypedDataUtils.eip712Hash(data,SignTypedDataVersion.V4).toString('hex')}`;
 expect(hash).toBe(safeTransactionHash(identity,transaction));
 const signature=signTypedData({privateKey:key,data,version:SignTypedDataVersion.V4});
 expect(await signatureOwner(identity,transaction,signature as `0x${string}`)).toBe(owner);
});
test('regression: omitting EIP712Domain reproduces the wrong recovered signer',async()=>{
 const data=wire();delete data.types.EIP712Domain;
 const signature=signTypedData({privateKey:key,data,version:SignTypedDataVersion.V4});
 expect(await signatureOwner(identity,transaction,signature as `0x${string}`)).not.toBe(owner);
});
