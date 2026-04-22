import { ethers } from "ethers";
import {
  generateKeyPair,
  exportPublicKeyToHex,
  hexToBytes,
  importPublicKeyFromHex,
} from "@horizen/vela-common-ts";
import {
  FacilitatorHelper,
  registerPrivateVelaFixedClient,
} from "@horizen/x402-private-vela-fixed";
import { x402Client } from "@x402/core/client";
import type {
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
} from "@x402/core/types";
import type { GlobalSetupContext } from "vitest/node";
import { startAnvil, stopAnvil, type AnvilInstance } from "../mock/anvil.js";
import { deployContracts } from "../mock/deploy.js";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/app.js";
import { type Server } from "http";

export interface TestFixtures {
  rpcUrl: string;
  chainId: number;
  serverUrl: string;
  contracts: {
    processorEndpoint: { address: string };
    token: { address: string };
    teeAuthenticator: { address: string };
  };
  facilitatorAccount: { address: string; privateKey: string };
  userAccounts: { address: string; privateKey: string }[];
  teePublicKeyHex: string; // hex-encoded Uint8Array for serialization
}

let anvil: AnvilInstance | undefined;
let server: Server | undefined;

export async function setup({ provide }: GlobalSetupContext) {
  const PORT = 3100;

  // Start Anvil on a unique port
  anvil = await startAnvil(8646, 31337);

  const provider = new ethers.JsonRpcProvider(anvil.rpcUrl);
  const deployerWallet = new ethers.Wallet(anvil.accounts[0].privateKey, provider);
  const facilitatorAccount = anvil.accounts[1];
  const userAccounts = anvil.accounts.slice(2, 5);

  // Generate a real P-521 TEE key pair
  const teeKeyPair = await generateKeyPair();
  const teePublicKeyHex = await exportPublicKeyToHex(teeKeyPair.publicKey);
  const teePublicKey = hexToBytes(teePublicKeyHex);

  // Deploy contracts
  const contracts = await deployContracts(provider, deployerWallet, {
    applicationId: 1n,
    tokenRecipients: userAccounts.map((a) => a.address),
    tokenAmount: ethers.parseUnits("10000", 18),
    teePublicKey,
  });

  // Setup facilitator environment
  process.env.RPC_URL = anvil.rpcUrl;
  process.env.FACILITATOR_PRIVATE_KEY = facilitatorAccount.privateKey;
  process.env.PROCESSOR_ENDPOINT_ADDRESS = contracts.processorEndpoint.address;
  process.env.CHAIN_ID = String(anvil.chainId);
  process.env.MAX_FEE_VALUE = "0";
  process.env.VELA_NOVA_APPLICATION_ID = "1";
  process.env.PORT = String(PORT);
  // Keep tests fast: the mock emits AppEvent synchronously with submitRequestFor,
  // so the first poll (immediate) always finds it. Tight timeout also bounds the
  // negative "no AppEvent emitted" case.
  process.env.APP_EVENT_POLL_INTERVAL_MS = "100";
  process.env.APP_EVENT_POLL_TIMEOUT_MS = "3000";

  const config = loadConfig();
  const app = createApp(config, provider);

  await new Promise<void>((resolve) => {
    server = app.listen(PORT, resolve);
  });

  const fixtures: TestFixtures = {
    rpcUrl: anvil.rpcUrl,
    chainId: anvil.chainId,
    serverUrl: `http://127.0.0.1:${PORT}`,
    contracts: {
      processorEndpoint: { address: contracts.processorEndpoint.address },
      token: { address: contracts.token.address },
      teeAuthenticator: { address: contracts.teeAuthenticator.address },
    },
    facilitatorAccount,
    userAccounts,
    teePublicKeyHex,
  };

  // Provide fixtures to fork workers via vitest's cross-process IPC
  provide("testFixtures", fixtures);
}

/**
 * Create a FacilitatorHelper from a test account and fixtures.
 */
export function createClient(privateKey: string, fixtures: TestFixtures): FacilitatorHelper {
  const provider = new ethers.JsonRpcProvider(fixtures.rpcUrl);
  const wallet = new ethers.Wallet(privateKey);

  return new FacilitatorHelper({
    wallet,
    provider,
    contractAddress: fixtures.contracts.processorEndpoint.address,
    tokenAddress: fixtures.contracts.token.address,
    chainId: fixtures.chainId,
    teePublicKeyHex: fixtures.teePublicKeyHex,
    facilitatorUrl: fixtures.serverUrl,
  });
}

/**
 * Build a signed x402 PaymentPayload for the buyer side — using the canonical
 * x402Client + registerPrivateVelaFixedClient pattern (same as production clients).
 */
export async function buildBuyerPaymentPayload(
  privateKey: string,
  requirements: PaymentRequirements,
  fixtures: TestFixtures,
  options: { skipOnchainDeposit?: boolean } = {},
): Promise<PaymentPayload> {
  const provider = new ethers.JsonRpcProvider(fixtures.rpcUrl);
  const signer = new ethers.Wallet(privateKey).connect(provider);
  const buyerP521 = await generateKeyPair();
  const teePublicKey = await importPublicKeyFromHex(fixtures.teePublicKeyHex);
  const network = `eip155:${fixtures.chainId}` as `${string}:${string}`;

  const buyer = new x402Client();
  registerPrivateVelaFixedClient(buyer, {
    signer,
    p521PrivateKey: buyerP521.privateKey,
    teePublicKey,
    rpcUrl: fixtures.rpcUrl,
    contractAddress: fixtures.contracts.processorEndpoint.address,
    applicationId: 1n,
    network,
    skipOnchainDeposit: options.skipOnchainDeposit,
  });

  const paymentRequired: PaymentRequired = {
    x402Version: 2,
    resource: { url: "x402://test" },
    accepts: [requirements],
  };
  return buyer.createPaymentPayload(paymentRequired);
}

export async function teardown() {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
  if (anvil) {
    await stopAnvil(anvil);
  }
}
