import { Router, Request, Response } from "express";
import { ethers } from "ethers";
import { Config } from "../config.js";

// Minimal ABI for claim() on ProcessorEndpoint.
const PROCESSOR_ENDPOINT_ABI = [
  "function claim(address tokenAddress, address payable payee)",
  "event PaymentWithdrawn(address tokenAddress, address indexed payee, uint256 amount)",
];

export function createClaimRouter(config: Config, signer: ethers.Signer): Router {
  const router = Router();

  /**
   * POST /claim
   * Public endpoint: anyone can trigger a claim on behalf of `payee`.
   * Calls `ProcessorEndpoint.claim(tokenAddress, payee)` with the facilitator as sender
   * (payer of gas). The pending balance is transferred to `payee` directly on-chain.
   *
   * Body: { "tokenAddress": "0x...", "payee": "0x..." }
   * Response: { "txHash": "0x...", "amount": "<wei>" } (amount=0 if nothing to claim)
   */
  router.post("/claim", async (req: Request, res: Response) => {
    try {
      const { tokenAddress, payee } = req.body ?? {};

      if (!tokenAddress || typeof tokenAddress !== "string" || !ethers.isAddress(tokenAddress)) {
        res.status(400).json({ error: "Missing or invalid tokenAddress" });
        return;
      }
      if (!payee || typeof payee !== "string" || !ethers.isAddress(payee)) {
        res.status(400).json({ error: "Missing or invalid payee" });
        return;
      }

      const provider = new ethers.JsonRpcProvider(config.rpcUrl);
      const connectedSigner = signer.connect(provider);
      const endpoint = new ethers.Contract(
        config.contractAddress,
        PROCESSOR_ENDPOINT_ABI,
        connectedSigner,
      );

      const tx = await endpoint.claim(tokenAddress, payee);
      const receipt = await tx.wait();

      if (!receipt) {
        res.status(500).json({ error: "Transaction failed: no receipt" });
        return;
      }

      // Extract amount from PaymentWithdrawn event, if any (claim is a no-op when pending=0).
      let amount = "0";
      for (const log of receipt.logs) {
        try {
          const parsed = endpoint.interface.parseLog(log);
          if (parsed && parsed.name === "PaymentWithdrawn") {
            amount = (parsed.args.amount as bigint).toString();
            break;
          }
        } catch {
          // not our event
        }
      }

      res.json({ txHash: receipt.hash, amount });
    } catch (err) {
      console.error("POST /claim error:", err);
      res.status(500).json({
        error: "Claim failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return router;
}
