/**
 * Dev smoke script for the vela-facilitator.
 *
 * End-to-end flow against an already-running facilitator + vela dev stack:
 *   1. Generate fresh Ethereum wallets + P-521 keypairs for buyer and seller.
 *   2. Funder mints AMOUNT tokens directly to the buyer (MockERC20.mint).
 *   3. Buyer ASSOCIATEKEY + Seller ASSOCIATEKEY via POST /submit.
 *   4. Buyer deposits AMOUNT tokens via POST /submit (PROCESS + EIP-2612 permit).
 *   5. Buyer builds PaymentPayload; Seller calls /verify + /settle via the
 *      standard HTTPFacilitatorClient. The facilitator's /settle now blocks
 *      until the TEE emits the AppEvent whose eventSubType hash binds
 *      invoiceId + sender + token + amount + recipient — so a 200 response
 *      proves the transfer landed in the TEE exactly as specified.
 *   6. Seller withdraws AMOUNT via POST /submit (PROCESS with encrypted withdraw payload).
 *   7. Seller CLAIM: POST /claim to release the pending withdrawal into the seller's wallet.
 *   8. Verify the seller's on-chain ERC-20 balance grew by AMOUNT, and read the
 *      seller's encrypted events from the subgraph + decrypt them to confirm the
 *      final private balance is 0.
 *
 * Prerequisites (not performed here):
 *   - ProcessorEndpoint, TeeAuthenticator, and an EIP-2612-capable ERC-20 token
 *     deployed on the dev chain. The token must expose a public `mint(address, uint256)` and 
 *     must be allowlisted on the ProcessorEndpoint for the app.
 *     (all this are already managed if using the vela dev environment deployer)
 *   - nova app must be deployed into vela (APPLICATION_ID  must correspond to the application id deployed).
 *     Be sure to enalbe the TOKEN in nova by setting  the --allowed-tokens parameter in the nova deploy command
 *   - Funder account funded with ETH (pays gas for the mint tx).
 *   - Facilitator account funded with ETH for gas.
 *   - Subgraph is running and indexing the processor.
 *
 * Env vars (defaults match the vela dev stack, override as needed):
 *   FACILITATOR_URL              default: http://localhost:3000
 *   RPC_URL                      default: http://localhost:8545
 *   CHAIN_ID                     default: 31337
 *   PROCESSOR_ENDPOINT_ADDRESS   default: deterministic Anvil deploy address
 *   TEE_AUTHENTICATOR_ADDRESS    default: deterministic Anvil deploy address (TEE P-521 pubkey is read from it)
 *   TOKEN_ADDRESS                default: deterministic MockERC20 deploy address (must support EIP-2612 + public mint())
 *   FUNDER_PRIVATE_KEY           default: Anvil account #0 (deployer) — pays gas for the mint
 *   APPLICATION_ID               default: vela-nova app id
 *   SUBGRAPH_URL                 default: http://localhost:8000/subgraphs/name/hcce
 *   AMOUNT                     default: "100"  — deposit/transfer/withdraw amount (in wei)
 *
 * Run:
 *   pnpm dev:smoke
 */

import { ethers } from "ethers";
import {
  generateKeyPair,
  exportPublicKeyToHex,
  hexToBytes,
  bytesToString,
  importPublicKeyFromHex,
  VelaClient,
  createSubgraphClient,
  fetchAndDecryptUserEvents,
} from "@horizen/vela-common-ts";
import {
  FacilitatorHelper,
  REQUEST_TYPE_ASSOCIATEKEY,
  REQUEST_TYPE_PROCESS,
  registerPrivateVelaFixedClient,
} from "@horizen/x402-private-vela-fixed";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { x402Client } from "@x402/core/client";
import { HTTPFacilitatorClient } from "@x402/core/server";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function getEnv(name: string, def: string): string {
  return process.env[name] ?? def;
}

