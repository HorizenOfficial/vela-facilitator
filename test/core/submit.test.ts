import { describe, it, expect, beforeAll, inject } from "vitest";
import { ethers } from "ethers";
import {
  REQUEST_TYPE_PROCESS,
  REQUEST_TYPE_ASSOCIATEKEY,
} from "../../packages/x402-private-vela-fixed/src/types.js";
import { createClient } from "../setup.js";


let fixtures: import("../setup.js").TestFixtures;

beforeAll(() => {
  fixtures = inject("testFixtures") as import("../setup.js").TestFixtures;
});

describe("POST /submit", () => {
  it("submits ASSOCIATEKEY with assetAmount=0", async () => {
    const client = createClient(fixtures.userAccounts[0].privateKey, fixtures);
    // ASSOCIATEKEY payload: raw P-521 public key bytes (133 bytes, unencrypted)
    const rawPayload = new Uint8Array(133).fill(0x04);

    const { status, body: res } = await client.submit({
      requestType: REQUEST_TYPE_ASSOCIATEKEY,
      payload: rawPayload,
      assetAmount: 0n,
    });

    expect(status).toBe(200);
    expect(res.txHash).toBeTruthy();
    expect(res.requestId).toBeTruthy();
  });

  it("submits PROCESS with assetAmount=0", async () => {
    const client = createClient(fixtures.userAccounts[0].privateKey, fixtures);
    const payload = await client.buildTransferPayload({
      to: fixtures.userAccounts[1].address,
      amount: "0",
      asset: ethers.ZeroAddress,
    });

    const { status, body: res } = await client.submit({
      requestType: REQUEST_TYPE_PROCESS,
      payload,
      assetAmount: 0n,
    });

    expect(status).toBe(200);
    expect(res.txHash).toBeTruthy();
  });

  it("submits PROCESS with assetAmount > 0 (ERC-20 deposit via permit)", async () => {
    const client = createClient(fixtures.userAccounts[1].privateKey, fixtures);
    const assetAmount = ethers.parseUnits("100", 18);

    const { status, body: res } = await client.submit({
      requestType: REQUEST_TYPE_PROCESS,
      payload: new Uint8Array(0),
      tokenAddress: fixtures.contracts.token.address,
      assetAmount,
    });

    expect(status).toBe(200);
    expect(res.txHash).toBeTruthy();
    expect(res.requestId).toBeTruthy();
  });

  it("rejects expired deadline", async () => {
    const client = createClient(fixtures.userAccounts[0].privateKey, fixtures);
    const payload = new Uint8Array(133).fill(0x04);
    const payloadHash = ethers.keccak256(payload);
    const expiredDeadline = BigInt(Math.floor(Date.now() / 1000) - 100);

    const { signature: requestSignature, authorization } =
      await client.signRequestAuthorization({
        requestType: REQUEST_TYPE_ASSOCIATEKEY,
        payloadHash,
        deadline: expiredDeadline,
      });

    const { status } = await client.post("/submit", {
      sender: client.address,
      protocolVersion: authorization.protocolVersion,
      applicationId: Number(authorization.applicationId),
      requestType: authorization.requestType,
      payload: ethers.hexlify(payload),
      tokenAddress: authorization.tokenAddress,
      assetAmount: "0",
      deadline: String(expiredDeadline),
      requestSignature,
      depositPermit: null,
    });

    expect(status).toBe(500);
  });

  it("rejects unsupported request type", async () => {
    const client = createClient(fixtures.userAccounts[0].privateKey, fixtures);

    const { status } = await client.post("/submit", {
      sender: fixtures.userAccounts[0].address,
      protocolVersion: 0,
      applicationId: 1,
      requestType: 0, // DEPLOYAPP — not supported
      payload: "0x1234",
      tokenAddress: ethers.ZeroAddress,
      assetAmount: "0",
      deadline: String(Math.floor(Date.now() / 1000) + 300),
      requestSignature: "0x" + "aa".repeat(65),
      depositPermit: null,
    });
    expect(status).toBe(400);
  });

  it("increments nonce after successful submit", async () => {
    const client = createClient(fixtures.userAccounts[2].privateKey, fixtures);

    const nonceBefore = await client.getFacilitatorNonce();

    const rawPayload = new Uint8Array(133).fill(0x04);
    const { status } = await client.submit({
      requestType: REQUEST_TYPE_ASSOCIATEKEY,
      payload: rawPayload,
      assetAmount: 0n,
    });
    expect(status).toBe(200);

    const nonceAfter = await client.getFacilitatorNonce();
    expect(nonceAfter).toBe(nonceBefore + 1n);
  });

  it("on-chain request has correct sender and facilitator", async () => {
    const client = createClient(fixtures.userAccounts[0].privateKey, fixtures);
    const rawPayload = new Uint8Array(133).fill(0x04);

    const { status, body: res } = await client.submit({
      requestType: REQUEST_TYPE_ASSOCIATEKEY,
      payload: rawPayload,
      assetAmount: 0n,
    });
    expect(status).toBe(200);

    const provider = new ethers.JsonRpcProvider(fixtures.rpcUrl);
    const endpoint = new ethers.Contract(
      fixtures.contracts.processorEndpoint.address,
      [
        "function requestById(bytes32) view returns (uint256, address, uint256, uint256, bytes32, bytes, address, address, uint64, uint8, uint8)",
      ],
      provider
    );

    const request = await endpoint.requestById(res.requestId);
    // sender is at index 6, facilitator is at index 7
    expect(request[6].toLowerCase()).toBe(client.address.toLowerCase());
    expect(request[7].toLowerCase()).toBe(fixtures.facilitatorAccount.address.toLowerCase());
  });
});
