import type { SchemeNetworkFacilitator, FacilitatorContext } from "@x402/core/types";
import type { VerifyResponse, SettleResponse } from "@x402/core/types";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import type { Network } from "@x402/core/types";
import { ethers } from "ethers";
import { verifyPayment } from "./verify.js";
import { settlePayment } from "./settle.js";
import { VelaSchemeConfig } from "./types.js";

export const SCHEME_NAME = "private-vela-fixed" as const;

/**
 * Implements SchemeNetworkFacilitator for the private-vela-fixed x402 scheme.
 * Handles vela-nova specific flows: EIP-712 request authorization, EIP-2612 permit,
 * encrypted payloads, and submitRequestFor() on-chain settlement.
 */
export class PrivateVelaFixedScheme implements SchemeNetworkFacilitator {
  readonly scheme = SCHEME_NAME;
  readonly caipFamily = "eip155:*";

  private readonly config: VelaSchemeConfig;

  constructor(config: VelaSchemeConfig) {
    this.config = config;
  }

  getExtra(_network: Network): Record<string, unknown> | undefined {
    return undefined;
  }

  getSigners(_network: string): string[] {
    // Return the facilitator wallet address synchronously
    // ethers.Wallet has a synchronous .address property
    const signer = this.config.signer as ethers.Wallet;
    if (signer.address) {
      return [signer.address];
    }
    return [];
  }

  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    _context?: FacilitatorContext
  ): Promise<VerifyResponse> {
    return verifyPayment(payload, requirements, this.config);
  }

  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    _context?: FacilitatorContext
  ): Promise<SettleResponse> {
    return settlePayment(payload, requirements, this.config);
  }
}
