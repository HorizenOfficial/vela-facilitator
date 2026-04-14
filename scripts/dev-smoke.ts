/**
 * Dev smoke script for the vela-facilitator.
 *
 * Connects to an already-running facilitator + chain (no bootstrap) and runs
 * a small sequence of HTTP calls that mirrors the e2e test flow:
 *   1. GET  /supported
 *   2. POST /submit      (ASSOCIATEKEY, registers a fresh P-521 key for the buyer)
 *   3. POST /verify      (x402 transfer, assetAmount=0)
 *   4. POST /settle      (x402 transfer, assetAmount=0)
 *
 * All env vars have defaults matching the vela dev stack (see vela/dockerfiles/.env.dev
 * and dockerfiles/.env.dev). Override any of them as needed:
 *   FACILITATOR_URL              default: http://localhost:3000
 *   RPC_URL                      default: http://localhost:8545
 *   CHAIN_ID                     default: 31337
 *   PROCESSOR_ENDPOINT_ADDRESS   default: deterministic Anvil deploy address
 *   TOKEN_ADDRESS                default: ZeroAddress (fine for assetAmount=0)
 *   TEE_PUBLIC_KEY_HEX           default: dev TEE public key (from vela .env.dev)
 *   BUYER_PRIVATE_KEY            default: Anvil account #3
 *   SELLER_ADDRESS               default: Anvil account #4 address
 *   APPLICATION_ID               default: 1 (vela-nova)
 *
 * Prerequisites assumed satisfied on-chain (not performed here):
 *   - ProcessorEndpoint + MockEIP2612Token deployed at the addresses above
 *   - Facilitator account funded with ETH
 *   - Buyer & seller have registered their P-521 keys (ASSOCIATEKEY) — note
 *     that step 2 below registers the buyer's key with a fresh random keypair,
 *     which is sufficient for this smoke since we do not need to decrypt.
 *
 * Run:
 *   pnpm dev:smoke
 */

import { ethers } from "ethers";
import {
  generateKeyPair,
  exportPublicKeyToHex,
  hexToBytes,
} from "@horizen/vela-common-ts";
import {
  FacilitatorClient,
  REQUEST_TYPE_ASSOCIATEKEY,
} from "@horizen/x402-private-vela-fixed";
import type { PaymentRequirements } from "@x402/core/types";

function getEnv(name: string, def: string): string {
  return process.env[name] ?? def;
}

// Dev defaults: match the vela dev stack (Anvil + vela/dockerfiles/.env.dev)
const DEFAULT_FACILITATOR_URL = "http://localhost:3000";
const DEFAULT_RPC_URL = "http://localhost:8545";
const DEFAULT_CHAIN_ID = "31337";
const DEFAULT_PROCESSOR_ENDPOINT_ADDRESS = "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9";
// ZeroAddress: unused when assetAmount=0 (this smoke uses amount="0")
const DEFAULT_TOKEN_ADDRESS = ethers.ZeroAddress;
// TEE uncompressed P-521 public key from vela/dockerfiles/.env.dev (TEE_PUB_P521,
// derived from EXECUTOR_FIXED_COMMUNICATION_KEY)
const DEFAULT_TEE_PUBLIC_KEY_HEX =
  "0x040169e59d61259de5a058803f45aae58beeeec1511b9617aa896bc923ec11347cbb84c580793d424971c53d90dfe2f91266179146bb355a75c6ce537acbb2d5e02a8a011833655720c92a674e054c92d81604eacc25513d524f51caa5d6741129b2ed4be9dfe351174d53a062afba6eaf5775c5ae0e4c351033e583f8b873493ec8b45f58";
// Anvil account #3 (not used by deployer #0, manager #2, or facilitator #8)
const DEFAULT_BUYER_PRIVATE_KEY =
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6";
// Anvil account #4 address
const DEFAULT_SELLER_ADDRESS = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65";
const DEFAULT_APPLICATION_ID = "16137246512537428841";

