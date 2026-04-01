# vela-facilitator — Architecture

## Overview

The vela-facilitator is a platform-level TypeScript service that submits Vela blockchain requests on behalf of users who don't hold ETH (gasless submission). Defined in [FACILITATOR.md](https://github.com/HorizenOfficial/vela/blob/main/docs/design/FACILITATOR.md) section 5.3, it has two layers:

1. **Core facilitation** — POST /submit (generic, non-x402). Can submit requests to **any application** on the Vela chain. 
2. **x402 scheme** — POST /verify, POST /settle, GET /supported (standard Coinbase x402 protocol). Specifically targets the x402 payment standard by defining a custom payment scheme and endpoints compatible with the standrd. This part assumes a specific Vela app is used for the transfers [**vela-nova private transfer app**](https://github.com/HorizenOfficial/vela-nova).

The design uses EIP-2612 (`permit`) for deposit authorization and EIP-712 for request authorization. 
Only `ASSOCIATEKEY` and `PROCESS` request types are supported.

## vela-nova App Integration (x402 scheme)

The `private-vela-fixed` x402 scheme is designed around the [vela-nova app](https://github.com/HorizenOfficial/vela-nova). 
For reference: a description of the vela-nova app logic is also provided [here](https://github.com/HorizenOfficial/vela-starterkit/blob/main/docs/2_private-transfer-app.md).
In the x402 flow:

**App-level prerequisites (not enforced by the facilitator):** 
- both buyer and seller must have previously registered their P-521 encryption keys via `ASSOCIATEKEY` requests, and the buyer must have deposited funds into vela-nova's privacy layer. These are vela-nova requirements for the encrypted event system and private balances — the facilitator is agnostic to them.
- The PROCESS request payload is a JSON transfer instruction: `{ type: "transfer", transfer: { to, amount, invoice_id } }`, **encrypted** with the TEE's P-521 public key before submission. The client (buyer) must have a P-521 key pair and know the TEE's public key (retrieved via `MockTeeAuthenticator.getPubSecp521r1()`) to encrypt payloads. Encryption uses ECIES via [`vela-common-ts`](https://github.com/HorizenOfficial/vela-common-ts). The facilitator receives the already-encrypted payload and forwards it to the contract as-is.
- **`invoiceId`** (max 100 chars) is included in `PaymentRequirements.extra.invoiceId` so the seller can correlate the settlement with the original HTTP request. The seller sets it in the 402 response, and the client is expected to include it in the vela-nova transfer payload as `invoice_id`. After TEE processing, both parties receive encrypted events containing the `invoice_id`. The x402 standard has no native invoiceId field, but `PaymentRequirements.extra` is scheme-specific and extensible — our scheme uses `extra.invoiceId` for this purpose.
- **The facilitator cannot verify `invoiceId`** to enforce it is present — the payload is encrypted with the TEE's P-521 key, so the facilitator cannot read its contents. The match between `extra.invoiceId` and the payload's `invoice_id` is the **seller's responsibility**: after TEE processing, the seller checks the event's `invoice_id` against the one it originally set in the PaymentRequirements.

## Settle Semantics: Submission, Not Completion

In the standard Coinbase x402 `exact` scheme, a successful `/settle` means the payment is complete (ERC-20 transferred directly). In our scheme, **a successful `/settle` means the request has been submitted on-chain** (`submitRequestFor()` confirmed) — and the request is queued for TEE processing. The actual private transfer inside vela-nova happens later, asynchronously.

This means the seller's resource server should **not** treat a successful settle as proof of payment completion. Instead, the seller should wait for the vela-nova encrypted event containing the `invoice_id` to confirm the transfer was processed by the TEE. This is the seller's responsibility and is outside the scope of the facilitator service.

The on-chain submission is a strong guarantee: signatures are valid, nonce is consumed. The residual risk is that the user has insufficient balance inside vela-nova's privacy layer, in which case the TEE will process an error.

## Architecture Diagram

The diagram below shows the full x402 flow with all three components using the `private-vela-fixed` scheme from `@horizen/x402-private-vela-fixed`, plus the core `/submit` route for non-x402 usage.

```
  Any client                        ┌──────────────────────────────────┐
  (SDK, CLI, bot)                   │  Buyer (x402Client)              │
      │                             │                                  │
      │                             │  registerPrivateVelaFixedClient  │
      │                             │  ─ EIP-712 + EIP-2612 signing   │
      │                             │  ─ P-521 payload encryption     │
      │                             │  ─ reads nonces from chain      │
      │                             └──────────┬───────────────────────┘
      │                                        │
      │                                        │ 1. GET /resource
      │                                        ▼
      │                             ┌──────────────────────────────────┐
      │                             │  Seller (x402ResourceServer)     │
      │                             │                                  │
      │                             │  registerPrivateVelaFixedServer  │
      │                             │  ─ returns 402 + Payment-        │
      │                             │    Requirements {invoiceId}      │
      │                             │  ─ calls facilitator on retry    │
      │                             └──────────┬───────────────────────┘
      │                                        │                  ▲
      │                                        │ 2. /verify       │ 5. {requestId,
      │                                        │    /settle       │     txHash}
      │                                        ▼                  │
┌─────┼───────────────────────────────────────────────────────────────────┐
│     │                                                                   │
│  vela-facilitator (Express service)                                     │
│     │                                                                   │
│     │                      ┌────────────────────────────┐               │
│     │                      │ x402 routes                │               │
│     │                      │  POST /verify              │               │
│     │                      │  POST /settle              │               │
│     ▼                      │  GET  /supported            │               │
│  ┌───────────────────┐     └────────────┬───────────────┘               │
│  │ Core routes        │                  │                              │
│  │  POST /submit      │    ┌─────────────────────┐                     │
│  │  (app-agnostic)    │    │  x402Facilitator    │                     │
│  └────────┬───────────┘    │  (from @x402/core)  │                     │
│           │                └─────────┬──────────┘                      │
│           │                          │                                 │
│           │                          ▼                                 │
│           │      ┌──────────────────────────────────────┐             │
│           │      │  @horizen/x402-private-vela-fixed    │             │
│           │      │                                      │             │
│           │      │  registerPrivateVelaFixedScheme      │             │
│           │      │  ─ verify: EIP-712 + EIP-2612        │             │
│           │      │    off-chain validation               │             │
│           │      │  ─ settle: submitRequestFor()        │             │
│           │      │    on-chain                           │             │
│           │      └──────────────┬───────────────────────┘             │
│           │                     │                                     │
│           │  direct call        │ via scheme                          │
│           ▼                     ▼                                     │
│  ┌──────────────────────────────────────┐                             │
│  │  ProcessorEndpoint contract          │  verify sigs, consume nonce,│
│  │  submitRequestFor()                  │  permit+transferFrom,       │
│  │  (on-chain via ethers.js)            │  create PendingRequest      │
│  └──────────────────────────────────────┘                             │
└───────────────────────────────────────────────────────────────────────┘
```

The core `/submit` route reuses the scheme's underlying `verify()` + `settle()` logic but with a simpler non-x402 request format. Unlike the x402 scheme (which is specifically designed for the [vela-nova private transfer app](https://github.com/HorizenOfficial/vela-nova)), `/submit` is **application-agnostic** and can forward requests to any app on the chain.

## x402 Scheme Pattern

The [x402 protocol](https://github.com/coinbase/x402/) by Coinbase defines three components that participate in the payment flow. Each component is generic and delegates all payment-specific logic to a pluggable **scheme**:

```
@x402/core
├── x402Facilitator      + scheme  →  facilitator: verify/settle on-chain
├── x402ResourceServer   + scheme  →  seller: returns 402, calls facilitator
└── x402Client           + scheme  →  buyer: signs payments, retries after 402
```

Coinbase ships the `exact` EVM scheme (direct ERC-20 transfers via EIP-3009). Our package `@horizen/x402-private-vela-fixed` provides a custom scheme for all three components, handling the vela-nova specific flow (EIP-2612 permit, encrypted payloads, `submitRequestFor()`). Each component only needs to register the scheme — the `@x402/core` framework handles the HTTP orchestration (402 responses, payment headers, retry logic).

## x402 Facilitator Integration

The facilitator implements `SchemeNetworkFacilitator` from `@x402/core`:

```typescript
interface SchemeNetworkFacilitator {
  readonly scheme: string;                    // "private-vela-fixed"
  readonly caipFamily: string;                // "eip155:*"

  getExtra(network: Network): Record<string, unknown> | undefined;
  getSigners(network: string): string[];

  verify(payload: PaymentPayload, requirements: PaymentRequirements,
         context?: FacilitatorContext): Promise<VerifyResponse>;
  settle(payload: PaymentPayload, requirements: PaymentRequirements,
         context?: FacilitatorContext): Promise<SettleResponse>;
}
```

Setup and needed parameters:

```typescript
import { x402Facilitator } from '@x402/core/facilitator';
import { registerPrivateVelaFixedScheme } from '@horizen/x402-private-vela-fixed';

const facilitator = new x402Facilitator();
registerPrivateVelaFixedScheme(facilitator, {
  rpcUrl: config.rpcUrl,                        // from RPC_URL
  contractAddress: config.contractAddress,        // from PROCESSOR_ENDPOINT_ADDRESS
  signer: new ethers.Wallet(config.signerPrivateKey), // ethers.Signer from FACILITATOR_PRIVATE_KEY
  maxFeeValue: config.maxFeeValue,                // from MAX_FEE_VALUE
  applicationId: config.applicationId,            // from VELA_NOVA_APPLICATION_ID
  network: `eip155:${config.chainId}`,            // derived from CHAIN_ID
});

// x402 routes delegate to facilitator.verify() / facilitator.settle()
// Core /submit route reuses scheme logic with simpler request format
// No /nonce endpoint — clients read facilitatorNonces[user] directly from contract
```

## x402 Resource Server Integration (Seller)

The seller uses `x402ResourceServer` from `@x402/core/server` to protect routes behind x402 payments. Our scheme provides `registerPrivateVelaFixedServer()` to configure the `PaymentRequirements` with the correct scheme-specific fields (including `extra.invoiceId`).

```typescript
import { x402ResourceServer, HTTPFacilitatorClient } from '@x402/core/server';
import { x402HTTPResourceServer } from '@x402/core/http';
import { registerPrivateVelaFixedServer } from '@horizen/x402-private-vela-fixed';

const facilitatorClient = new HTTPFacilitatorClient({
  url: 'https://facilitator.vela.network',
});

const resourceServer = new x402ResourceServer(facilitatorClient);
registerPrivateVelaFixedServer(resourceServer, {
  network: 'eip155:2651420',
  payTo: sellerAddress,                   // seller's Ethereum address
  tokenAddress: usdcAddress,              // ERC-20 token for deposits
  contractAddress: processorEndpointAddr, // ProcessorEndpoint address
});

const routes = {
  'GET /api/premium-data': {
    accepts: {
      scheme: 'private-vela-fixed',
      network: 'eip155:2651420',
      payTo: sellerAddress,
      maxAmountRequired: '1000000',       // in token units
      asset: usdcAddress,
      extra: { invoiceId: 'INV-001' },    // seller sets per-route/per-request
    },
  },
};

const httpServer = new x402HTTPResourceServer(resourceServer, routes);
```

The resource server automatically:
1. Returns 402 with `PaymentRequirements` when a protected route is accessed
2. Extracts the payment proof from the retry header
3. Calls the facilitator's `/verify` + `/settle`
4. Returns the resource on successful settlement

The seller is responsible for checking the `invoice_id` in the TEE event after processing — the facilitator cannot verify it (see "Settle Semantics" above).

## x402 Client Integration (Buyer)

The client-side scheme handles all vela-nova specific logic:
1. Receives 402 response with `PaymentRequirements` (including `extra.invoiceId`)
2. Reads `facilitatorNonces[sender]` from `ProcessorEndpoint` contract
3. Reads EIP-2612 nonce from the token contract
4. Builds the vela-nova transfer payload with `invoice_id`
5. Encrypts payload with TEE's P-521 public key (ECIES via `vela-common-ts`)
6. Signs EIP-712 request authorization + EIP-2612 permit
7. Returns the `PaymentPayload` for the x402Client to retry the request

```typescript
import { x402Client } from '@x402/core/client';
import { registerPrivateVelaFixedClient } from '@horizen/x402-private-vela-fixed';

const client = new x402Client();
registerPrivateVelaFixedClient(client, {
  signer: buyerSigner,                     // ethers.Signer (for EIP-712 + EIP-2612)
  p521PrivateKey: buyerP521Key,            // buyer's P-521 key (for payload encryption, not Ethereum)
  teePublicKey: teeP521PublicKey,          // TEE's P-521 public key
  rpcUrl: 'https://rpc.vela.network',      // for reading nonces from chain
  contractAddress: processorEndpointAddr,  // ProcessorEndpoint address
  tokenAddress: usdcAddress,               // ERC-20 token for deposits
});

// x402Client automatically handles 402 responses
const response = await client.fetch('https://api.seller.com/resource');
```

## Project Structure

```
vela-facilitator/
├── README.md                           # Project overview, architecture, getting started
├── packages/
│   ├── x402-private-vela-fixed/       # @horizen/x402-private-vela-fixed (publishable)
│   │   ├── src/
│   │   │   ├── index.ts               # Public exports
│   │   │   ├── scheme.ts              # PrivateVelaFixedScheme (facilitator: verify/settle)
│   │   │   ├── register.ts            # registerPrivateVelaFixedScheme() (facilitator)
│   │   │   ├── client.ts              # registerPrivateVelaFixedClient() (buyer: sign/pay)
│   │   │   ├── sign.ts                # Client signing logic (EIP-712 + EIP-2612 + P-521 encrypt)
│   │   │   ├── server.ts              # registerPrivateVelaFixedServer() (seller: 402 + PaymentRequirements)
│   │   │   ├── types.ts               # RequestAuthorization, DepositPermit, VelaPaymentPayload
│   │   │   ├── verify.ts              # Off-chain EIP-712 + EIP-2612 signature validation
│   │   │   └── settle.ts              # On-chain submitRequestFor() call
│   │   ├── README.md                  # Scheme package docs: facilitator + client usage examples
│   │   ├── package.json               # depends on @x402/core, ethers, vela-common-ts (P-521)
│   │   └── tsconfig.json
│   │
│   └── contracts/                      # Hardhat project for mock contracts
│       ├── contracts/
│       │   ├── Structs.sol             # Extended structs (adds facilitator, tokenAddress, assetAmount)
│       │   ├── MockProcessorEndpoint.sol  # submitRequestFor + simulateProcessing + claims
│       │   ├── MockEIP2612Token.sol    # ERC-20 with permit (EIP-2612)
│       │   ├── MockTeeAuthenticator.sol
│       │   └── MockAuthorityRegistry.sol
│       ├── test/                       # Solidity-level unit tests (optional, Hardhat+Chai)
│       ├── hardhat.config.ts
│       ├── package.json                # depends on hardhat, @openzeppelin/contracts, typechain
│       └── tsconfig.json
│
├── src/                                # Facilitator service
│   ├── README.md                       # API reference: endpoints, request/response schemas, curl examples
│   ├── index.ts                        # Express app + x402Facilitator setup + scheme registration
│   ├── config.ts                       # Configuration (RPC URL, contract addr, private key, etc.)
│   └── routes/
│       ├── x402.ts                     # Standard x402 endpoints: POST /verify, POST /settle, GET /supported
│       └── submit.ts                   # POST /submit (core, non-x402)
│
├── mock/                               # Mock infrastructure
│   ├── anvil.ts                        # Anvil process management (start/stop/health check)
│   └── deploy.ts                       # Deploy mock contracts to Anvil, return addresses + instances
│
├── test/                               # Integration tests (Vitest)
│   ├── setup.ts                        # Global setup: Anvil + deploy + start facilitator
│   ├── helpers/
│   │   └── signer.ts                   # TestUser: EIP-712 + EIP-2612 signing helpers
│   ├── core/
│   │   └── submit.test.ts              # Core /submit flow tests
│   ├── x402/
│   │   ├── verify.test.ts              # x402 /verify tests
│   │   └── settle.test.ts              # x402 /settle tests
│   └── e2e/
│       └── full-flow.test.ts           # Full lifecycle: core /submit + x402 client→facilitator round-trip
│
├── package.json                        # Root (facilitator service deps + workspace config)
├── pnpm-workspace.yaml                 # Workspace: packages/*
└── tsconfig.json
```

## Configuration

The facilitator is configured via environment variables:

| Variable | Description | Example |
|----------|-------------|---------|
| `CHAIN_ID` | Chain ID (for EIP-712 domain and CAIP-2 network derivation) | `2651420` |
| `RPC_URL` | Vela chain RPC endpoint | `https://rpc.vela.network` |
| `FACILITATOR_PRIVATE_KEY` | EOA private key (used to create an ethers.Signer; pays gas + maxFeeValue) | `0xac0974...` |
| `PROCESSOR_ENDPOINT_ADDRESS` | ProcessorEndpoint contract address | `0x5FbDB2...` |
| `MAX_FEE_VALUE` | ETH in wei sent as `msg.value` for service fees | `1000000000000000` |
| `VELA_NOVA_APPLICATION_ID` | Application ID of the vela-nova private transfer app (used by x402 scheme) | `1` |
| `PORT` | HTTP server port | `3000` |

Note: The token address is **not** a configuration parameter — it comes from the client payload (`/submit`) or from `PaymentRequirements.asset` (x402 flow, set by the seller in the 402 response). The contract validates it against `globalAllowedTokens` on-chain.

## Key Technical Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| x402 integration | Use `@x402/core` `x402Facilitator` + custom scheme | Follows Coinbase pattern; uses EIP-2612 instead of EIP-3009, so own verify/settle logic needed |
| Scheme package | Separate `@horizen/x402-private-vela-fixed` in monorepo | Publishable independently; custom verify/settle via `submitRequestFor()` |
| Deposit authorization | EIP-2612 (`permit`) | More widely adopted than EIP-3009; sequential nonces; sufficient security for our use case |
| x402 target app | [vela-nova](https://github.com/HorizenOfficial/vela-nova) | x402 scheme specifically targets private transfers; `/submit` remains app-agnostic |
| invoiceId | `PaymentRequirements.extra.invoiceId` + vela-nova `invoice_id` field | x402 has no native invoiceId; `extra` is scheme-extensible; facilitator cannot verify it (payload is encrypted) — seller checks the match via TEE events; vela-nova supports `invoice_id` (max 100 chars) |
| Mock contract | Standalone (not extending ProcessorEndpoint) | ERC-20 prerequisite changes don't exist yet; cleaner self-contained mock |
| Local chain | Anvil (`anvil` CLI from Foundry) | Standard, fast, deterministic accounts |
| Contract tooling | Hardhat + typechain | Matches vela contracts repo; TypeScript bindings |
| HTTP framework | Express.js | Simple, widely used |
| Testing | Vitest | Fast, TypeScript-native |
| Ethereum library | ethers.js v6 | Matches vela-common-ts |
| Package manager | pnpm workspaces | Standard for monorepos, good for local package linking |

## Mock Infrastructure

Since the real contract changes (submitRequestFor, ERC-20 support) are not yet implemented in vela, we mock the entire on-chain layer with Anvil + mock contracts.

- The mock contract is **standalone** (not extending ProcessorEndpoint) because the ERC-20 prerequisite changes don't exist in the current code.
- All custom Vela logic is isolated in the `@horizen/x402-private-vela-fixed` scheme package, which uses EIP-2612 (`permit`) for deposit authorization instead of EIP-3009 used by Coinbase's standard `exact` scheme. The Coinbase reference facilitator's settle logic cannot be reused directly — our scheme implements its own verify/settle via `submitRequestFor()`.

## Verification

After all tasks are complete:
```bash
pnpm install                                              # Dependencies
pnpm --filter @vela-facilitator/contracts run compile     # Contracts compile
pnpm --filter @horizen/x402-private-vela-fixed run build  # Scheme package builds
pnpm test                                                 # All integration + e2e tests pass
pnpm dev                                                  # Service starts, curl /supported works
```
