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
    extra: { invoiceId: "SETTLE-TEST-001" },
  };
}

describe("POST /settle", () => {
  it("settles a valid payment and creates on-chain request", async () => {
    const client = createClient(fixtures.userAccounts[0].privateKey, fixtures);
    const requirements = makeRequirements(fixtures);
    const paymentPayload = await client.buildX402Payload({ requirements });

    const { status, body } = await client.settle(paymentPayload, requirements);

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.transaction).toBeTruthy();
    expect((body.payer as string).toLowerCase()).toBe(client.address.toLowerCase());

    // Verify on-chain: check requestId was created
    expect((body.extensions as Record<string, string>)?.requestId).toBeTruthy();
  });

  it("settles with assetAmount > 0 (ERC-20 deposit)", async () => {
    const client = createClient(fixtures.userAccounts[1].privateKey, fixtures);
    const assetAmount = ethers.parseUnits("50", 18).toString();
    const requirements = makeRequirements(fixtures, assetAmount);
    const paymentPayload = await client.buildX402Payload({ requirements });

    const { status, body } = await client.settle(paymentPayload, requirements);

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.transaction).toBeTruthy();
  });

  it("fails to settle with invalid signature", async () => {
    const client = createClient(fixtures.userAccounts[0].privateKey, fixtures);
    const requirements = makeRequirements(fixtures);
    const paymentPayload = await client.buildX402Payload({ requirements });

    // Corrupt signature
    (paymentPayload.payload as Record<string, unknown>).requestSignature =
      "0x" + "bb".repeat(65);

    const { body } = await client.settle(paymentPayload, requirements);

    expect(body.success).toBe(false);
    expect(body.errorReason).toBeTruthy();
  });
});
