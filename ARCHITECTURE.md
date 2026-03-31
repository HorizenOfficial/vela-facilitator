# vela-facilitator — Architecture

## Overview

The vela-facilitator is a platform-level TypeScript service that submits Vela blockchain requests on behalf of users who don't hold ETH (gasless submission). Defined in [FACILITATOR.md](https://github.com/HorizenOfficial/vela/blob/main/docs/design/FACILITATOR.md) section 5.3, it has two layers:

1. **Core facilitation** — POST /submit (generic, non-x402). Can submit requests to **any application** on the Vela chain. Nonce queries are done directly on-chain by clients.
2. **x402 scheme** — POST /verify, POST /settle, GET /supported (standard Coinbase x402 protocol). Specifically targets the [**vela-nova private transfer app**](https://github.com/HorizenOfficial/vela-nova) (`applicationId = 1`) for private ERC-20 transfers.

The design uses EIP-2612 (`permit`) for deposit authorization and EIP-712 for request authorization. Only `ASSOCIATEKEY` and `PROCESS` request types are supported via `submitRequestFor`. The nonce is not passed as a calldata parameter — the contract reads it from `facilitatorNonces[sender]` directly.

## vela-nova App Integration (x402 scheme)

The `private-vela-fixed` x402 scheme is designed around the [vela-nova private transfer app](https://github.com/HorizenOfficial/vela-starterkit/blob/main/docs/2_private-transfer-app.md). In the x402 flow:

**App-level prerequisites (not enforced by the facilitator):** 
- both buyer and seller must have previously registered their P-521 encryption keys via `ASSOCIATEKEY` requests, and the buyer must have deposited funds into vela-nova's privacy layer. These are vela-nova requirements for the encrypted event system and private balances — the facilitator is agnostic to them.
- The PROCESS request payload is a JSON transfer instruction: `{ type: "transfer", transfer: { to, amount, invoice_id } }`, **encrypted** with the TEE's P-521 public key before submission. The client (buyer) must have a P-521 key pair and know the TEE's public key (retrieved via `MockTeeAuthenticator.getPubSecp521r1()`) to encrypt payloads. Encryption uses ECIES via [`vela-common-ts`](https://github.com/HorizenOfficial/vela-common-ts). The facilitator receives the already-encrypted payload and forwards it to the contract as-is.
- **`invoiceId`** (max 100 chars) is **required** in the x402 scheme — without it, the seller (resource server) cannot correlate the on-chain settlement with the original HTTP request. The seller sets it via `PaymentRequirements.extra.invoiceId` in the 402 response, and the client must include it in the vela-nova transfer payload as `invoice_id`. After TEE processing, both parties receive encrypted events containing the `invoice_id`. The x402 standard has no native invoiceId field, but `PaymentRequirements.extra` is scheme-specific and extensible — our scheme uses `extra.invoiceId` for this purpose.
- Note: `invoice_id` is optional at the vela-nova app level (it supports generic transfers too), but our x402 scheme **enforces** it during verify — if `PaymentRequirements.extra.invoiceId` is set, the payload must contain a matching `invoice_id`.

## Settle Semantics: Submission, Not Completion

In the standard Coinbase x402 `exact` scheme, a successful `/settle` means the payment is complete (ERC-20 transferred directly). In our scheme, **a successful `/settle` means the request has been submitted on-chain** (`submitRequestFor()` confirmed) — and the request is queued for TEE processing. The actual private transfer inside vela-nova happens later, asynchronously.

This means the seller's resource server should **not** treat a successful settle as proof of payment completion. Instead, the seller should wait for the vela-nova encrypted event containing the `invoice_id` to confirm the transfer was processed by the TEE. This is the seller's responsibility and is outside the scope of the facilitator service.

The on-chain submission is a strong guarantee: signatures are valid, nonce is consumed. The residual risk is that the user has insufficient balance inside vela-nova's privacy layer, in which case the TEE will process an error.

## Architecture Diagram

Following the Coinbase x402 facilitator pattern from `@x402/core`:

```
┌─────────────────────────────────────────────────────────────┐
│  vela-facilitator (Express server)                          │
│                                                             │
│  ┌───────────────────────┐   ┌────────────────────────────┐ │
│  │ Core routes            │   │ x402 routes               │ │
│  │  POST /submit          │   │  POST /verify             │ │
│  │                        │   │  POST /settle             │ │
│  │                        │   │  GET  /supported           │ │
│  └──────────┬─────────────┘   └────────────┬──────────────┘ │
│             │                              │                │
│             │    ┌─────────────────────┐   │                │
│             │    │  x402Facilitator    │   │                │
│             │    │  (from @x402/core)  │◄──┘                │
│             │    │                     │                    │
│             │    │  .register(network, │                    │
│             │    │    scheme)          │                    │
│             │    └─────────┬──────────┘                    │
│             │              │                               │
│             ▼              ▼                                │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  @horizen/x402-private-vela-fixed                    │  │
│  │  (separate publishable package)                      │  │
│  │                                                      │  │
│  │  PrivateVelaFixedScheme implements                   │  │
│  │    SchemeNetworkFacilitator {                         │  │
│  │      scheme = "private-vela-fixed"                   │  │
│  │      verify(payload, requirements) → VerifyResponse  │  │
│  │      settle(payload, requirements) → SettleResponse  │  │
│  │  }  (uses EIP-2612 permit, not EIP-3009)             │  │
│  │                                                      │  │
│  │  registerPrivateVelaFixedScheme(facilitator, config) │  │
│  └──────────────────────────────────────────────────────┘  │
│             │                                               │
│             ▼                                               │
│  ┌──────────────────────────────┐                          │
│  │  ProcessorEndpoint contract  │                          │
│  │  (on-chain via ethers.js)    │                          │
│  └──────────────────────────────┘                          │
└─────────────────────────────────────────────────────────────┘
```

The core `/submit` route reuses the scheme's underlying `verify()` + `settle()` logic but with a simpler non-x402 request format. Unlike the x402 scheme (which is specifically designed for the [vela-nova private transfer app](https://github.com/HorizenOfficial/vela-nova), `applicationId = 1`), `/submit` is **application-agnostic** and can forward requests to any app on the chain.

## Project Structure

```
vela-facilitator/
├── README.md                           # Project overview, architecture, getting started
├── packages/
│   ├── x402-private-vela-fixed/       # @horizen/x402-private-vela-fixed (publishable)
│   │   ├── src/
│   │   │   ├── index.ts               # Public exports
│   │   │   ├── scheme.ts              # PrivateVelaFixedScheme (implements SchemeNetworkFacilitator)
│   │   │   ├── register.ts            # registerPrivateVelaFixedScheme() helper
│   │   │   ├── types.ts               # RequestAuthorization, DepositPermit, VelaPaymentPayload
│   │   │   ├── verify.ts              # Off-chain EIP-712 + EIP-2612 signature validation
│   │   │   └── settle.ts              # On-chain submitRequestFor() call
│   │   ├── README.md                  # Scheme package docs: interface, types, registration example
│   │   ├── package.json               # depends on @x402/core, ethers
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
│   ├── deploy.ts                       # Deploy mock contracts to Anvil, return addresses + instances
│   └── simulate.ts                     # TEE processing simulation helper
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
│       └── full-flow.test.ts           # Full lifecycle: sign → submit → process → claim
│
├── package.json                        # Root (facilitator service deps + workspace config)
├── pnpm-workspace.yaml                 # Workspace: packages/*
└── tsconfig.json
```

## Key Technical Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| x402 integration | Use `@x402/core` `x402Facilitator` + custom scheme | Follows Coinbase pattern; uses EIP-2612 instead of EIP-3009, so own verify/settle logic needed |
| Scheme package | Separate `@horizen/x402-private-vela-fixed` in monorepo | Publishable independently; custom verify/settle via `submitRequestFor()` |
| Deposit authorization | EIP-2612 (`permit`) | More widely adopted than EIP-3009; sequential nonces; sufficient security for our use case |
| x402 target app | [vela-nova](https://github.com/HorizenOfficial/vela-nova) (`applicationId = 1`) | x402 scheme specifically targets private transfers; `/submit` remains app-agnostic |
| invoiceId | `PaymentRequirements.extra.invoiceId` (required) + vela-nova `invoice_id` field | x402 has no native invoiceId; `extra` is scheme-extensible; required in our scheme so seller can correlate payments; vela-nova already supports `invoice_id` (max 100 chars) |
| Mock contract | Standalone (not extending ProcessorEndpoint) | ERC-20 prerequisite changes don't exist yet; cleaner self-contained mock |
| Local chain | Anvil (`anvil` CLI from Foundry) | Standard, fast, deterministic accounts |
| Contract tooling | Hardhat + typechain | Matches vela contracts repo; TypeScript bindings |
| HTTP framework | Express.js | Simple, widely used |
| Testing | Vitest | Fast, TypeScript-native |
| Ethereum library | ethers.js v6 | Matches vela-common-ts |
| Package manager | pnpm workspaces | Standard for monorepos, good for local package linking |

## Key Interface: SchemeNetworkFacilitator (from @x402/core)

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

## Facilitator Server Setup (conceptual)

```typescript
import { x402Facilitator } from '@x402/core/facilitator';
import { registerPrivateVelaFixedScheme } from '@horizen/x402-private-vela-fixed';

const facilitator = new x402Facilitator();
registerPrivateVelaFixedScheme(facilitator, {
  rpcUrl: config.rpcUrl,
  contractAddress: config.contractAddress,
  signerPrivateKey: config.signerPrivateKey,
  maxFeeValue: config.maxFeeValue,
  network: 'eip155:2651420',  // Vela chain
});

// x402 routes delegate to facilitator.verify() / facilitator.settle()
// Core /submit route reuses scheme logic with simpler request format
// No /nonce endpoint — clients read facilitatorNonces[user] directly from contract
```

## Mock Infrastructure

Since the real contract changes (submitRequestFor, ERC-20 support) are not yet implemented in vela, we mock the entire on-chain layer with Anvil + mock contracts.

- The mock contract is **standalone** (not extending ProcessorEndpoint) because the ERC-20 prerequisite changes don't exist in the current code.
- All custom Vela logic is isolated in the `@horizen/x402-private-vela-fixed` scheme package, which uses EIP-2612 (`permit`) for deposit authorization instead of EIP-3009 used by Coinbase's standard `exact` scheme. The Coinbase reference facilitator's settle logic cannot be reused directly — our scheme implements its own verify/settle via `submitRequestFor()`.

## Verification

After all tasks are complete:
```bash
pnpm install                                              # Dependencies
pnpm --filter contracts exec hardhat compile              # Contracts compile
pnpm --filter @horizen/x402-private-vela-fixed run build  # Scheme package builds
pnpm test                                                 # All integration + e2e tests pass
pnpm dev                                                  # Service starts, curl /supported works
```
