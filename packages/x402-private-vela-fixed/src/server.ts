import type { SchemeNetworkServer } from "@x402/core/types";
import type { PaymentRequirements } from "@x402/core/types";
import type { Network, AssetAmount, Price } from "@x402/core/types";
import { x402ResourceServer } from "@x402/core/server";
import { SCHEME_NAME } from "./scheme";

export interface VelaServerConfig {
  network: string;
  payTo: string;         // seller's Ethereum address
  tokenAddress: string;  // ERC-20 token for deposits
  contractAddress: string; // ProcessorEndpoint address
}

/**
 * Server-side scheme implementation for private-vela-fixed.
 * Configures PaymentRequirements with vela-specific fields.
 */
class PrivateVelaFixedServerScheme implements SchemeNetworkServer {
  readonly scheme = SCHEME_NAME;

  constructor(private readonly config: VelaServerConfig) {}

  async parsePrice(price: Price, _network: Network): Promise<AssetAmount> {
    if (typeof price === "object" && "amount" in price) {
      return price as AssetAmount;
    }
    // Treat string/number as raw token units
    return {
      asset: this.config.tokenAddress,
      amount: String(price),
    };
  }

  getAssetDecimals(_asset: string, _network: Network): number {
    return 18; // default — real implementation would query the token contract
  }

  async enhancePaymentRequirements(
    paymentRequirements: PaymentRequirements,
    _supportedKind: {
      x402Version: number;
      scheme: string;
      network: Network;
      extra?: Record<string, unknown>;
    },
    _facilitatorExtensions: string[]
  ): Promise<PaymentRequirements> {
    // Ensure the token address is set in the asset field
    return {
      ...paymentRequirements,
      asset: this.config.tokenAddress,
    };
  }
}

/**
 * Register the private-vela-fixed scheme on an x402ResourceServer (seller side).
 *
 * @param resourceServer - The x402ResourceServer instance to register the scheme on
 * @param config - Configuration for the server (network, payTo, tokenAddress, contractAddress)
 * @returns The x402ResourceServer instance for chaining
 *
 * @example
 * ```typescript
 * const resourceServer = new x402ResourceServer(facilitatorClient);
 * registerPrivateVelaFixedServer(resourceServer, {
 *   network: "eip155:2651420",
 *   payTo: sellerAddress,
 *   tokenAddress: usdcAddress,
 *   contractAddress: processorEndpointAddr,
 * });
 * ```
 */
export function registerPrivateVelaFixedServer(
  resourceServer: x402ResourceServer,
  config: VelaServerConfig
): x402ResourceServer {
  const scheme = new PrivateVelaFixedServerScheme(config);
  resourceServer.register(config.network as Network, scheme);
  return resourceServer;
}
