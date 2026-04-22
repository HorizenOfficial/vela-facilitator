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
  maxFeeValue: bigint;
  applicationId: bigint;
  port: number;
  appEventPollIntervalMs?: number;
  appEventPollTimeoutMs?: number;
}

export function loadConfig(): Config {
  const rpcUrl = requireEnv("RPC_URL");
  const privateKey = requireEnv("FACILITATOR_PRIVATE_KEY");
  const contractAddress = requireEnv("PROCESSOR_ENDPOINT_ADDRESS");
  const maxFeeValue = BigInt(getEnv("MAX_FEE_VALUE", "50"));
  const applicationId = BigInt(getEnv("VELA_NOVA_APPLICATION_ID", "1"));
  const port = parseInt(getEnv("PORT", "3000"), 10);
  const appEventPollIntervalMs = process.env.APP_EVENT_POLL_INTERVAL_MS
    ? parseInt(process.env.APP_EVENT_POLL_INTERVAL_MS, 10)
    : undefined;
  const appEventPollTimeoutMs = process.env.APP_EVENT_POLL_TIMEOUT_MS
    ? parseInt(process.env.APP_EVENT_POLL_TIMEOUT_MS, 10)
    : undefined;

  const signer = new ethers.Wallet(privateKey);

  return {
    rpcUrl,
    contractAddress,
    signer,
    maxFeeValue,
    applicationId,
    port,
    appEventPollIntervalMs,
    appEventPollTimeoutMs,
  };
}