async function main() {
  const facilitatorUrl = getEnv("FACILITATOR_URL", DEFAULT_FACILITATOR_URL);
  const rpcUrl = getEnv("RPC_URL", DEFAULT_RPC_URL);
  const chainId = parseInt(getEnv("CHAIN_ID", DEFAULT_CHAIN_ID), 10);
  const contractAddress = getEnv("PROCESSOR_ENDPOINT_ADDRESS", DEFAULT_PROCESSOR_ENDPOINT_ADDRESS);
  const tokenAddress = getEnv("TOKEN_ADDRESS", DEFAULT_TOKEN_ADDRESS);
  const teePublicKeyHex = getEnv("TEE_PUBLIC_KEY_HEX", DEFAULT_TEE_PUBLIC_KEY_HEX);
  const buyerPrivateKey = getEnv("BUYER_PRIVATE_KEY", DEFAULT_BUYER_PRIVATE_KEY);
  const sellerAddress = getEnv("SELLER_ADDRESS", DEFAULT_SELLER_ADDRESS);
  const applicationId = BigInt(getEnv("APPLICATION_ID", DEFAULT_APPLICATION_ID));

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(buyerPrivateKey);

  const client = new FacilitatorClient({
    wallet,
    provider,
    contractAddress,
    tokenAddress,
    chainId,
    teePublicKeyHex,
    facilitatorUrl,
  });

  console.log(`\n=== dev-smoke ===`);
  console.log(`Facilitator: ${facilitatorUrl}`);
  console.log(`RPC:         ${rpcUrl} (chainId=${chainId})`);
  console.log(`Buyer:       ${wallet.address}`);
  console.log(`Seller:      ${sellerAddress}`);
  console.log(`AppId:       ${applicationId}`);

  // 1. GET /supported
  console.log(`\n[1/4] GET /supported`);
  const supported = await client.supported();
  if (supported.status !== 200) {
    throw new Error(`GET /supported failed: ${supported.status} ${JSON.stringify(supported.body)}`);
  }
  console.log(`      -> ${JSON.stringify(supported.body)}`);

  // 2. POST /submit (ASSOCIATEKEY)
  console.log(`\n[2/4] POST /submit (ASSOCIATEKEY)`);
  const keyPair = await generateKeyPair();
  const pubKeyHex = await exportPublicKeyToHex(keyPair.publicKey);
  const rawPayload = hexToBytes(pubKeyHex);
  const assoc = await client.submit({
    requestType: REQUEST_TYPE_ASSOCIATEKEY,
    payload: rawPayload,
    assetAmount: 0n,
    applicationId,
  });
  if (assoc.status !== 200) {
    throw new Error(`POST /submit failed: ${assoc.status} ${JSON.stringify(assoc.body)}`);
  }
  console.log(`      -> requestId=${assoc.body.requestId}`);

  // 3. POST /verify  &&  4. POST /settle
  const requirements: PaymentRequirements = {
    scheme: "private-vela-fixed",
    network: `eip155:${chainId}`,
    asset: tokenAddress,
    amount: "0",
    payTo: sellerAddress,
    maxTimeoutSeconds: 60,
    extra: { invoiceId: `INV-SMOKE-${Date.now()}` },
  };
  const paymentPayload = await client.buildX402Payload({ requirements });

  console.log(`\n[3/4] POST /verify`);
  const verify = await client.verify(paymentPayload, requirements);
  if (verify.status !== 200 || verify.body.isValid !== true) {
    throw new Error(`POST /verify failed: ${verify.status} ${JSON.stringify(verify.body)}`);
  }
  console.log(`      -> isValid=${verify.body.isValid}`);

  console.log(`\n[4/4] POST /settle`);
  const settle = await client.settle(paymentPayload, requirements);
  if (settle.status !== 200 || settle.body.success !== true) {
    throw new Error(`POST /settle failed: ${settle.status} ${JSON.stringify(settle.body)}`);
  }
  console.log(`      -> success=${settle.body.success} payer=${settle.body.payer}`);
  const requestId = (settle.body.extensions as Record<string, string> | undefined)?.requestId;
  if (requestId) console.log(`      -> requestId=${requestId}`);

  console.log(`\nAll steps OK.\n`);
}

main().catch((err) => {
  console.error("\nSmoke failed:", err);
  process.exit(1);
});
