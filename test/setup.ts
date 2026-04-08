import { ethers } from "ethers";
import { generateKeyPair, exportPublicKeyToHex, hexToBytes } from "@horizen/vela-common-ts";
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

export async function teardown() {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
  if (anvil) {
    await stopAnvil(anvil);
  }
}
