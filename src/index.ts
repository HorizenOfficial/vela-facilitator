import express from "express";
import cors from "cors";
import { ethers } from "ethers";
import { x402Facilitator } from "@x402/core/facilitator";
import { registerPrivateVelaFixedScheme } from "@horizen/x402-private-vela-fixed";
import { loadConfig } from "./config.js";
import { createX402Router } from "./routes/x402.js";
import { createSubmitRouter } from "./routes/submit.js";

async function main() {
  const config = loadConfig();

  // Create ethers provider + connect signer
  const provider = new ethers.JsonRpcProvider(config.rpcUrl);
  const signer = config.signer.connect(provider);

  // Create x402Facilitator and register our scheme
  const facilitator = new x402Facilitator();
  registerPrivateVelaFixedScheme(facilitator, {
    rpcUrl: config.rpcUrl,
    contractAddress: config.contractAddress,
    signer,
    maxFeeValue: config.maxFeeValue,
    applicationId: config.applicationId,
    network: config.network,
  });

  // Express app
  const app = express();
  app.use(cors());
  app.use(express.json());

  // x402 routes
  app.use("/", createX402Router(facilitator));

  // Core submit route
  app.use("/", createSubmitRouter(config, signer));

  // Error handler
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  });

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
