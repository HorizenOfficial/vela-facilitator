import type { SchemeNetworkClient, PaymentPayloadResult, PaymentPayloadContext } from "@x402/core/types";
import type { PaymentRequirements } from "@x402/core/types";
import { x402Client } from "@x402/core/client";
import { signPayment, VelaClientConfig } from "./sign.js";
import { SCHEME_NAME } from "./scheme.js";

export type { VelaClientConfig };

/**
 * Client-side scheme implementation for private-vela-fixed.
 * Handles all vela-nova specific logic:
 * - Reads nonces from chain
 * - Builds and encrypts transfer payload
 * - Signs EIP-712 request authorization + EIP-2612 permit
 */
class PrivateVelaFixedClientScheme implements SchemeNetworkClient {
  readonly scheme = SCHEME_NAME;

  constructor(private readonly config: VelaClientConfig) {}

  async createPaymentPayload(
    x402Version: number,
    requirements: PaymentRequirements,
    _context?: PaymentPayloadContext
  ): Promise<PaymentPayloadResult> {
    const payload = await signPayment(x402Version, requirements, this.config);
    return {
      x402Version: payload.x402Version,
      payload: payload.payload,
    };
  }
}

/**
 * Register the private-vela-fixed scheme on an x402Client (buyer side).
 *
 * @param client - The x402Client instance to register the scheme on
 * @param config - Configuration for the client (signer, P-521 keys, rpcUrl, etc.)
 * @returns The x402Client instance for chaining
 *
 * @example
 * ```typescript
 * const client = new x402Client();
 * registerPrivateVelaFixedClient(client, {
 *   signer: buyerSigner,
 *   p521PrivateKey: buyerP521Key,
 *   teePublicKey: teeP521PublicKey,
 *   rpcUrl: "https://rpc.vela.network",
 *   contractAddress: processorEndpointAddr,
 * });
 * ```
 */
export function registerPrivateVelaFixedClient(
  client: x402Client,
  config: VelaClientConfig & { network: string }
): x402Client {
  const scheme = new PrivateVelaFixedClientScheme(config);
  client.register(config.network as any, scheme);
  return client;
}
