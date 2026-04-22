# vela-facilitator

Gasless request submission service for the [Vela blockchain platform](https://github.com/HorizenOfficial/vela/blob/main/docs/design/FACILITATOR.md). Allows users to submit requests (transfers, key association) without holding ETH by delegating gas and service fees to a facilitator.

## Overview

The facilitator acts as a gas relay: users sign EIP-712 typed messages and the facilitator submits the transactions on-chain, paying all gas. It exposes:

- **`POST /submit`** — Application-agnostic gasless submission. Accepts any `ASSOCIATEKEY` or `PROCESS` request signed by the user and submits it to the `ProcessorEndpoint` contract.
- **`POST /verify`** — x402 off-chain payment verification.
- **`POST /settle`** — x402 on-chain settlement: calls `submitRequestFor()` and then **blocks until the TEE confirms the transfer** by emitting the matching `AppEvent`.
- **`POST /claim`** — Permissionless claim: calls `claim(tokenAddress, payee)` on `ProcessorEndpoint`. Anyone can trigger the claim — funds always go to `payee`.
- **`GET /supported`** — Returns the list of supported x402 schemes and networks.

## Architecture

```
┌───────────────────────────────────────┐
│          vela-facilitator             │
│  ┌─────────────────────────────────┐  │
│  │       Express HTTP server        │  │
│  │  POST /submit  POST /verify     │  │
│  │  POST /settle  POST /claim      │  │
│  │  GET  /supported                │  │
│  └──────────────┬──────────────────┘  │
│                 │                     │
│  ┌──────────────▼──────────────────┐  │
│  │  @horizen/x402-private-vela-    │  │
│  │  fixed  (x402 scheme package)   │  │
│  │                                 │  │
│  │  verify.ts  settle.ts           │  │
│  │  sign.ts    client.ts           │  │
│  │  server.ts  scheme.ts           │  │
│  └──────────────┬──────────────────┘  │
│                 │                     │
│  ┌──────────────▼──────────────────┐  │
│  │   Vela ProcessorEndpoint.sol    │  │
│  │   (on-chain smart contract)     │  │
│  └─────────────────────────────────┘  │
└───────────────────────────────────────┘
```

### Monorepo layout

```
vela-facilitator/
├── src/                   # Facilitator Express server
│   ├── index.ts           # App entry point
│   ├── config.ts          # Environment variable config
│   └── routes/
│       ├── x402.ts        # GET /supported, POST /verify, POST /settle
│       ├── submit.ts      # POST /submit
│       └── claim.ts       # POST /claim
├── packages/
│   ├── x402-private-vela-fixed/   # x402 scheme package (publishable)
│   │   └── src/
│   │       ├── types.ts   # Shared types and EIP-712 constants
│   │       ├── verify.ts  # Off-chain verification logic
│   │       ├── settle.ts  # On-chain settlement logic
│   │       ├── sign.ts    # Client-side signing + payload encryption
│   │       ├── client.ts  # x402Client registration helper
│   │       ├── server.ts  # x402ResourceServer registration helper
│   │       └── scheme.ts  # SchemeNetworkFacilitator implementation
│   └── contracts/         # Hardhat mock contracts for local dev + testing
│       └── contracts/
│           ├── Structs.sol
│           ├── MockProcessorEndpoint.sol
│           ├── MockEIP2612Token.sol
│           └── MockTeeAuthenticator.sol
├── mock/                  # Anvil lifecycle + contract deployment helpers
├── test/                  # Vitest integration + E2E tests
└── ARCHITECTURE.md        # Architecture decisions and diagrams
```

## Getting started

### Prerequisites

- Node.js 20+
- [pnpm](https://pnpm.io/) 9+
- [Foundry](https://getfoundry.sh/) (`anvil`) for running tests

### Install and build

```bash
pnpm install
pnpm --filter @vela-facilitator/contracts run compile  # compile Solidity mock contracts
pnpm --filter @horizen/x402-private-vela-fixed build  # compile scheme package
pnpm build  # compile facilitator server
```

### Run in development

```bash
# Set environment variables (see Configuration below)
RPC_URL=http://127.0.0.1:8545 \
FACILITATOR_PRIVATE_KEY=0x... \
PROCESSOR_ENDPOINT_ADDRESS=0x... \
pnpm dev
```

### Run with Docker

```bash
cd dockerfiles
cp .env.template .env   # fill in the required values
docker compose up -d
```

See [`dockerfiles/README.md`](dockerfiles/README.md) for standalone Docker build instructions and full configuration details.

### Run tests

Tests start a local Anvil node, deploy mock contracts, and run the full facilitator stack.

```bash
pnpm test
```

### Dev smoke test

`pnpm dev:smoke` runs a small HTTP-level smoke test against an **already-running** facilitator + chain (no bootstrap, no contract deploy). It mirrors the e2e flow:

1. `GET /supported`
2. `POST /submit` — `ASSOCIATEKEY` with a fresh P-521 key for the buyer
3. `POST /verify` — x402 transfer with `assetAmount=0`
4. `POST /settle` — x402 transfer with `assetAmount=0`

Defaults target the vela dev stack (Anvil + `vela/dockerfiles/.env.dev`); override any env var to point elsewhere (e.g. the remote dev RPC):

| Variable | Default |
|---|---|
| `FACILITATOR_URL` | `http://localhost:3000` |
| `RPC_URL` | `http://localhost:8545` |
| `PROCESSOR_ENDPOINT_ADDRESS` | deterministic Anvil deploy address |
| `TOKEN_ADDRESS` | `ZeroAddress` (fine for `assetAmount=0`) |
| `TEE_PUBLIC_KEY_HEX` | dev TEE public key (from vela `.env.dev`) |
| `BUYER_PRIVATE_KEY` | Anvil account #3 |
| `SELLER_ADDRESS` | Anvil account #4 |

Prerequisites (not performed by the script):
- `ProcessorEndpoint` + `MockEIP2612Token` deployed at the configured addresses
- Facilitator account funded with ETH
- The target `VELA_NOVA_APPLICATION_ID` is deployed on-chain (otherwise `/settle` reverts with `InvalidApplicationId()`)

```bash
pnpm dev:smoke
# or with overrides
FACILITATOR_URL=http://localhost:3000 RPC_URL=http://dev-rpc:8545 pnpm dev:smoke
```

See [`scripts/dev-smoke.ts`](scripts/dev-smoke.ts) for the full list of overridable env vars.

## Configuration

All configuration is via environment variables:

| Variable | Required | Default | Description |
|---|---|---|---|
| `RPC_URL` | yes | — | Ethereum JSON-RPC URL. The chain ID is derived from it at startup. |
| `FACILITATOR_PRIVATE_KEY` | yes | — | Hex private key of the facilitator's Ethereum wallet (pays gas) |
| `PROCESSOR_ENDPOINT_ADDRESS` | yes | — | Address of the deployed `ProcessorEndpoint` contract |
| `MAX_FEE_VALUE` | no | `0` | ETH in wei sent as `msg.value` to cover service fees |
| `VELA_NOVA_APPLICATION_ID` | no | `1` | vela-nova application ID, used for x402 payments |
| `PORT` | no | `3000` | HTTP server port |
| `APP_EVENT_POLL_INTERVAL_MS` | no | `2000` | How often `/settle` polls for the TEE `AppEvent` after submission |
| `APP_EVENT_POLL_TIMEOUT_MS` | no | `60000` | How long `/settle` waits before returning `tee_processing_timeout` |

## x402 scheme: `private-vela-fixed`

This project implements the `private-vela-fixed` x402 payment scheme for all three x402 roles:

- **Facilitator**: verifies and settles payments by calling `submitRequestFor()` on `ProcessorEndpoint`
- **Client (buyer)**: builds and signs transfer payloads (EIP-712 + EIP-2612), encrypts with TEE P-521 key
- **Resource server (seller)**: configures `PaymentRequirements` with `invoiceId` in `extra`

See [`packages/x402-private-vela-fixed/README.md`](packages/x402-private-vela-fixed/README.md) for full scheme documentation.

## Design notes

- **Nonce management**: clients query `facilitatorNonces[sender]` directly from the contract before signing. The facilitator does not maintain nonce state.
- **TEE-confirmed settlement**: a successful `POST /settle` means vela-nova's TEE has processed the transfer. After `submitRequestFor()` is mined, the facilitator recomputes the `AppEvent.eventSubType` hash — `keccak256(uint32_be(len(invoiceId)) || invoiceId || sender || tokenAddress || amount(32B) || recipient)` — and polls the chain until the matching `AppEvent` is emitted. Because that hash binds all five fields, the seller gets a cryptographic proof that the transfer landed as specified. On timeout, `/settle` returns `success: false` with `errorReason: "tee_processing_timeout"` (the on-chain `requestId` stays in `extensions` for reconciliation).
- **EIP-2612 permit**: uses `permit()` (sequential nonces) for gasless ERC-20 approval, unlike Coinbase's reference scheme which uses EIP-3009 `transferWithAuthorization`.
- **Payload encryption**: the transfer payload is encrypted with the TEE's P-521 ECIES public key. The facilitator cannot read the payload contents — but the `AppEvent` hash lets it verify the decrypted result anyway.

## References

- [FACILITATOR.md](https://github.com/HorizenOfficial/vela/blob/main/docs/design/FACILITATOR.md) — Design spec (section 5.3)
- [ProcessorEndpoint.sol](https://github.com/HorizenOfficial/vela/blob/main/contracts/contracts/ProcessorEndpoint.sol) — On-chain contract
- [vela-nova](https://github.com/HorizenOfficial/vela-nova) — Private transfer app (x402 scheme target)
- [vela-starterkit](https://github.com/HorizenOfficial/vela-starterkit/blob/main/docs/2_private-transfer-app.md) — Private transfer app documentation
