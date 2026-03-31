# vela-facilitator

## Project Overview

Gasless request submission service for the Vela blockchain platform. Allows users to submit requests without holding ETH by delegating gas and fee payments to a facilitator.

- **Design doc (Vela side)**: [`FACILITATOR.md`](https://github.com/HorizenOfficial/vela/blob/main/docs/design/FACILITATOR.md) (section 5.3 for this service)
- **Architecture**: `ARCHITECTURE.md` — project structure, diagrams, technical decisions
- **Implementation plan**: `PLAN.md` — task list (temporary, will be removed after implementation)

## Status

Planning phase complete. No code implemented yet. See `PLAN.md` for the full 19-task implementation plan (Tasks 0–18).

## Architecture

pnpm workspace monorepo with two internal packages:

- **`packages/x402-private-vela-fixed/`** — `@horizen/x402-private-vela-fixed` npm package. Provides the `private-vela-fixed` scheme for all three x402 components: **facilitator** (verify/settle via `submitRequestFor()`), **resource server** (seller-side, 402 + PaymentRequirements with `invoiceId`), **client** (buyer-side, EIP-712 + EIP-2612 signing, P-521 payload encryption). Uses EIP-2612 (`permit`) for deposit authorization. Designed to be publishable and pluggable into any x402 facilitator/client/server.
- **`packages/contracts/`** — Hardhat project with mock Solidity contracts (`MockProcessorEndpoint`, `MockEIP2612Token`, etc.) used for local development and integration testing against Anvil.

The root package (`src/`) is the facilitator Express.js HTTP server:
- Creates an `x402Facilitator` from `@x402/core` and registers the `private-vela-fixed` scheme
- x402 routes: `GET /supported`, `POST /verify`, `POST /settle` — specifically designed for the [vela-nova private transfer app](https://github.com/HorizenOfficial/vela-nova) (`applicationId = 1`)
- Core route: `POST /submit` — application-agnostic, can forward requests to any app on the chain. Nonce queries are done directly on-chain by clients.

Mock infrastructure (`mock/`) manages Anvil lifecycle and contract deployment.

## Tech Stack

- TypeScript + Solidity 0.8.28
- ethers.js v6
- Express.js (HTTP server)
- `@x402/core` (Coinbase x402 facilitator framework)
- Hardhat + typechain (contract compilation and TypeScript bindings)
- Vitest (integration tests)
- Anvil (local Ethereum node for testing)
- pnpm workspaces

## Related Local Repos

See `CLAUDE.local.md` (if any) for local path mappings. Key references:

- [`ProcessorEndpoint.sol`](https://github.com/HorizenOfficial/vela/blob/main/contracts/contracts/ProcessorEndpoint.sol) — the real contract our mocks are based on
- [`Structs.sol`](https://github.com/HorizenOfficial/vela/blob/main/contracts/contracts/Structs.sol) — original data structures
- [`MockTeeAuthenticator.sol`](https://github.com/HorizenOfficial/vela/blob/main/contracts/contracts/mocks/MockTeeAuthenticator.sol) — reference for our mock
- [`vela-common-ts`](https://github.com/HorizenOfficial/vela-common-ts) — TypeScript library for Vela (P-521 crypto, VelaClient)
- [`vela-nova`](https://github.com/HorizenOfficial/vela-nova) — Private transfer app (x402 scheme target, `applicationId = 1`). See payload formats in `runtime/wasm-go/app/types.go`.
- [`vela-starterkit`](https://github.com/HorizenOfficial/vela-starterkit) — Contains [private transfer app docs](https://github.com/HorizenOfficial/vela-starterkit/blob/main/docs/2_private-transfer-app.md)

## Important Notes

- Mock contracts are **standalone** (not extending the real ProcessorEndpoint) because the ERC-20 prerequisite changes are not yet merged upstream.
- The `@horizen/x402-private-vela-fixed` scheme follows the x402 pattern but uses EIP-2612 (`permit`) for deposit authorization instead of EIP-3009 (`transferWithAuthorization`) used by Coinbase's standard `exact` scheme. This means the Coinbase reference facilitator's settle logic can't be reused directly — our scheme implements its own verify/settle via `submitRequestFor()`.
- Only `ASSOCIATEKEY` and `PROCESS` request types are supported via `submitRequestFor`. Other request types are rejected.
- The x402 scheme targets [vela-nova](https://github.com/HorizenOfficial/vela-nova) private transfers. `applicationId` is configurable (env var `VELA_NOVA_APPLICATION_ID`), `requestType = PROCESS` is hardcoded. Both buyer and seller must have registered P-521 keys (`ASSOCIATEKEY`) before transfers — this is a vela-nova app-level prerequisite, not enforced by the facilitator.
- The seller tracks payments via `invoiceId` in `PaymentRequirements.extra`. The facilitator **cannot** verify invoiceId (payload is encrypted) — the seller checks the match via TEE events after processing.
- Settle is **asynchronous**: a successful `/settle` means on-chain submission, not TEE completion. The seller waits for the vela-nova encrypted event to confirm the transfer.
- Config accepts `ethers.Signer` (not raw private keys) for Ethereum operations, following Coinbase's pattern. P-521 keys remain raw (ECIES encryption, not Ethereum).
- See [private transfer app docs](https://github.com/HorizenOfficial/vela-starterkit/blob/main/docs/2_private-transfer-app.md) for vela-nova details.
