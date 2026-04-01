import { ethers } from "ethers";
import type { SettleResponse } from "@x402/core/types";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { verifyPayment } from "./verify";
import { VelaPaymentPayload, VelaSchemeConfig } from "./types";

// Minimal ABI for submitRequestFor
const PROCESSOR_ENDPOINT_ABI = [
  "function submitRequestFor(address sender, uint8 protocolVersion, uint64 applicationId, uint8 requestType, bytes payload, address tokenAddress, uint256 assetAmount, uint256 deadline, bytes requestSignature, bytes depositPermit) payable returns (bytes32)",
  "event RequestSubmitted(bytes32 indexed requestId, address indexed sender, address indexed facilitator, uint64 applicationId, uint8 requestType)",
];

/**
 * On-chain settlement: calls submitRequestFor() on the ProcessorEndpoint contract.
 * Re-verifies signatures off-chain before submitting.
 * Returns a SettleResponse with txHash and network.
 *
 * Note: A successful settle means on-chain submission, NOT TEE completion.
 * The seller must wait for the vela-nova TEE event to confirm the transfer.
 */
export async function settlePayment(
  paymentPayload: PaymentPayload,
  requirements: PaymentRequirements,
  config: VelaSchemeConfig
): Promise<SettleResponse> {
  // Re-verify off-chain first
  const verifyResult = await verifyPayment(paymentPayload, requirements, config);
  if (!verifyResult.isValid) {
    return {
      success: false,
      errorReason: verifyResult.invalidReason,
      errorMessage: verifyResult.invalidMessage,
      transaction: "",
      network: requirements.network as any,
    };
  }

  const velaPayload = paymentPayload.payload as unknown as VelaPaymentPayload;
  const { sender, requestSignature, depositPermit, requestAuthorization } = velaPayload;

  const provider = new ethers.JsonRpcProvider(config.rpcUrl);
  const signer = config.signer.connect(provider);

  const endpoint = new ethers.Contract(
    config.contractAddress,
    PROCESSOR_ENDPOINT_ABI,
    signer
  );

  // Encode depositPermit as abi.encode(v, r, s) if present, otherwise empty bytes
  let depositPermitEncoded: Uint8Array;
  if (depositPermit && BigInt(requestAuthorization.assetAmount) > 0n) {
    depositPermitEncoded = ethers.getBytes(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint8", "bytes32", "bytes32"],
        [depositPermit.v, depositPermit.r, depositPermit.s]
      )
    );
  } else {
    depositPermitEncoded = new Uint8Array(0);
  }

  const payloadBytes = ethers.getBytes(velaPayload.payload);

  const tx = await endpoint.submitRequestFor(
    sender,
    requestAuthorization.protocolVersion,
    requestAuthorization.applicationId,
    requestAuthorization.requestType,
    payloadBytes,
    requestAuthorization.tokenAddress,
    requestAuthorization.assetAmount,
    requestAuthorization.deadline,
    requestSignature,
    depositPermitEncoded,
    { value: config.maxFeeValue }
  );

  const receipt = await tx.wait();

  if (!receipt) {
    return {
      success: false,
      errorReason: "transaction failed",
      errorMessage: "No receipt received",
      transaction: tx.hash,
      network: requirements.network as any,
    };
  }

  // Extract requestId from RequestSubmitted event
  let requestId: string | undefined;
  for (const log of receipt.logs) {
    try {
      const parsed = endpoint.interface.parseLog(log);
      if (parsed && parsed.name === "RequestSubmitted") {
        requestId = parsed.args[0] as string;
        break;
      }
    } catch {
      // not our event
    }
  }

  return {
    success: true,
    payer: sender,
    transaction: receipt.hash,
    network: requirements.network as any,
    extensions: requestId ? { requestId } : undefined,
  };
}
