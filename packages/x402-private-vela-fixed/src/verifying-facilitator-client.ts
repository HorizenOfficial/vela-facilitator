import { ethers } from "ethers";
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "@x402/core/types";
import type { FacilitatorClient } from "@x402/core/server";
import { decrypt } from "@horizen/vela-common-ts";
import { bytesToString } from "@horizen/vela-common-ts";

/**
 * Seller-side wrapper around a base FacilitatorClient that turns the x402 settle
 * into a *blocking, fully-verified* call.
 *
 * Default facilitator semantics ("settle succeeds = tx mined on-chain") are too weak
 * for the seller: at that point the TEE hasn't processed the request yet, so the
 * payment may still fail. This wrapper, instead:
 *
 *  1. Calls the underlying `settle()` (HTTP to the facilitator).
 *  2. Waits for the `RequestCompleted` event matching the returned `requestId`.
 *  3. Queries `UserEvent(applicationId, requestId)` logs on-chain and decrypts
 *     them with the seller's P-521 key.
 *  4. Verifies the decrypted `transfer_received` event matches the payment
 *     requirements (to, tokenAddress, amount, invoice_id).
 *  5. Only then returns `success: true`. On any mismatch/timeout/failure, returns
 *     `success: false` with a descriptive reason.
 *
 * `verify()` and `getSupported()` are forwarded unchanged.
 */
export interface VerifyingFacilitatorClientConfig {
  /** Underlying facilitator client (typically HTTPFacilitatorClient). */
  baseClient: FacilitatorClient;
  /** RPC provider used to query on-chain events. */
  provider: ethers.JsonRpcProvider;
  /** ProcessorEndpoint contract address. */
  contractAddress: string;
  /** vela-nova applicationId expected in events. */
  applicationId: bigint;
  /** The seller's Ethereum address — the expected recipient of the transfer. */
  sellerAddress: string;
  /** The seller's P-521 private key (the one registered via ASSOCIATEKEY). */
  sellerP521PrivateKey: CryptoKey;
  /** The TEE's P-521 public key (needed for ECIES decrypt). */
  teePublicKey: CryptoKey;
  /** Polling interval (ms) for RequestCompleted. Default 2000. */
  pollIntervalMs?: number;
  /** Polling timeout (ms) for RequestCompleted. Default 60000. */
  pollTimeoutMs?: number;
}

const PROCESSOR_ABI = [
  "event RequestCompleted(uint64 indexed applicationId, bytes32 indexed requestId, uint256 applicationFees, uint8 status, uint8 errorCode, string errorMessage)",
  "event UserEvent(uint64 indexed applicationId, bytes32 indexed requestId, string indexed eventSubType, bytes encryptedData)",
];

interface DecodedTransferReceivedEvent {
  type: string;
  from: string;
  tokenAddress: string;
  amount: string;       // hex Uint256
  balance?: string;
  nonce?: number;
  invoice_id?: string;
}

export class VerifyingFacilitatorClient implements FacilitatorClient {
  private readonly cfg: Required<Omit<VerifyingFacilitatorClientConfig, never>>;
  private readonly contract: ethers.Contract;

  constructor(config: VerifyingFacilitatorClientConfig) {
    this.cfg = {
      baseClient: config.baseClient,
      provider: config.provider,
      contractAddress: config.contractAddress,
      applicationId: config.applicationId,
      sellerAddress: config.sellerAddress,
      sellerP521PrivateKey: config.sellerP521PrivateKey,
      teePublicKey: config.teePublicKey,
      pollIntervalMs: config.pollIntervalMs ?? 2_000,
      pollTimeoutMs: config.pollTimeoutMs ?? 60_000,
    };
    this.contract = new ethers.Contract(
      this.cfg.contractAddress,
      PROCESSOR_ABI,
      this.cfg.provider,
    );
  }

  verify(paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements): Promise<VerifyResponse> {
    return this.cfg.baseClient.verify(paymentPayload, paymentRequirements);
  }

  getSupported(): Promise<SupportedResponse> {
    return this.cfg.baseClient.getSupported();
  }

