import { ethers } from "ethers";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function getEnv(name: string, defaultValue: string): string {
  return process.env[name] ?? defaultValue;
}

export interface Config {
  rpcUrl: string;
  contractAddress: string;
  signer: ethers.Wallet;
  chainId: number;
  maxFeeValue: bigint;
  applicationId: bigint;
  port: number;
  network: string;
}

export function loadConfig(): Config {
  const rpcUrl = requireEnv("RPC_URL");
  const privateKey = requireEnv("FACILITATOR_PRIVATE_KEY");
  const contractAddress = requireEnv("PROCESSOR_ENDPOINT_ADDRESS");
  const chainId = parseInt(requireEnv("CHAIN_ID"), 10);
  const maxFeeValue = BigInt(getEnv("MAX_FEE_VALUE", "50"));
  const applicationId = BigInt(getEnv("VELA_NOVA_APPLICATION_ID", "1"));
  const port = parseInt(getEnv("PORT", "3000"), 10);

  const signer = new ethers.Wallet(privateKey);
  const network = `eip155:${chainId}`;

  return {
    rpcUrl,
    contractAddress,
    signer,
    chainId,
    maxFeeValue,
    applicationId,
    port,
    network,
  };
}
