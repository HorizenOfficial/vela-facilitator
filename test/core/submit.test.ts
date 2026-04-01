import { describe, it, expect, beforeAll, inject } from "vitest";
import { ethers } from "ethers";
import {
  REQUEST_TYPE_PROCESS,
  REQUEST_TYPE_ASSOCIATEKEY,
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
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

describe("POST /submit", () => {
  it("submits ASSOCIATEKEY with assetAmount=0", async () => {
    const user = createTestUser(fixtures.userAccounts[0].privateKey, fixtures);
    // ASSOCIATEKEY payload: raw P-521 public key bytes (133 bytes, unencrypted)
    const rawPayload = new Uint8Array(133).fill(0x04);

    const body = await user.buildSubmitPayload({
      requestType: REQUEST_TYPE_ASSOCIATEKEY,
      payload: rawPayload,
      assetAmount: 0n,
    });

    const { status, body: res } = await post("/submit", body);
    expect(status).toBe(200);
    expect(res.txHash).toBeTruthy();
    expect(res.requestId).toBeTruthy();
  });

  it("submits PROCESS with assetAmount=0", async () => {
    const user = createTestUser(fixtures.userAccounts[0].privateKey, fixtures);
    const payload = await user.buildTransferPayload({
      to: fixtures.userAccounts[1].address,
      amount: "0",
    });

    const body = await user.buildSubmitPayload({
      requestType: REQUEST_TYPE_PROCESS,
      payload,
      assetAmount: 0n,
    });

    const { status, body: res } = await post("/submit", body);
    expect(status).toBe(200);
    expect(res.txHash).toBeTruthy();
  });

  it("submits PROCESS with assetAmount > 0 (ERC-20 deposit via permit)", async () => {
    const user = createTestUser(fixtures.userAccounts[1].privateKey, fixtures);
    const assetAmount = ethers.parseUnits("100", 18);

    const payload = await user.buildTransferPayload({
      to: fixtures.userAccounts[2].address,
      amount: "100",
    });

    const body = await user.buildSubmitPayload({
      requestType: REQUEST_TYPE_PROCESS,
      payload,
      tokenAddress: fixtures.contracts.token.address,
      assetAmount,
    });

    const { status, body: res } = await post("/submit", body);
    expect(status).toBe(200);
    expect(res.txHash).toBeTruthy();
    expect(res.requestId).toBeTruthy();
  });

  it("rejects expired deadline", async () => {
    const user = createTestUser(fixtures.userAccounts[0].privateKey, fixtures);
    const payload = new Uint8Array(133).fill(0x04);
    const payloadHash = ethers.keccak256(payload);
    const expiredDeadline = BigInt(Math.floor(Date.now() / 1000) - 100);

    const { signature: requestSignature, authorization } =
      await user.signRequestAuthorization({
        requestType: REQUEST_TYPE_ASSOCIATEKEY,
        payloadHash,
        deadline: expiredDeadline,
      });

    const { status } = await post("/submit", {
      sender: user.address,
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
    const { status } = await post("/submit", {
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
    const user = createTestUser(fixtures.userAccounts[2].privateKey, fixtures);
    const provider = new ethers.JsonRpcProvider(fixtures.rpcUrl);

    const endpoint = new ethers.Contract(
      fixtures.contracts.processorEndpoint.address,
      ["function facilitatorNonces(address) view returns (uint256)"],
      provider
    );

    const nonceBefore: bigint = await endpoint.facilitatorNonces(user.address);

    const rawPayload = new Uint8Array(133).fill(0x04);
    const body = await user.buildSubmitPayload({
      requestType: REQUEST_TYPE_ASSOCIATEKEY,
      payload: rawPayload,
      assetAmount: 0n,
    });

    const { status } = await post("/submit", body);
    expect(status).toBe(200);

    const nonceAfter: bigint = await endpoint.facilitatorNonces(user.address);
    expect(nonceAfter).toBe(nonceBefore + 1n);
  });

  it("on-chain request has correct sender and facilitator", async () => {
    const user = createTestUser(fixtures.userAccounts[0].privateKey, fixtures);
    const rawPayload = new Uint8Array(133).fill(0x04);

    const body = await user.buildSubmitPayload({
      requestType: REQUEST_TYPE_ASSOCIATEKEY,
      payload: rawPayload,
      assetAmount: 0n,
    });

    const { status, body: res } = await post("/submit", body);
    expect(status).toBe(200);

    const provider = new ethers.JsonRpcProvider(fixtures.rpcUrl);
    const endpoint = new ethers.Contract(
      fixtures.contracts.processorEndpoint.address,
      [
        "function requestById(bytes32) view returns (uint256, uint256, uint256, bytes32, bytes, address, address, address, uint256, uint64, uint8, uint8)",
      ],
      provider
    );

    const request = await endpoint.requestById(res.requestId);
    // sender is at index 5, facilitator is at index 6
    expect(request[5].toLowerCase()).toBe(user.address.toLowerCase());
    expect(request[6].toLowerCase()).toBe(fixtures.facilitatorAccount.address.toLowerCase());
  });
});