  async settle(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    const base = await this.cfg.baseClient.settle(paymentPayload, paymentRequirements);
    if (!base.success) return base;

    const requestId = (base.extensions as Record<string, unknown> | undefined)?.requestId as
      | string
      | undefined;
    if (!requestId) {
      return fail(base, "missing_request_id", "facilitator /settle did not return a requestId");
    }

    // 1. Wait for RequestCompleted
    const completed = await this.waitForRequestCompleted(requestId);
    if (!completed) {
      return fail(
        base,
        "tee_processing_timeout",
        `timeout (${this.cfg.pollTimeoutMs}ms) waiting for RequestCompleted(${requestId})`,
      );
    }
    if (completed.status !== 0n) {
      return fail(
        base,
        "tee_failed",
        `TEE returned status=${completed.status} errorCode=${completed.errorCode} errorMessage="${completed.errorMessage}"`,
      );
    }

    // 2. Query + decrypt UserEvents for this requestId
    const decoded = await this.findDecryptedTransferReceived(requestId);
    if (!decoded) {
      return fail(
        base,
        "transfer_event_not_found",
        `no transfer_received event decryptable by the seller key was found for requestId=${requestId}`,
      );
    }

    // 3. Verify fields against requirements
    const mismatch = verifyTransferAgainstRequirements(
      decoded,
      paymentPayload,
      paymentRequirements,
      this.cfg.sellerAddress,
    );
    if (mismatch) {
      return fail(base, "transfer_mismatch", mismatch);
    }

    // All checks OK — return the base response (possibly enriched with decoded data)
    return {
      ...base,
      extensions: {
        ...(base.extensions ?? {}),
        transferEvent: decoded,
      },
    };
  }

  // ---------------------------------------------------------------------------

  private async waitForRequestCompleted(
    requestId: string,
  ): Promise<{ status: bigint; errorCode: bigint; errorMessage: string } | undefined> {
    const deadline = Date.now() + this.cfg.pollTimeoutMs;
    const filter = this.contract.filters.RequestCompleted(this.cfg.applicationId, requestId);
    while (Date.now() < deadline) {
      await sleep(this.cfg.pollIntervalMs);
      const events = (await this.contract.queryFilter(filter)) as ethers.EventLog[];
      const valid = events.filter((e) => !e.removed);
      if (valid.length > 0) {
        const ev = valid[0];
        return {
          status: ev.args.status as bigint,
          errorCode: ev.args.errorCode as bigint,
          errorMessage: ev.args.errorMessage as string,
        };
      }
    }
    return undefined;
  }

  private async findDecryptedTransferReceived(
    requestId: string,
  ): Promise<DecodedTransferReceivedEvent | undefined> {
    const filter = this.contract.filters.UserEvent(this.cfg.applicationId, requestId);
    const events = (await this.contract.queryFilter(filter)) as ethers.EventLog[];
    for (const ev of events) {
      if (ev.removed) continue;
      const encryptedData = ethers.getBytes(ev.args.encryptedData as string);
      let plaintext: Uint8Array;
      try {
        plaintext = await decrypt(this.cfg.sellerP521PrivateKey, this.cfg.teePublicKey, encryptedData);
      } catch {
        // Event not intended for this seller — skip.
        continue;
      }
      try {
        const obj = JSON.parse(bytesToString(plaintext)) as DecodedTransferReceivedEvent;
        if (obj?.type === "transfer_received") return obj;
      } catch {
        // Not JSON / not our event shape — skip.
      }
    }
    return undefined;
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function fail(base: SettleResponse, reason: string, message: string): SettleResponse {
  return {
    ...base,
    success: false,
    errorReason: reason,
    errorMessage: message,
  };
}

function verifyTransferAgainstRequirements(
  ev: DecodedTransferReceivedEvent,
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  expectedRecipient: string,
): string | undefined {
  // Note: `to` is not in the transfer_received payload (the user IS `to`).
  // We verify that the event was *decryptable by the seller key*, which already
  // proves the seller was the recipient. In addition, we cross-check that the
  // payload's PaymentRequirements.payTo equals the seller's address.
  const payTo = requirements.payTo;
  if (payTo.toLowerCase() !== expectedRecipient.toLowerCase()) {
    return `requirements.payTo (${payTo}) does not match seller address (${expectedRecipient})`;
  }

  // `from` must be the payment sender
  const sender = (payload.payload as { sender?: string } | undefined)?.sender;
  if (!sender || ev.from.toLowerCase() !== sender.toLowerCase()) {
    return `event.from (${ev.from}) does not match payment sender (${sender})`;
  }

  // amount: event is hex Uint256, requirements is decimal string
  let evAmount: bigint;
  try {
    evAmount = BigInt(ev.amount);
  } catch {
    return `event.amount is not a valid bigint: "${ev.amount}"`;
  }
  const expectedAmount = BigInt(requirements.amount);
  if (evAmount !== expectedAmount) {
    return `event.amount (${evAmount}) != requirements.amount (${expectedAmount})`;
  }

  // tokenAddress
  if (ev.tokenAddress.toLowerCase() !== requirements.asset.toLowerCase()) {
    return `event.tokenAddress (${ev.tokenAddress}) != requirements.asset (${requirements.asset})`;
  }

  // invoice_id
  const expectedInvoiceId = (requirements.extra as Record<string, unknown> | undefined)?.invoiceId as
    | string
    | undefined;
  if (expectedInvoiceId !== undefined && expectedInvoiceId !== "") {
    if ((ev.invoice_id ?? "") !== expectedInvoiceId) {
      return `event.invoice_id ("${ev.invoice_id ?? ""}") != requirements.extra.invoiceId ("${expectedInvoiceId}")`;
    }
  }

  return undefined;
}
