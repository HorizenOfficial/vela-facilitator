import { describe, it, expect, beforeAll, inject } from "vitest";
import { ethers } from "ethers";
import { generateKeyPair, exportPublicKeyToHex, hexToBytes } from "@horizen/vela-common-ts";
import {
  REQUEST_TYPE_ASSOCIATEKEY,
  REQUEST_TYPE_PROCESS,
} from "../../packages/x402-private-vela-fixed/src/types.js";
import { createTestUser } from "../helpers/signer.js";


let fixtures: import("../setup.js").TestFixtures;
let serverUrl: string;

beforeAll(() => {
  fixtures = inject("testFixtures") as import("../setup.js").TestFixtures;
  serverUrl = fixtures.serverUrl;
});

async function post(path: string, body: unknown) {
  const res = await fetch(`${serverUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value
    ),
  });
  return { status: res.status, body: await res.json() };
}

describe("Full E2E Flow", () => {
  describe("Core /submit flow (generic requests)", () => {
    it("1. ASSOCIATEKEY — registers a P-521 key (assetAmount=0, raw key payload)", async () => {
      const user = createTestUser(fixtures.userAccounts[0].privateKey, fixtures);

      // Generate a real P-521 key pair and use the raw uncompressed public key
      const keyPair = await generateKeyPair();
      const pubKeyHex = await exportPublicKeyToHex(keyPair.publicKey);
      const rawPayload = hexToBytes(pubKeyHex);

      const body = await user.buildSubmitPayload({
        requestType: REQUEST_TYPE_ASSOCIATEKEY,
        payload: rawPayload,
        assetAmount: 0n,
      });

      const { status, body: res } = await post("/submit", body);
      expect(status).toBe(200);
      expect(res.requestId).toBeTruthy();

      // Verify on-chain: PendingRequest has correct sender and facilitator
      const provider = new ethers.JsonRpcProvider(fixtures.rpcUrl);
      const endpoint = new ethers.Contract(
        fixtures.contracts.processorEndpoint.address,
        [
          "function requestById(bytes32) view returns (uint256, address, uint256, uint256, bytes32, bytes, address, address, uint64, uint8, uint8)",
        ],
        provider
      );
      const request = await endpoint.requestById(res.requestId);
      expect(request[6].toLowerCase()).toBe(user.address.toLowerCase()); // sender
      expect(request[7].toLowerCase()).toBe(fixtures.facilitatorAccount.address.toLowerCase()); // facilitator

      // Verify nonce incremented
      const nonceContract = new ethers.Contract(
        fixtures.contracts.processorEndpoint.address,
        ["function facilitatorNonces(address) view returns (uint256)"],
        provider
      );
      const nonce: bigint = await nonceContract.facilitatorNonces(user.address);
      expect(nonce).toBeGreaterThan(0n);
    });

    it("2. DEPOSIT — deposits ERC-20 tokens (two-signature flow, empty payload)", async () => {
      const user = createTestUser(fixtures.userAccounts[1].privateKey, fixtures);
      const assetAmount = ethers.parseUnits("25", 18);

      // Deposit uses an empty payload — the amount is in the request, not the payload
      const body = await user.buildSubmitPayload({
        requestType: REQUEST_TYPE_PROCESS,
        payload: new Uint8Array(0),
        tokenAddress: fixtures.contracts.token.address,
        assetAmount,
      });

      const { status, body: res } = await post("/submit", body);
      expect(status).toBe(200);
      expect(res.requestId).toBeTruthy();

      // Verify on-chain
      const provider = new ethers.JsonRpcProvider(fixtures.rpcUrl);
      const endpoint = new ethers.Contract(
        fixtures.contracts.processorEndpoint.address,
        [
          "function requestById(bytes32) view returns (uint256, address, uint256, uint256, bytes32, bytes, address, address, uint64, uint8, uint8)",
        ],
        provider
      );
      const request = await endpoint.requestById(res.requestId);

      expect(request[6].toLowerCase()).toBe(user.address.toLowerCase()); // sender
      expect(request[7].toLowerCase()).toBe(fixtures.facilitatorAccount.address.toLowerCase()); // facilitator
      expect(request[1].toLowerCase()).toBe(fixtures.contracts.token.address.toLowerCase()); // tokenAddress
      expect(request[2]).toBe(assetAmount); // assetAmount
    });
  });

  describe("x402 flow (verify + settle)", () => {
    it("3. TRANSFER — verifies and settles a payment via x402 endpoints", async () => {
      const user = createTestUser(fixtures.userAccounts[2].privateKey, fixtures);
      const requirements = {
        scheme: "private-vela-fixed",
        network: `eip155:${fixtures.chainId}`,
        asset: fixtures.contracts.token.address,
        amount: "0",
        payTo: fixtures.userAccounts[0].address,
        maxTimeoutSeconds: 60,
        extra: { invoiceId: "INV-E2E-001" },
      };

      const paymentPayload = await user.buildX402Payload({ requirements });

      // Verify
      const verifyRes = await post("/verify", {
        paymentPayload,
        paymentRequirements: requirements,
      });
      expect(verifyRes.status).toBe(200);
      expect(verifyRes.body.isValid).toBe(true);

      // Settle
      const settleRes = await post("/settle", {
        paymentPayload,
        paymentRequirements: requirements,
      });
      expect(settleRes.status).toBe(200);
      expect(settleRes.body.success).toBe(true);
      expect(settleRes.body.payer.toLowerCase()).toBe(user.address.toLowerCase());

      // Verify on-chain request was created
      const requestId = settleRes.body.extensions?.requestId;
      expect(requestId).toBeTruthy();

      const provider = new ethers.JsonRpcProvider(fixtures.rpcUrl);
      const endpoint = new ethers.Contract(
        fixtures.contracts.processorEndpoint.address,
        [
          "function requestById(bytes32) view returns (uint256, address, uint256, uint256, bytes32, bytes, address, address, uint64, uint8, uint8)",
        ],
        provider
      );
      const request = await endpoint.requestById(requestId);
      expect(request[6].toLowerCase()).toBe(user.address.toLowerCase()); // sender = buyer
      expect(request[7].toLowerCase()).toBe(fixtures.facilitatorAccount.address.toLowerCase()); // facilitator
    });
  });
});
