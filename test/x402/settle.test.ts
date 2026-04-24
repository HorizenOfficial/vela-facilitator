import { describe, it, expect, beforeAll, inject } from "vitest";
import { ethers } from "ethers";
import { computeTransferReceiptHash } from "@horizen/x402-private-vela-fixed";
import { createClient, buildBuyerPaymentPayload } from "../setup.js";

import type { PaymentRequirements } from "@x402/core/types";

type TestFixtures = import("../setup.js").TestFixtures;

let fixtures: TestFixtures;

beforeAll(() => {
  fixtures = inject("testFixtures") as TestFixtures;
});

const MOCK_TEE_ABI = [
  "function setNextAppEvent(bytes32 eventSubType, bytes data)",
  "function emitAppEvent(uint64 applicationId, bytes32 requestId, bytes32 eventSubType, bytes data)",
];

function makeRequirements(fixtures: TestFixtures, amount = "0", invoiceId = "SETTLE-TEST-001"): PaymentRequirements {
  return {
    scheme: "private-vela-fixed",
    network: `eip155:${fixtures.chainId}`,
    asset: fixtures.contracts.token.address,
    amount,
    payTo: fixtures.userAccounts[1].address,
    maxTimeoutSeconds: 60,
    extra: { invoiceId },
  };
}

/**
 * Arms the mock to emit AppEvent on the *next* submitRequestFor, with the exact
 * eventSubType hash vela-nova would compute for this transfer. Uses the deployer
 * signer so the mock write itself doesn't consume the facilitator's nonce.
 */
async function armMockAppEvent(
  fixtures: TestFixtures,
  sender: string,
  requirements: PaymentRequirements,
): Promise<string> {
  const expected = computeTransferReceiptHash({
    invoiceId: (requirements.extra as { invoiceId: string }).invoiceId,
    sender,
    tokenAddress: requirements.asset,
    amount: BigInt(requirements.amount),
    recipient: requirements.payTo,
  });

  const provider = new ethers.JsonRpcProvider(fixtures.rpcUrl);
  // Account 0 is the deployer / mock owner (see test/setup.ts).
  const admin = new ethers.Wallet(
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    provider,
  );
  const mock = new ethers.Contract(fixtures.contracts.processorEndpoint.address, MOCK_TEE_ABI, admin);
  const tx = await mock.setNextAppEvent(expected, "0x");
  await tx.wait();
  return expected;
}

describe("POST /settle", () => {
  it("settles a valid payment and waits for TEE AppEvent", async () => {
    const client = createClient(fixtures.userAccounts[0].privateKey, fixtures);
    const requirements = makeRequirements(fixtures);
    const paymentPayload = await buildBuyerPaymentPayload(
      fixtures.userAccounts[0].privateKey,
      requirements,
      fixtures,
    );

    const expectedHash = await armMockAppEvent(fixtures, client.address, requirements);

    const { status, body } = await client.settle(paymentPayload, requirements);

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.transaction).toBeTruthy();
    expect((body.payer as string).toLowerCase()).toBe(client.address.toLowerCase());

    const ext = body.extensions as Record<string, string>;
    expect(ext?.requestId).toBeTruthy();
    expect(ext?.eventSubType).toBe(expectedHash);
  });

  it("settles with assetAmount > 0 (ERC-20 deposit) once AppEvent is emitted", async () => {
    const client = createClient(fixtures.userAccounts[1].privateKey, fixtures);
    const assetAmount = ethers.parseUnits("50", 18).toString();
    const requirements = makeRequirements(fixtures, assetAmount, "SETTLE-TEST-ERC20");
    const paymentPayload = await buildBuyerPaymentPayload(
      fixtures.userAccounts[1].privateKey,
      requirements,
      fixtures,
    );

    await armMockAppEvent(fixtures, client.address, requirements);

    const { status, body } = await client.settle(paymentPayload, requirements);

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.transaction).toBeTruthy();
  });

  it("times out with tee_processing_timeout when no AppEvent is emitted", async () => {
    const client = createClient(fixtures.userAccounts[2].privateKey, fixtures);
    const requirements = makeRequirements(fixtures, "0", "SETTLE-TEST-TIMEOUT");
    const paymentPayload = await buildBuyerPaymentPayload(
      fixtures.userAccounts[2].privateKey,
      requirements,
      fixtures,
    );

    // Do NOT arm the mock — settle should timeout waiting for AppEvent.
    const { body } = await client.settle(paymentPayload, requirements);

    expect(body.success).toBe(false);
    expect(body.errorReason).toBe("tee_processing_timeout");
    // The request was submitted on-chain before the timeout — requestId must be
    // reported so the caller can still correlate the tx.
    expect((body.extensions as Record<string, string>)?.requestId).toBeTruthy();
  });

  it("fails to settle with invalid signature (before touching the chain)", async () => {
    const client = createClient(fixtures.userAccounts[0].privateKey, fixtures);
    const requirements = makeRequirements(fixtures, "0", "SETTLE-TEST-BADSIG");
    const paymentPayload = await buildBuyerPaymentPayload(
      fixtures.userAccounts[0].privateKey,
      requirements,
      fixtures,
    );

    (paymentPayload.payload as Record<string, unknown>).requestSignature =
      "0x" + "bb".repeat(65);

    const { body } = await client.settle(paymentPayload, requirements);

    expect(body.success).toBe(false);
    expect(body.errorReason).toBeTruthy();
    expect(body.errorReason).not.toBe("tee_processing_timeout");
  });
});
