import { describe, it, expect, beforeAll, inject } from "vitest";
import { ethers } from "ethers";
import { createClient } from "../helpers/client.js";

import type { PaymentRequirements } from "@x402/core/types";

type TestFixtures = import("../setup.js").TestFixtures;

let fixtures: TestFixtures;

beforeAll(() => {
  fixtures = inject("testFixtures") as TestFixtures;
});

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
    const client = createClient(fixtures.userAccounts[0].privateKey, fixtures);
    const requirements = makeRequirements(fixtures);
    const paymentPayload = await client.buildX402Payload({ requirements });

    const { status, body } = await client.verify(paymentPayload, requirements);

    expect(status).toBe(200);
    expect(body.isValid).toBe(true);
    expect((body.payer as string).toLowerCase()).toBe(client.address.toLowerCase());
  });

  it("returns isValid=false for invalid signature", async () => {
    const client = createClient(fixtures.userAccounts[0].privateKey, fixtures);
    const requirements = makeRequirements(fixtures);
    const paymentPayload = await client.buildX402Payload({ requirements });

    // Corrupt the request signature
    (paymentPayload.payload as Record<string, unknown>).requestSignature =
      "0x" + "aa".repeat(65);

    const { body } = await client.verify(paymentPayload, requirements);

    expect(body.isValid).toBe(false);
    expect(body.invalidReason).toBeTruthy();
  });

  it("returns isValid=false for expired deadline", async () => {
    const client = createClient(fixtures.userAccounts[0].privateKey, fixtures);
    const requirements = makeRequirements(fixtures);

    // Build with an expired deadline
    const expiredDeadline = BigInt(Math.floor(Date.now() / 1000) - 100);
    const payload = await client.buildTransferPayload({
      to: requirements.payTo,
      amount: requirements.amount,
      asset: ethers.ZeroAddress,
    });
    const payloadHex = ethers.hexlify(payload);
    const payloadHash = ethers.keccak256(payload);

    const { signature: requestSignature, authorization } =
      await client.signRequestAuthorization({
        requestType: 1, // PROCESS
        payloadHash,
        deadline: expiredDeadline,
      });

    const paymentPayload = {
      x402Version: 2,
      accepted: requirements,
      payload: {
        sender: client.address,
        requestSignature,
        depositPermit: null,
        requestAuthorization: {
          ...authorization,
          deadline: expiredDeadline,
        },
        payload: payloadHex,
      },
    };

    const { body } = await client.post("/verify", {
      paymentPayload,
      paymentRequirements: requirements,
    });

    expect(body.isValid).toBe(false);
    expect((body.invalidReason as string)).toContain("deadline");
  });

  it("returns isValid=false for wrong nonce", async () => {
    const client = createClient(fixtures.userAccounts[0].privateKey, fixtures);
    const requirements = makeRequirements(fixtures);

    const payload = await client.buildTransferPayload({
      to: requirements.payTo,
      amount: requirements.amount,
      asset: ethers.ZeroAddress,
    });
    const payloadHex = ethers.hexlify(payload);
    const payloadHash = ethers.keccak256(payload);

    // Use an incorrect nonce (999)
    const { signature: requestSignature, authorization } =
      await client.signRequestAuthorization({
        requestType: 1,
        payloadHash,
        nonce: 999n,
      });

    const paymentPayload = {
      x402Version: 2,
      accepted: requirements,
      payload: {
        sender: client.address,
        requestSignature,
        depositPermit: null,
        requestAuthorization: authorization,
        payload: payloadHex,
      },
    };

    const { body } = await client.post("/verify", {
      paymentPayload,
      paymentRequirements: requirements,
    });

    expect(body.isValid).toBe(false);
    expect((body.invalidReason as string)).toContain("nonce");
  });
});

describe("GET /supported", () => {
  it("returns the private-vela-fixed scheme", async () => {
    const client = createClient(fixtures.userAccounts[0].privateKey, fixtures);
    const { status, body } = await client.supported();

    expect(status).toBe(200);
    expect(body.kinds).toBeTruthy();
    const kinds = body.kinds as Array<Record<string, string>>;
    const velaKind = kinds.find((k) => k.scheme === "private-vela-fixed");
    expect(velaKind).toBeTruthy();
    expect(velaKind!.network).toBe(`eip155:${fixtures.chainId}`);
  });
});
