import { describe, it, expect, beforeAll, inject } from "vitest";
import { ethers } from "ethers";
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
    it("1. Submits ASSOCIATEKEY request (assetAmount=0, raw P-521 key payload)", async () => {
      const user = createTestUser(fixtures.userAccounts[0].privateKey, fixtures);

      // Raw 133-byte P-521 uncompressed public key (unencrypted for ASSOCIATEKEY)
      const rawPayload = new Uint8Array(133).fill(0x04);

      const body = await user.buildSubmitPayload({
        requestType: REQUEST_TYPE_ASSOCIATEKEY,
        payload: rawPayload,
        assetAmount: 0n,
      });

      const { status, body: res } = await post("/submit", body);
      expect(status).toBe(200);
      expect(res.requestId).toBeTruthy();

      // 2. Verify on-chain: PendingRequest has correct sender and facilitator
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

      // 3. Verify nonce incremented
      const nonceContract = new ethers.Contract(
        fixtures.contracts.processorEndpoint.address,
        ["function facilitatorNonces(address) view returns (uint256)"],
        provider
      );
      const nonce: bigint = await nonceContract.facilitatorNonces(user.address);
      expect(nonce).toBeGreaterThan(0n);
    });

    it("4. Submits PROCESS with assetAmount > 0 (two-signature flow + ERC-20 deposit)", async () => {
      const user = createTestUser(fixtures.userAccounts[1].privateKey, fixtures);
      const assetAmount = ethers.parseUnits("25", 18);

      const payload = await user.buildTransferPayload({
        to: fixtures.userAccounts[2].address,
        amount: "25",
        invoice_id: "E2E-TEST-001",
      });

      const body = await user.buildSubmitPayload({
        requestType: REQUEST_TYPE_PROCESS,
        payload,
        tokenAddress: fixtures.contracts.token.address,
        assetAmount,
      });

      const { status, body: res } = await post("/submit", body);
      expect(status).toBe(200);
      expect(res.requestId).toBeTruthy();

      // 5. Verify on-chain
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
    it("verifies and settles a payment via x402 endpoints", async () => {
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
