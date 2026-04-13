import { ethers } from "ethers";
import { loadConfig } from "./config.js";
import { createApp } from "./app.js";

async function main() {
  const config = loadConfig();
  const provider = new ethers.JsonRpcProvider(config.rpcUrl);
  const app = createApp(config, provider);

  const facilitatorAddress = await config.signer.getAddress();
  const balance = await provider.getBalance(facilitatorAddress);
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
    console.log(`Network: ${config.network}`);
    console.log(`Contract: ${config.contractAddress}`);
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
