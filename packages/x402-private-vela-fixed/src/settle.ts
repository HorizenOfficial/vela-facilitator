import { ethers } from "ethers";
import type { SettleResponse } from "@x402/core/types";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { verifyPayment } from "./verify.js";
import { VelaPaymentPayload, VelaPaymentRequirementsExtra, VelaSchemeConfig } from "./types.js";
import { computeTransferReceiptHash } from "./transfer-receipt-hash.js";

// Minimal ABI for submitRequestFor + the two events settle cares about.
const PROCESSOR_ENDPOINT_ABI = [
  "function submitRequestFor(address sender, uint8 protocolVersion, uint64 applicationId, uint8 requestType, bytes payload, address tokenAddress, uint256 assetAmount, uint256 deadline, bytes requestSignature, bytes depositPermit) payable returns (bytes32)",
  "event RequestSubmitted(uint64 indexed applicationId, bytes32 indexed requestId, address indexed sender, address facilitator)",
  "event AppEvent(uint64 indexed applicationId, bytes32 indexed requestId, bytes32 indexed eventSubType, bytes data)",
];

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_POLL_TIMEOUT_MS = 60_000;

/**
 * On-chain settlement + TEE-completion wait.
 *
 * Flow:
 *   1. Re-verify the payment off-chain.
 *   2. Call `submitRequestFor()` on the ProcessorEndpoint and wait for the tx receipt
 *      (also extracting the `requestId` from the `RequestSubmitted` event).
 *   3. Compute the expected transfer-receipt hash — the same hash vela-nova emits
 *      as `AppEvent.eventSubType` when the TEE successfully processes the transfer.
 *   4. Poll for `AppEvent(applicationId, requestId, expectedHash)`. Only return
 *      `success: true` once that event is observed. On timeout, return
 *      `errorReason: "tee_processing_timeout"`.
 *
 * This means "/settle 200 OK" is now a strong guarantee: the TEE has processed the
 * transfer and its receipt matches the PaymentRequirements (invoiceId, sender,
 * token, amount, recipient are all bound into the hash).
 */
export async function settlePayment(
  paymentPayload: PaymentPayload,
  requirements: PaymentRequirements,
  config: VelaSchemeConfig
): Promise<SettleResponse> {
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

  let requestId: string | undefined;
  for (const log of receipt.logs) {
    try {
      const parsed = endpoint.interface.parseLog(log);
      if (parsed && parsed.name === "RequestSubmitted") {
        requestId = parsed.args.requestId as string;
        break;
      }
    } catch {
      // not our event
    }
  }

  if (!requestId) {
    return {
      success: false,
      errorReason: "missing_request_id",
      errorMessage: "RequestSubmitted event not found in receipt",
      transaction: receipt.hash,
      network: requirements.network as any,
    };
  }

  // Compute the expected AppEvent.eventSubType hash. vela-nova emits this only when
  // the transfer carries a non-empty invoiceId; the x402 scheme requires one.
  const extra = requirements.extra as unknown as VelaPaymentRequirementsExtra | undefined;
  const invoiceId = extra?.invoiceId;
  if (!invoiceId) {
    return {
      success: false,
      errorReason: "missing_invoice_id",
      errorMessage: "requirements.extra.invoiceId is required to track TEE completion",
      transaction: receipt.hash,
      network: requirements.network as any,
    };
  }

  const expectedEventSubType = computeTransferReceiptHash({
    invoiceId,
    sender,
    tokenAddress: requirements.asset,
    amount: BigInt(requirements.amount),
    recipient: requirements.payTo,
  });

  const found = await waitForAppEvent(endpoint, {
    applicationId: requestAuthorization.applicationId,
    requestId,
    eventSubType: expectedEventSubType,
    fromBlock: receipt.blockNumber,
    intervalMs: config.appEventPollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    timeoutMs: config.appEventPollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS,
  });

  if (!found) {
    return {
      success: false,
      errorReason: "tee_processing_timeout",
      errorMessage: `timed out waiting for TEE AppEvent(requestId=${requestId}, eventSubType=${expectedEventSubType})`,
      transaction: receipt.hash,
      network: requirements.network as any,
      extensions: { requestId },
    };
  }

  return {
    success: true,
    payer: sender,
    transaction: receipt.hash,
    network: requirements.network as any,
    extensions: { requestId, eventSubType: expectedEventSubType },
  };
}

async function waitForAppEvent(
  endpoint: ethers.Contract,
  params: {
    applicationId: bigint;
    requestId: string;
    eventSubType: string;
    fromBlock: number;
    intervalMs: number;
    timeoutMs: number;
  },
): Promise<boolean> {
  const filter = endpoint.filters.AppEvent(
    params.applicationId,
    params.requestId,
    params.eventSubType,
  );
  const deadline = Date.now() + params.timeoutMs;
  // Query once immediately — the TEE may have processed within the same block as
  // submitRequestFor (tests do this via a mock that emits synchronously).
  do {
    const events = (await endpoint.queryFilter(filter, params.fromBlock)) as ethers.EventLog[];
    if (events.some((e) => !e.removed)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(params.intervalMs);
  } while (true);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
