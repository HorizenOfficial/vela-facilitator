import { describe, it, expect, beforeAll, inject } from "vitest";
import { ethers } from "ethers";
import { createTestUser } from "../helpers/signer.js";

import type { PaymentRequirements } from "@x402/core/types";

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

function makeRequirements(fixtures: TestFixtures, amount = "0"): PaymentRequirements {
  return {
    scheme: "private-vela-fixed",
    network: `eip155:${fixtures.chainId}`,
    asset: fixtures.contracts.token.address,
    amount,
    payTo: fixtures.userAccounts[1].address,
    maxTimeoutSeconds: 60,
    extra: { invoiceId: "TEST-001" },
  };
}

describe("POST /verify", () => {
  it("returns isValid=true for valid payload", async () => {
    const user = createTestUser(fixtures.userAccounts[0].privateKey, fixtures);
    const requirements = makeRequirements(fixtures);
    const paymentPayload = await user.buildX402Payload({ requirements });

    const { status, body } = await post("/verify", {
      paymentPayload,
      paymentRequirements: requirements,
    });

    expect(status).toBe(200);
    expect(body.isValid).toBe(true);
    expect(body.payer.toLowerCase()).toBe(user.address.toLowerCase());
  });

  it("returns isValid=false for invalid signature", async () => {
    const user = createTestUser(fixtures.userAccounts[0].privateKey, fixtures);
    const requirements = makeRequirements(fixtures);
    const paymentPayload = await user.buildX402Payload({ requirements });

    // Corrupt the request signature
    (paymentPayload.payload as Record<string, unknown>).requestSignature =
      "0x" + "aa".repeat(65);

    const { body } = await post("/verify", {
      paymentPayload,
      paymentRequirements: requirements,
    });

    expect(body.isValid).toBe(false);
    expect(body.invalidReason).toBeTruthy();
  });

  it("returns isValid=false for expired deadline", async () => {
    const user = createTestUser(fixtures.userAccounts[0].privateKey, fixtures);
    const requirements = makeRequirements(fixtures);

    // Build with an expired deadline
    const expiredDeadline = BigInt(Math.floor(Date.now() / 1000) - 100);
    const payload = await user.buildTransferPayload({
      to: requirements.payTo,
      amount: requirements.amount,
      asset: ethers.ZeroAddress,
    });
    const payloadHex = ethers.hexlify(payload);
    const payloadHash = ethers.keccak256(payload);

    const { signature: requestSignature, authorization } =
      await user.signRequestAuthorization({
        requestType: 1, // PROCESS
        payloadHash,
        deadline: expiredDeadline,
      });

    const paymentPayload = {
      x402Version: 2,
      accepted: requirements,
      payload: {
        sender: user.address,
        requestSignature,
        depositPermit: null,
        requestAuthorization: {
          ...authorization,
          deadline: expiredDeadline,
        },
        payload: payloadHex,
      },
    };

    const { body } = await post("/verify", {
      paymentPayload,
      paymentRequirements: requirements,
    });

    expect(body.isValid).toBe(false);
    expect(body.invalidReason).toContain("deadline");
  });

  it("returns isValid=false for wrong nonce", async () => {
    const user = createTestUser(fixtures.userAccounts[0].privateKey, fixtures);
    const requirements = makeRequirements(fixtures);

    const payload = await user.buildTransferPayload({
      to: requirements.payTo,
      amount: requirements.amount,
      asset: ethers.ZeroAddress,
    });
    const payloadHex = ethers.hexlify(payload);
    const payloadHash = ethers.keccak256(payload);

    // Use an incorrect nonce (999)
    const { signature: requestSignature, authorization } =
      await user.signRequestAuthorization({
        requestType: 1,
        payloadHash,
        nonce: 999n,
      });

    const paymentPayload = {
      x402Version: 2,
      accepted: requirements,
      payload: {
        sender: user.address,
        requestSignature,
        depositPermit: null,
        requestAuthorization: authorization,
        payload: payloadHex,
      },
    };

    const { body } = await post("/verify", {
      paymentPayload,
      paymentRequirements: requirements,
    });

    expect(body.isValid).toBe(false);
    expect(body.invalidReason).toContain("nonce");
  });
});

describe("GET /supported", () => {
  it("returns the private-vela-fixed scheme", async () => {
    const res = await fetch(`${serverUrl}/supported`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.kinds).toBeTruthy();
    const velaKind = body.kinds.find((k: Record<string, string>) => k.scheme === "private-vela-fixed");
    expect(velaKind).toBeTruthy();
    expect(velaKind.network).toBe(`eip155:${fixtures.chainId}`);
  });
});
