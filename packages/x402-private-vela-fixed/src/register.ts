import { ethers } from "ethers";
import { x402Facilitator } from "@x402/core/facilitator";
import { PrivateVelaFixedScheme } from "./scheme.js";
import { VelaSchemeConfig } from "./types.js";

/**
 * Register the private-vela-fixed scheme on an x402Facilitator.
 *
 * @param facilitator - The x402Facilitator instance to register the scheme on
 * @param config - Configuration for the scheme (rpcUrl, contractAddress, signer, etc.)
 * @returns The x402Facilitator instance for chaining
 *
 * @example
 * ```typescript
 * const facilitator = new x402Facilitator();
 * await registerPrivateVelaFixedScheme(facilitator, {
 *   rpcUrl: "https://rpc.vela.network",
 *   contractAddress: "0x...",
 *   signer: new ethers.Wallet(privateKey),
 *   maxFeeValue: 1000000000000000n,
 *   applicationId: 1n,
 * });
 * ```
 */
export async function registerPrivateVelaFixedScheme(
  facilitator: x402Facilitator,
  config: VelaSchemeConfig
): Promise<x402Facilitator> {
  const { chainId } = await new ethers.JsonRpcProvider(config.rpcUrl).getNetwork();
  const network = `eip155:${chainId}`;
  facilitator.register(network as any, new PrivateVelaFixedScheme(config));
  return facilitator;
}