// Dev defaults: match the vela dev stack (Anvil + vela/dockerfiles/.env.dev)
const DEFAULTS = {
  FACILITATOR_URL: "http://localhost:3000",
  RPC_URL: "http://localhost:8545",
  CHAIN_ID: "31337",
  PROCESSOR_ENDPOINT_ADDRESS: "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9",
  TEE_AUTHENTICATOR_ADDRESS: "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0",
  // MockERC20 deployed by the vela deployer after the ProcessorEndpoint (deployer nonce=4)
  TOKEN_ADDRESS: "0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9",
  // Anvil account #0 — pays gas for the mint tx
  FUNDER_PRIVATE_KEY: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  APPLICATION_ID: "16491951060767813337",
  SUBGRAPH_URL: "http://localhost:8000/subgraphs/name/hcce",
  // Deposit/transfer/withdraw amount (in smallest token unit, i.e. wei)
  AMOUNT: "100",
};

const POLLING_INTERVAL_MS = 2_000;
const POLLING_TIMEOUT_MS = 60_000;

// ERC-20 ABI: mint() to fund the buyer, balanceOf() for assertions.
const ERC20_ABI = [
  "function mint(address to, uint256 amount)",
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Poll chain for the RequestCompleted event matching `requestId` via VelaClient.
 * Mirrors the vela-nova wallet's WaitForRequestCompleted pattern.
 */
async function waitForRequestCompleted(
  velaClient: VelaClient,
  requestId: string,
  label: string,
): Promise<void> {
  const deadline = Date.now() + POLLING_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLLING_INTERVAL_MS));
    const result = await velaClient.getRequestCompletedEvent(requestId, undefined, undefined);
    if (result) {
      if (result.status !== 0n) {
        throw new Error(
          `${label} request failed on-chain: status=${result.status} ` +
          `errorCode=${result.errorCode} errorMessage="${result.errorMessage}"`,
        );
      }
      return;
    }
  }
  throw new Error(
    `Polling timeout (${POLLING_TIMEOUT_MS / 1000}s) waiting for RequestCompleted for ${requestId}.`,
  );
}

/**
 * Register a user's P-521 public key via ASSOCIATEKEY through the facilitator.
 */
