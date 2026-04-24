import { ethers } from "ethers";

/**
 * Computes the transfer receipt hash that vela-nova emits as AppEvent.eventSubType
 * upon successful TEE processing of a transfer instruction with a non-empty InvoiceID.
 *
 * Port of vela-nova/runtime/wasm-go/app/app.go (see `ProcessRequest`, transfer case):
 *
 *   keccak256(
 *     uint32_be(len(invoiceId)) ||
 *     invoiceId_bytes          ||
 *     sender       (20 bytes)  ||
 *     tokenAddress (20 bytes)  ||
 *     amount       (32 bytes, big-endian, zero-padded) ||
 *     recipient    (20 bytes)
 *   )
 *
 * Field boundaries must be unambiguous: invoiceId is length-prefixed, amount is
 * always 32 bytes (Uint256.Bytes() in Go), addresses are fixed 20 bytes.
 */
export function computeTransferReceiptHash(params: {
  invoiceId: string;
  sender: string;
  tokenAddress: string;
  amount: bigint;
  recipient: string;
}): string {
  const invoiceBytes = ethers.toUtf8Bytes(params.invoiceId);
  const lenPrefix = new Uint8Array(4);
  new DataView(lenPrefix.buffer).setUint32(0, invoiceBytes.length, false);

  const senderBytes = ethers.getBytes(ethers.getAddress(params.sender));
  const tokenBytes = ethers.getBytes(ethers.getAddress(params.tokenAddress));
  const recipientBytes = ethers.getBytes(ethers.getAddress(params.recipient));
  const amountBytes = ethers.getBytes(ethers.zeroPadValue(ethers.toBeHex(params.amount), 32));

  return ethers.keccak256(
    ethers.concat([lenPrefix, invoiceBytes, senderBytes, tokenBytes, amountBytes, recipientBytes]),
  );
}
