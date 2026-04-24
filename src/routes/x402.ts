import { Router, Request, Response } from "express";
import { x402Facilitator } from "@x402/core/facilitator";

export function createX402Router(facilitator: x402Facilitator): Router {
  const router = Router();

  // GET /supported — returns supported schemes, networks, and signers
  router.get("/supported", (_req: Request, res: Response) => {
    try {
      const supported = facilitator.getSupported();
      res.json(supported);
    } catch (err) {
      res.status(500).json({ error: "Failed to get supported schemes" });
    }
  });

  // POST /verify — off-chain signature validation
  router.post("/verify", async (req: Request, res: Response) => {
    try {
      const { paymentPayload, paymentRequirements } = req.body;
      if (!paymentPayload || !paymentRequirements) {
        res.status(400).json({ error: "Missing paymentPayload or paymentRequirements" });
        return;
      }
      const result = await facilitator.verify(paymentPayload, paymentRequirements);
      res.json(result);
    } catch (err) {
      res.status(500).json({
        isValid: false,
        invalidReason: "internal error",
        invalidMessage: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // POST /settle — on-chain settlement via submitRequestFor
  router.post("/settle", async (req: Request, res: Response) => {
    try {
      const { paymentPayload, paymentRequirements } = req.body;
      if (!paymentPayload || !paymentRequirements) {
        res.status(400).json({ error: "Missing paymentPayload or paymentRequirements" });
        return;
      }
      const result = await facilitator.settle(paymentPayload, paymentRequirements);
      res.json(result);
    } catch (err) {
      res.status(500).json({
        success: false,
        errorReason: "internal error",
        errorMessage: err instanceof Error ? err.message : String(err),
        transaction: "",
        network: "",
      });
    }
  });

  return router;
}
