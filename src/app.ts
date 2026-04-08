import express from "express";
import cors from "cors";
import { x402Facilitator } from "@x402/core/facilitator";
import { registerPrivateVelaFixedScheme } from "@horizen/x402-private-vela-fixed";
import { createX402Router } from "./routes/x402.js";
import { createSubmitRouter } from "./routes/submit.js";
import type { ethers } from "ethers";
import type { Config } from "./config.js";

export function createApp(config: Config, provider: ethers.JsonRpcProvider): express.Express {
  const signer = config.signer.connect(provider);

  const facilitator = new x402Facilitator();
  registerPrivateVelaFixedScheme(facilitator, {
    rpcUrl: config.rpcUrl,
    contractAddress: config.contractAddress,
    signer,
    maxFeeValue: config.maxFeeValue,
    applicationId: config.applicationId,
    network: config.network,
  });

  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use("/", createX402Router(facilitator));
  app.use("/", createSubmitRouter(config, signer));

  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}
