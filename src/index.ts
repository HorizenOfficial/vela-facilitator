import { ethers } from "ethers";
import { loadConfig } from "./config.js";
import { createApp } from "./app.js";

async function main() {
  const config = loadConfig();
  const provider = new ethers.JsonRpcProvider(config.rpcUrl);
  const app = createApp(config, provider);

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
