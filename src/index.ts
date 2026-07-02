import { existsSync } from "node:fs";
import { ethers } from "ethers";
import { loadConfig } from "./config.js";
import { createApp } from "./app.js";

// Load a local .env file if present (convenient for `pnpm dev`). Variables already
// set in the environment take precedence, so deployments that inject env vars
// directly are unaffected; in production no .env file exists, so this is a no-op.
if (existsSync(".env")) {
  process.loadEnvFile(".env");
}

async function main() {
  const config = loadConfig();
  const provider = new ethers.JsonRpcProvider(config.rpcUrl);
  const app = await createApp(config, provider);

  const facilitatorAddress = await config.signer.getAddress();
  const balance = await provider.getBalance(facilitatorAddress);
  const { chainId } = await provider.getNetwork();
  console.log(
    `Facilitator address: ${facilitatorAddress} (balance: ${ethers.formatEther(balance)} ETH)`,
  );
  if (balance === 0n) {
    console.warn(
      `WARNING: facilitator address ${facilitatorAddress} has zero ETH balance; transactions will fail until it is funded`,
    );
  }

  app.listen(config.port, () => {
    console.log(`vela-facilitator listening on port ${config.port}`);
    console.log(`Network: eip155:${chainId}`);
    console.log(`Contract: ${config.contractAddress}`);
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