async function associateKey(
  client: FacilitatorHelper,
  velaClient: VelaClient,
  publicKey: CryptoKey,
  applicationId: bigint,
  label: string,
): Promise<void> {
  const pubKeyHex = await exportPublicKeyToHex(publicKey);
  const rawPayload = hexToBytes(pubKeyHex);
  const res = await client.submit({
    requestType: REQUEST_TYPE_ASSOCIATEKEY,
    payload: rawPayload,
    assetAmount: 0n,
    applicationId,
  });
  if (res.status !== 200) {
    throw new Error(`${label} ASSOCIATEKEY failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  const reqId = res.body.requestId as string;
  console.log(`      ${label}: requestId=${reqId}, waiting...`);
  await waitForRequestCompleted(velaClient, reqId, `${label} ASSOCIATEKEY`);
  console.log(`      ${label}: ASSOCIATEKEY completed.`);
}

function buildFacilitatorHelper(opts: {
  wallet: ethers.Wallet;
  provider: ethers.JsonRpcProvider;
  contractAddress: string;
  tokenAddress: string;
  chainId: number;
  teePublicKeyHex: string;
  facilitatorUrl: string;
  applicationId: bigint;
  p521PrivateKey: CryptoKey;
}): FacilitatorHelper {
  return new FacilitatorHelper({
    wallet: opts.wallet,
    provider: opts.provider,
    contractAddress: opts.contractAddress,
    tokenAddress: opts.tokenAddress,
    chainId: opts.chainId,
    teePublicKeyHex: opts.teePublicKeyHex,
    facilitatorUrl: opts.facilitatorUrl,
    applicationId: opts.applicationId,
    buyerP521PrivateKey: opts.p521PrivateKey,
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // --- env --------------------------------------------------------------
  const facilitatorUrl = getEnv("FACILITATOR_URL", DEFAULTS.FACILITATOR_URL);
  const rpcUrl = getEnv("RPC_URL", DEFAULTS.RPC_URL);
  const chainId = parseInt(getEnv("CHAIN_ID", DEFAULTS.CHAIN_ID), 10);
  const contractAddress = getEnv("PROCESSOR_ENDPOINT_ADDRESS", DEFAULTS.PROCESSOR_ENDPOINT_ADDRESS);
  const teeAuthenticatorAddress = getEnv("TEE_AUTHENTICATOR_ADDRESS", DEFAULTS.TEE_AUTHENTICATOR_ADDRESS);
  const tokenAddress = getEnv("TOKEN_ADDRESS", DEFAULTS.TOKEN_ADDRESS);
  const funderPrivateKey = getEnv("FUNDER_PRIVATE_KEY", DEFAULTS.FUNDER_PRIVATE_KEY);
  const applicationId = BigInt(getEnv("APPLICATION_ID", DEFAULTS.APPLICATION_ID));
  const subgraphUrl = getEnv("SUBGRAPH_URL", DEFAULTS.SUBGRAPH_URL);
  const amount = BigInt(getEnv("AMOUNT", DEFAULTS.AMOUNT));


  // --- infrastructure ---------------------------------------------------
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const funder = new ethers.Wallet(funderPrivateKey, provider);
  const funderVelaClient = new VelaClient(funder, false, teeAuthenticatorAddress, contractAddress);

  const tokenAsFunder = new ethers.Contract(tokenAddress, ERC20_ABI, funder);
  const tokenReader = new ethers.Contract(tokenAddress, ERC20_ABI, provider);

  // Read the TEE P-521 public key directly from the TeeAuthenticator contract
  const teeAuth = new ethers.Contract(
    teeAuthenticatorAddress,
    ["function getPubSecp521r1() view returns (bytes)"],
    provider,
  );
  const teePublicKeyHex: string = await teeAuth.getPubSecp521r1();
  const teePublicKey = await importPublicKeyFromHex(teePublicKeyHex);

  // --- participants -----------------------------------------------------
  // Fresh Ethereum wallets + P-521 keypairs (generated per-run)
  const buyerWallet = ethers.Wallet.createRandom().connect(provider);
  const sellerWallet = ethers.Wallet.createRandom().connect(provider);
  const buyerKeyPair = await generateKeyPair();
  const sellerKeyPair = await generateKeyPair();

  const buyerClient = buildFacilitatorHelper({
    wallet: buyerWallet, provider, contractAddress, tokenAddress, chainId,
    teePublicKeyHex, facilitatorUrl, applicationId,
    p521PrivateKey: buyerKeyPair.privateKey,
  });
  const sellerClient = buildFacilitatorHelper({
    wallet: sellerWallet, provider, contractAddress, tokenAddress, chainId,
    teePublicKeyHex, facilitatorUrl, applicationId,
    p521PrivateKey: sellerKeyPair.privateKey,
  });

  console.log(`\n=== dev-smoke ===`);
  console.log(`Facilitator: ${facilitatorUrl}`);
  console.log(`RPC:         ${rpcUrl} (chainId=${chainId})`);
  console.log(`Token:       ${tokenAddress}`);
  console.log(`Funder:      ${funder.address}`);
  console.log(`Buyer:       ${buyerWallet.address}`);
  console.log(`Seller:      ${sellerWallet.address}`);
  console.log(`AppId:       ${applicationId}`);
  console.log(`AMOUNT:    ${amount} (deposit/transfer/withdraw)`);

  // --- sanity: /supported ------------------------------------------------
  console.log(`\n[0] GET /supported`);
  const supported = await buyerClient.supported();
  if (supported.status !== 200) {
    throw new Error(`GET /supported failed: ${supported.status} ${JSON.stringify(supported.body)}`);
  }
  console.log(`    -> ${JSON.stringify(supported.body)}`);

  // --- step 1: mint AMOUNT tokens to the buyer ------------------------
  console.log(`\n[1] Funder mint -> Buyer (${amount} tokens)`);
  const mintTx = await tokenAsFunder.mint(buyerWallet.address, amount);
  await mintTx.wait();
  console.log(`    tx: ${mintTx.hash}`);

  const buyerBalInitial: bigint = await tokenReader.balanceOf(buyerWallet.address);
  const sellerBalInitial: bigint = await tokenReader.balanceOf(sellerWallet.address);
  console.log(`    buyer balance:  ${buyerBalInitial}`);
  console.log(`    seller balance: ${sellerBalInitial}`);

  // --- step 2: ASSOCIATEKEY for buyer & seller --------------------------
  console.log(`\n[2] ASSOCIATEKEY (buyer + seller)`);
  await associateKey(buyerClient, funderVelaClient, buyerKeyPair.publicKey, applicationId, "buyer");
  await associateKey(sellerClient, funderVelaClient, sellerKeyPair.publicKey, applicationId, "seller");

  // --- step 3: Buyer deposits AMOUNT ----------------------------------
  console.log(`\n[3] Buyer DEPOSIT ${amount} tokens`);
  const depositRes = await buyerClient.submit({
    requestType: REQUEST_TYPE_PROCESS,
    payload: new Uint8Array(0), // deposit has an empty payload
    tokenAddress,
    assetAmount: amount,
    applicationId,
  });
  if (depositRes.status !== 200) {
    throw new Error(`Deposit /submit failed: ${depositRes.status} ${JSON.stringify(depositRes.body)}`);
  }
  const depositReqId = depositRes.body.requestId as string;
  console.log(`    requestId=${depositReqId}, waiting...`);
  await waitForRequestCompleted(funderVelaClient, depositReqId, "DEPOSIT");
  console.log(`    deposit completed.`);

  // --- step 4: x402 transfer Buyer -> Seller ----------------------------
  // Buyer uses the standard x402Client.createPaymentPayload() with our
  // registered scheme — no custom wrapper. The seller uses its own
  // HTTPFacilitatorClient, wrapped by VerifyingFacilitatorClient so that
  // settle() only returns success=true once the TEE has processed the request
  // AND the decrypted transfer_received event matches the PaymentRequirements.
  console.log(`\n[4] x402 TRANSFER Buyer -> Seller (${amount} tokens)`);
  const network = `eip155:${chainId}` as `${string}:${string}`;
  const requirements: PaymentRequirements = {
    scheme: "private-vela-fixed",
    network,
    asset: tokenAddress,
    amount: amount.toString(),
    payTo: sellerWallet.address,
    maxTimeoutSeconds: 60,
    extra: { invoiceId: `INV-SMOKE-${Date.now()}` },
  };

  // Buyer-side: standard x402Client + registered scheme. skipOnchainDeposit=true
  // because the buyer already deposited in step [3] — this is a pure private-state
  // transfer (assetAmount=0 on-chain, no permit).
  const buyerX402 = new x402Client();
  registerPrivateVelaFixedClient(buyerX402, {
    signer: buyerWallet,
    p521PrivateKey: buyerKeyPair.privateKey,
    teePublicKey,
    rpcUrl,
    contractAddress,
    applicationId,
    network,
    skipOnchainDeposit: true,
  });
  // In a real flow, `paymentRequired` comes from the seller's 402 response.
  const paymentRequired: PaymentRequired = {
    x402Version: 2,
    resource: { url: "x402://dev-smoke" },
    accepts: [requirements],
  };
  const payment = await buyerX402.createPaymentPayload(paymentRequired);

  // Seller-side: plain HTTPFacilitatorClient is enough now — the facilitator's
  // /settle blocks until the TEE AppEvent arrives with the expected hash.
  const sellerFacilitator = new HTTPFacilitatorClient({ url: facilitatorUrl });

  const verifyResult = await sellerFacilitator.verify(payment, requirements);
  if (!verifyResult.isValid) {
    throw new Error(
      `/verify failed: ${verifyResult.invalidReason} ${verifyResult.invalidMessage}`,
    );
  }
  console.log(`    /verify -> isValid=true`);

  const settleResult = await sellerFacilitator.settle(payment, requirements);
  if (!settleResult.success) {
    throw new Error(
      `/settle failed: ${settleResult.errorReason} ${settleResult.errorMessage}`,
    );
  }
  const settleExt = settleResult.extensions as Record<string, unknown> | undefined;
  console.log(`    /settle + TEE confirmation OK.`);
  console.log(`      requestId=${settleExt?.requestId} eventSubType=${settleExt?.eventSubType}`);

  // --- step 5: Seller withdraws AMOUNT --------------------------------
  console.log(`\n[5] Seller WITHDRAW ${amount} tokens`);
  const withdrawPayload = await sellerClient.buildWithdrawPayload({
    to: sellerWallet.address,
    amount: amount.toString(),
    tokenAddress,
  });
  const withdrawRes = await sellerClient.submit({
    requestType: REQUEST_TYPE_PROCESS,
    payload: withdrawPayload,
    assetAmount: 0n,
    applicationId,
  });
  if (withdrawRes.status !== 200) {
    throw new Error(`Withdraw /submit failed: ${withdrawRes.status} ${JSON.stringify(withdrawRes.body)}`);
  }
  const withdrawReqId = withdrawRes.body.requestId as string;
  console.log(`    requestId=${withdrawReqId}, waiting...`);
  await waitForRequestCompleted(funderVelaClient, withdrawReqId, "WITHDRAW");
  console.log(`    withdraw completed.`);

  // --- step 6: Seller CLAIM pending balance ----------------------------
  // The withdraw puts tokens in `pendingClaims[token][seller]` on-chain; the seller must
  // call claim() to move them into its wallet. Anyone can trigger it (funds always go to
  // the seller), so we use the facilitator's permissionless /claim endpoint.
  console.log(`\n[6] Seller CLAIM pending balance`);
  const claimRes = await sellerClient.claim({ tokenAddress, payee: sellerWallet.address });
  if (claimRes.status !== 200) {
    throw new Error(`/claim failed: ${claimRes.status} ${JSON.stringify(claimRes.body)}`);
  }
  console.log(claimRes);
  const claimedAmount = claimRes.body.amount as string;
  console.log(`    /claim -> tx=${claimRes.body.txHash} amount=${claimedAmount}`);
  if (BigInt(claimedAmount) !== amount) {
    throw new Error(
      `Claim amount mismatch: expected ${amount}, got ${claimedAmount}`,
    );
  }

  // --- step 7: verify seller's on-chain balance ------------------------
  console.log(`\n[7] Verify seller balance`);
  const sellerBalFinal: bigint = await tokenReader.balanceOf(sellerWallet.address);
  console.log(`    seller on-chain balance: ${sellerBalInitial} -> ${sellerBalFinal}`);
  if (sellerBalFinal !== sellerBalInitial + amount) {
    throw new Error(
      `Seller balance mismatch: expected ${sellerBalInitial + amount}, got ${sellerBalFinal}`,
    );
  }
  console.log(`    seller balance increased by AMOUNT (${amount}) as expected.`);

  // Decrypt seller's private events via subgraph to confirm private-state changes.
  // eventSubType is declared `string indexed` in the ProcessorEndpoint contract, so the
  // topic (and subgraph `Bytes` field) is keccak256(utf8Bytes(name)), not the name itself.
  console.log(`\n[8] Decrypt seller's events via subgraph`);
  const subgraph = createSubgraphClient(subgraphUrl);
  const subtypeHashes = ["transfer_received", "withdrawal"].map((n) =>
    ethers.keccak256(ethers.toUtf8Bytes(n)),
  );
  const sellerDecrypted = await fetchAndDecryptUserEvents(
    subgraph,
    teePublicKey,
    sellerKeyPair.privateKey,
    applicationId,
    subtypeHashes,
    0,
  );
  const sellerEvents = sellerDecrypted.map((b) => JSON.parse(bytesToString(b)));
  console.log(`    decrypted ${sellerEvents.length} events for seller:`);
  for (const ev of sellerEvents) {
    console.log(`      ${JSON.stringify(ev)}`);
  }
  const withdrawalEv = sellerEvents.find((e) => e.type === "withdrawal");
  if (!withdrawalEv) {
    throw new Error(`Seller has no decrypted withdrawal event`);
  }
  if (BigInt(withdrawalEv.balance) !== 0n) {
    throw new Error(
      `Seller private balance after withdraw should be 0, got ${withdrawalEv.balance}`,
    );
  }
  console.log(`    seller private balance after withdraw: 0 (all withdrawn).`);

  console.log(`\nAll steps OK.\n`);
}

main().catch((err) => {
  console.error("\nSmoke failed:", err);
  process.exit(1);
});
