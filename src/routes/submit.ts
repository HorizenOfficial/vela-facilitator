import { Router, Request, Response } from "express";
import { ethers } from "ethers";
import { Config } from "../config.js";

// Minimal ABI for submitRequestFor
const PROCESSOR_ENDPOINT_ABI = [
  "function submitRequestFor(address sender, uint8 protocolVersion, uint64 applicationId, uint8 requestType, bytes payload, address tokenAddress, uint256 assetAmount, uint256 deadline, bytes requestSignature, bytes depositPermit) payable returns (bytes32)",
  "event RequestSubmitted(uint64 indexed applicationId, bytes32 indexed requestId, address indexed sender, address facilitator)",
];

// Request type constants (mirrors Solidity enum)
const REQUEST_TYPE_PROCESS = 1;
const REQUEST_TYPE_ASSOCIATEKEY = 3;

export function createSubmitRouter(config: Config, signer: ethers.Signer): Router {
  const router = Router();

  /**
   * POST /submit
   * Application-agnostic facilitator endpoint for direct clients (mobile SDK, CLI, bots).
   * Supports ASSOCIATEKEY and PROCESS request types.
   * Nonce queries are done by clients directly from the contract.
   */
  router.post("/submit", async (req: Request, res: Response) => {
    try {
      const {
        sender,
        protocolVersion,
        applicationId,
        requestType,
        payload,
        tokenAddress,
        assetAmount,
        deadline,
        requestSignature,
        depositPermit,
      } = req.body;

      // Validate required fields
      if (!sender || protocolVersion === undefined || applicationId === undefined ||
          requestType === undefined || !payload || !deadline || !requestSignature) {
        res.status(400).json({ error: "Missing required fields" });
        return;
      }

      // Validate request type
      if (requestType !== REQUEST_TYPE_PROCESS && requestType !== REQUEST_TYPE_ASSOCIATEKEY) {
        res.status(400).json({ error: "Unsupported request type. Only ASSOCIATEKEY (3) and PROCESS (1) are supported." });
        return;
      }

      const provider = new ethers.JsonRpcProvider(config.rpcUrl);
      const connectedSigner = signer.connect(provider);
      const endpoint = new ethers.Contract(
        config.contractAddress,
        PROCESSOR_ENDPOINT_ABI,
        connectedSigner
      );

      // Encode depositPermit: abi.encode(v, r, s) if provided and assetAmount > 0, else empty
      const assetAmountBig = BigInt(assetAmount ?? 0);
      let depositPermitEncoded: Uint8Array = new Uint8Array(0);

      if (assetAmountBig > 0n && depositPermit) {
        const { v, r, s } = depositPermit;
        depositPermitEncoded = ethers.getBytes(
          ethers.AbiCoder.defaultAbiCoder().encode(
            ["uint8", "bytes32", "bytes32"],
            [v, r, s]
          )
        );
      }

      const payloadBytes = ethers.getBytes(payload);
      const tokenAddr = tokenAddress ?? ethers.ZeroAddress;

      const applicationIdBig = BigInt(applicationId);

      const tx = await endpoint.submitRequestFor(
        sender,
        protocolVersion,
        applicationIdBig,
        requestType,
        payloadBytes,
        tokenAddr,
        assetAmountBig,
        BigInt(deadline),
        requestSignature,
        depositPermitEncoded,
        { value: config.maxFeeValue }
      );

      const receipt = await tx.wait();

      if (!receipt) {
        res.status(500).json({ error: "Transaction failed: no receipt" });
        return;
      }

      // Extract requestId from RequestSubmitted event
      let requestId: string | undefined;
      console.log(`POST /submit tx mined: ${receipt.hash} (${receipt.logs.length} logs)`);
      for (const log of receipt.logs) {
        try {
          const parsed = endpoint.interface.parseLog(log);
          if (parsed && parsed.name === "RequestSubmitted") {
            requestId = parsed.args.requestId as string;
            console.log(`POST /submit requestId=${requestId}`);
            break;
          }
        } catch {
          // not our event
        }
      }
      if (!requestId) {
        console.warn(`POST /submit: RequestSubmitted event not found in ${receipt.logs.length} logs`);
      }

      res.json({ requestId: requestId ?? null, txHash: receipt.hash });
    } catch (err) {
      console.error("POST /submit error:", err);
      res.status(500).json({
        error: "Submit failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return router;
}
