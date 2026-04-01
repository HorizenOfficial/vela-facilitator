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
    extra: { invoiceId: "SETTLE-TEST-001" },
  };
}

describe("POST /settle", () => {
  it("settles a valid payment and creates on-chain request", async () => {
    const user = createTestUser(fixtures.userAccounts[0].privateKey, fixtures);
    const requirements = makeRequirements(fixtures);
    const paymentPayload = await user.buildX402Payload({ requirements });

    const { status, body } = await post("/settle", {
      paymentPayload,
      paymentRequirements: requirements,
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.transaction).toBeTruthy();
    expect(body.payer.toLowerCase()).toBe(user.address.toLowerCase());

    // Verify on-chain: check requestId was created
    expect(body.extensions?.requestId).toBeTruthy();
  });

  it("settles with assetAmount > 0 (ERC-20 deposit)", async () => {
    const user = createTestUser(fixtures.userAccounts[1].privateKey, fixtures);
    const assetAmount = ethers.parseUnits("50", 18).toString();
    const requirements = makeRequirements(fixtures, assetAmount);
    const paymentPayload = await user.buildX402Payload({ requirements });

    const { status, body } = await post("/settle", {
      paymentPayload,
      paymentRequirements: requirements,
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.transaction).toBeTruthy();
  });

  it("fails to settle with invalid signature", async () => {
    const user = createTestUser(fixtures.userAccounts[0].privateKey, fixtures);
    const requirements = makeRequirements(fixtures);
    const paymentPayload = await user.buildX402Payload({ requirements });

    // Corrupt signature
    (paymentPayload.payload as Record<string, unknown>).requestSignature =
      "0x" + "bb".repeat(65);

    const { body } = await post("/settle", {
      paymentPayload,
      paymentRequirements: requirements,
    });

    expect(body.success).toBe(false);
    expect(body.errorReason).toBeTruthy();
  });
});
