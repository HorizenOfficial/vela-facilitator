# vela-facilitator — Development Plan

## Context

The vela-facilitator is a platform-level TypeScript service that submits Vela blockchain requests on behalf of users who don't hold ETH (gasless submission). Defined in FACILITATOR.md section 5.3, it has two layers:

1. **Core facilitation** — POST /submit (generic, non-x402). Nonce queries are done directly on-chain by clients.
2. **x402 scheme** — POST /verify, POST /settle, GET /supported (standard Coinbase x402 protocol)

The design uses EIP-2612 (`permit`) for deposit authorization and EIP-712 for request authorization. Only `ASSOCIATEKEY` and `PROCESS` request types are supported via `submitRequestFor`. The nonce is not passed as a calldata parameter — the contract reads it from `facilitatorNonces[sender]` directly.

Since the real contract changes (submitRequestFor, ERC-20 support) are not yet implemented in vela, we mock the entire on-chain layer with Anvil + mock contracts.

## Assumptions Evaluation

All user assumptions are **valid**, with these refinements:

1. **Anvil + mock contract** — Valid. We also need a **MockEIP2612Token** (ERC-20 with `permit`) since USDC/EIP-2612 support is core to the flow.

2. **New facilitator methods + TEE simulation** — Valid. The mock contract needs: `submitRequestFor()` (with `sender` parameter, nonce read from chain, request type validation, EIP-2612 permit), `facilitatorNonces`, `getFacilitatorNonce()`, split claim routing, and a `simulateProcessing()` helper.

3. **mock/ folder** — Valid. Will contain Anvil launcher, contract deployment, and TEE simulation helper.

4. **Integration tests** — Valid. Should cover: full gasless flow, nonce management, signature validation (valid + invalid), error cases, x402 verify/settle flow.

5. **TypeScript + Solidity** — Valid. Matches the ecosystem.

**Additional considerations**:
- The mock contract must be a **standalone contract** (not extending ProcessorEndpoint) because the ERC-20 prerequisite changes don't exist in the current code.
- All custom Vela logic is isolated in a **separate `@horizen/x402-private-vela-fixed` scheme package** that implements `SchemeNetworkFacilitator` from `@x402/core`. This scheme uses EIP-2612 (`permit`) for deposit authorization instead of EIP-3009 used by Coinbase's standard `exact` scheme, so the Coinbase reference facilitator's settle logic cannot be reused directly — our scheme implements its own verify/settle via `submitRequestFor()`.

## Architecture: x402 Scheme Integration

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

The core `/submit` route reuses the scheme's underlying `verify()` + `settle()` logic but with a simpler non-x402 request format.

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

## Implementation Tasks

### Task 0: Project Scaffolding
**Scope**: Initialize pnpm workspace monorepo with three packages.
**Dependencies**: None
**Files**:
- `/package.json` — root (express, ethers v6, vitest, tsx, typescript)
- `/pnpm-workspace.yaml` — `packages: ["packages/*"]`
- `/tsconfig.json` — root TypeScript config
- `/packages/x402-private-vela-fixed/package.json` — scheme package (depends on `@x402/core`, `ethers`)
- `/packages/x402-private-vela-fixed/tsconfig.json`
- `/packages/contracts/package.json` — Hardhat project (hardhat, @openzeppelin/contracts, typechain)
- `/packages/contracts/hardhat.config.ts`
- `/packages/contracts/tsconfig.json`
**Acceptance**: `pnpm install` succeeds. `pnpm --filter contracts exec hardhat compile` runs (no contracts yet).

---

### Task 1: Mock Structs & Interfaces (Solidity)
**Scope**: Extended Solidity data structures based on vela's [`Structs.sol`](https://github.com/HorizenOfficial/vela/blob/main/contracts/contracts/Structs.sol). Add `facilitator`, `tokenAddress`, `assetAmount` to PendingRequest. Add simplified interfaces (ITeeAuthenticator, IAuthorityRegistry). Token allowlists are global only (no per-app allowlists).
**Dependencies**: Task 0
**Files**:
- `/packages/contracts/contracts/Structs.sol`
- `/packages/contracts/contracts/MockTeeAuthenticator.sol` (based on [`MockTeeAuthenticator.sol`](https://github.com/HorizenOfficial/vela/blob/main/contracts/contracts/mocks/MockTeeAuthenticator.sol))
- `/packages/contracts/contracts/MockAuthorityRegistry.sol`
**Acceptance**: `hardhat compile` succeeds.

---

### Task 2: MockEIP2612Token (Solidity)
**Scope**: ERC-20 token implementing EIP-2612 `permit`. Includes:
- Standard ERC-20 (mint, transfer, balanceOf, approve, transferFrom)
- `permit(owner, spender, value, deadline, v, r, s)` with EIP-712 signature verification
- `nonces(owner)` sequential nonce tracking (as per EIP-2612)
- `DOMAIN_SEPARATOR()` for EIP-712 domain
- `mint(to, amount)` for test setup
**Dependencies**: Task 0
**Files**:
- `/packages/contracts/contracts/MockEIP2612Token.sol`
**Acceptance**: Compiles. Unit test confirms `permit` + `transferFrom` works with valid sig and rejects invalid/replayed sig.

---

### Task 3: MockProcessorEndpoint (Solidity)
**Scope**: Main mock contract implementing the "future" ProcessorEndpoint with facilitator support as described in FACILITATOR.md.
**Dependencies**: Task 1, Task 2
**Key functions**:
- `submitRequest()` — existing direct path (ETH-only, simplified)
- `submitRequestFor(sender, ...)` — facilitator path: verify request type is supported (ASSOCIATEKEY or PROCESS only), verify deadline, read nonce from `facilitatorNonces[sender]` (nonce is NOT a calldata parameter), build EIP-712 hash, recover user from sig, verify recovered == sender, consume nonce, execute EIP-2612 permit + transferFrom, create PendingRequest(sender=user, facilitator=msg.sender), emit event. `depositPermit` param is `abi.encode(uint8 v, bytes32 r, bytes32 s)`.
- `facilitatorNonces` mapping + `getFacilitatorNonce(address)`
- `simulateProcessing(requestId, newStateRoot, refund, applicationFees, errorCode)` — processes head request as if TEE had, with split claim routing
- `claim(tokenAddress, payee)` — permissionless claim for both ETH and ERC-20
- `addAllowedToken(tokenAddress)` — simplified global token allowlist (no per-app allowlists)
- EIP-712 domain separator (name: "Vela") + REQUEST_AUTHORIZATION_TYPEHASH (includes `sender` field)
- `RequestAuthorization` struct: `{ sender, protocolVersion, applicationId, requestType, payloadHash, tokenAddress, assetAmount, nonce, deadline }`
**Files**:
- `/packages/contracts/contracts/MockProcessorEndpoint.sol`
**Acceptance**: Compiles. All functions callable.

---

### Task 4: Mock Infrastructure (Anvil + Deploy)
**Scope**: TypeScript utilities to manage Anvil lifecycle and deploy mock contracts.
**Dependencies**: Task 3
**Files**:
- `/mock/anvil.ts` — `startAnvil()`, `stopAnvil()`, `waitForReady()`. Returns RPC URL + pre-funded accounts.
- `/mock/deploy.ts` — `deployContracts(provider)`. Deploys MockProcessorEndpoint + MockEIP2612Token. Returns typed contract instances (from typechain). Sets up initial state (deploy app, allow token, mint tokens to test users).
- `/mock/simulate.ts` — `simulateProcessing(contract, requestId, opts)`. Calls `simulateProcessing()` on mock contract.
**Acceptance**: Programmatically starts Anvil, deploys contracts, and returns usable instances.

---

### Task 5: Scheme Types (`@horizen/x402-private-vela-fixed`)
**Scope**: TypeScript type definitions for the Vela payment scheme.
**Dependencies**: Task 0
**Files**:
- `/packages/x402-private-vela-fixed/src/types.ts`:
  - `RequestAuthorization` — EIP-712 typed data fields (sender, protocolVersion, applicationId, requestType, payloadHash, tokenAddress, assetAmount, nonce, deadline)
  - `DepositPermit` — EIP-2612 fields (owner, spender, value, nonce, deadline) + signature components (v, r, s)
  - `VelaPaymentPayload` — scheme-specific payload (sender, requestSignature, depositPermit, requestAuthorization, payload)
  - `VelaSchemeConfig` — config for scheme (rpcUrl, contractAddress, signerPrivateKey, maxFeeValue)
  - EIP-712 domain constants (name: "Vela", version, chainId, verifyingContract) + REQUEST_AUTHORIZATION_TYPEHASH
**Acceptance**: Types compile and are importable.

---

### Task 6: Scheme Verify (`@horizen/x402-private-vela-fixed`)
**Scope**: Off-chain signature validation logic. Verifies both EIP-712 request authorization and EIP-2612 deposit permit without submitting on-chain.
**Dependencies**: Task 5
**Files**:
- `/packages/x402-private-vela-fixed/src/verify.ts`:
  - Verify request type is supported (ASSOCIATEKEY or PROCESS)
  - Verify deadline not expired
  - Recover signer from EIP-712 request authorization signature → check matches declared `sender`
  - Verify payloadHash matches keccak256(payload)
  - Read nonce from on-chain `facilitatorNonces[sender]` and verify it matches the signed nonce
  - If assetAmount > 0: verify EIP-2612 permit signature (recover signer, check owner/spender/value/deadline match)
  - Return `VerifyResponse` (from `@x402/core`)
**Acceptance**: Unit tests for valid + invalid signatures.

---

### Task 7: Scheme Settle (`@horizen/x402-private-vela-fixed`)
**Scope**: On-chain settlement — calls `submitRequestFor()` on the ProcessorEndpoint contract.
**Dependencies**: Task 5
**Files**:
- `/packages/x402-private-vela-fixed/src/settle.ts`:
  - Re-verify signatures off-chain (call verify first)
  - Encode `submitRequestFor(sender, ...)` call with all params (nonce is NOT passed — contract reads it from chain). `depositPermit` is `abi.encode(v, r, s)` when assetAmount > 0, empty otherwise.
  - Send transaction with `msg.value = maxFeeValue` (from scheme config)
  - Wait for receipt
  - Extract `requestId` from `RequestSubmitted` event
  - Return `SettleResponse` (from `@x402/core`) with txHash, network, payer
**Acceptance**: Callable against Anvil (tested in Task 13).

---

### Task 8: Scheme Class + Registration Helper
**Scope**: Wire verify + settle into `SchemeNetworkFacilitator` implementation and provide registration helper.
**Dependencies**: Task 6, Task 7
**Files**:
- `/packages/x402-private-vela-fixed/src/scheme.ts`:
  - `PrivateVelaFixedScheme implements SchemeNetworkFacilitator`
  - `scheme = "private-vela-fixed"`
  - `caipFamily = "eip155:*"`
  - `getExtra(network)` → undefined (or could include contract address)
  - `getSigners(network)` → facilitator wallet address
  - `verify()` → delegates to verify.ts
  - `settle()` → delegates to settle.ts
- `/packages/x402-private-vela-fixed/src/register.ts`:
  - `registerPrivateVelaFixedScheme(facilitator: x402Facilitator, config: VelaSchemeConfig): x402Facilitator`
  - Creates `PrivateVelaFixedScheme` instance, registers with `facilitator.register(network, scheme)`
- `/packages/x402-private-vela-fixed/src/index.ts` — public exports
**Acceptance**: Scheme can be instantiated and registered on an x402Facilitator. Uses EIP-2612 for deposit authorization.

---

### Task 9: Facilitator Server + x402 Routes
**Scope**: Express.js HTTP server that creates an `x402Facilitator` from `@x402/core` and registers our scheme. Exposes standard x402 endpoints.
**Dependencies**: Task 8
**Files**:
- `/src/config.ts` — Configuration: RPC URL, contract address, facilitator private key, maxFeeValue, network (e.g., `eip155:2651420`), port
- `/src/index.ts` — Express app setup:
  - Create `x402Facilitator` from `@x402/core`
  - Call `registerPrivateVelaFixedScheme(facilitator, config)` to register our scheme
  - Mount routes, middleware (JSON, CORS, error handling)
- `/src/routes/x402.ts` — Standard x402 endpoints:
  - `GET /supported` → `facilitator.getSupported()`
  - `POST /verify` → `facilitator.verify(paymentPayload, paymentRequirements)` (uses EIP-2612 permit verification)
  - `POST /settle` → `facilitator.settle(paymentPayload, paymentRequirements)` (calls `submitRequestFor` with EIP-2612 permit)
**Acceptance**: Server starts and `/supported` returns scheme info.

---

### Task 10: Core Facilitation Routes
**Scope**: Non-x402 endpoint for direct facilitator usage (mobile SDK, CLI, bots). Note: nonce queries are NOT part of the facilitator API — clients read `facilitatorNonces[user]` directly from the `ProcessorEndpoint` contract (public mapping with auto-generated getter).
**Dependencies**: Task 9
**Files**:
- `/src/routes/submit.ts` — `POST /submit`:
  - Accepts: `{ sender, protocolVersion, applicationId, requestType, payload, tokenAddress, assetAmount, deadline, requestSignature, depositPermit }` (no nonce param — contract reads it from chain)
  - Only allows `ASSOCIATEKEY` and `PROCESS` request types
  - Wraps into x402 PaymentPayload format internally, delegates to scheme's settle logic
  - Returns: `{ requestId, txHash }`
**Acceptance**: Endpoint responds correctly (tested in Task 12).

---

### Task 11: Test Setup + Helpers
**Scope**: Shared test infrastructure: Anvil lifecycle, contract deployment, user signing helpers.
**Dependencies**: Task 4, Task 5
**Files**:
- `/test/setup.ts` — Vitest globalSetup: start Anvil, deploy contracts, mint tokens, create facilitator service, expose fixtures (contract addresses, RPC URL, server URL)
- `/test/helpers/signer.ts` — `TestUser` class:
  - Creates ethers Wallet
  - `signRequestAuthorization(params)` → EIP-712 signature (includes `sender` field, nonce read from chain)
  - `signDepositPermit(params)` → EIP-2612 permit signature (v, r, s)
  - `buildSubmitPayload(params)` → full payload ready for POST /submit
  - `buildX402Payload(params)` → full x402 PaymentPayload ready for POST /settle
**Acceptance**: Setup starts Anvil, deploys contracts, provides ready-to-use fixtures.

---

### Task 12: Core Integration Tests
**Scope**: Tests for POST /submit.
**Dependencies**: Task 10, Task 11
**Files**:
- `/test/core/submit.test.ts`:
  - Submit with `assetAmount > 0` (ERC-20 deposit via EIP-2612 permit) → PendingRequest created with correct sender (user) and facilitator
  - Submit with `assetAmount = 0` → works without deposit permit
  - Expired deadline → rejected
  - Invalid EIP-712 signature (wrong sender) → rejected
  - Invalid EIP-2612 permit signature → rejected on-chain
  - Unsupported request type → rejected
  - Nonce increments after successful submit (verified via on-chain `facilitatorNonces[user]`)
  - Nonce independent from direct `submitRequest` calls
**Acceptance**: All tests pass.

---

### Task 13: x402 Integration Tests
**Scope**: Tests for POST /verify, POST /settle, GET /supported.
**Dependencies**: Task 9, Task 11
**Files**:
- `/test/x402/verify.test.ts`:
  - Valid payload → `{ isValid: true }`
  - Invalid signature → `{ isValid: false, invalidReason: ... }`
  - Expired deadline → `{ isValid: false }`
  - Wrong nonce → `{ isValid: false }`
- `/test/x402/settle.test.ts`:
  - Valid settle → creates on-chain request, returns `{ success: true, transaction, network }`
  - Invalid payload → settle fails with error
  - `/supported` returns correct scheme info
**Acceptance**: All tests pass.

---

### Task 14: End-to-End Flow Test
**Scope**: Full lifecycle test covering the complete facilitator flow.
**Dependencies**: Task 12, Task 13
**Files**:
- `/test/e2e/full-flow.test.ts`:
  1. User queries `facilitatorNonces[user]` directly from contract → nonce = 0
  2. User signs EIP-712 + EIP-2612 permit for a PROCESS request with ERC-20 deposit
  3. Facilitator receives `POST /submit` → returns `{ requestId, txHash }`
  4. Verify on-chain: PendingRequest has sender = user, facilitator = facilitator address
  5. Call `simulateProcessing()` → request completed successfully
  6. User claims asset refund via `claim(tokenAddress, user)`
  7. Facilitator claims ETH fee refund via `claim(address(0), facilitator)`
  8. Error case: simulateProcessing with error → user gets deposit back, facilitator gets partial fee refund
  9. ASSOCIATEKEY flow: assetAmount = 0, no EIP-2612 permit needed
  10. x402 flow: same lifecycle but via POST /verify + POST /settle
**Acceptance**: All tests pass, demonstrating the complete facilitator lifecycle.

---

### Task 15: Documentation (README files)
**Scope**: Three README.md files documenting the project.
**Dependencies**: Task 10 (routes finalized), Task 8 (scheme finalized)
**Files**:
- `/README.md` — Project overview:
  - What vela-facilitator is and the problem it solves (gasless submission)
  - Architecture diagram (core layer + x402 layer + scheme package)
  - Project structure overview (monorepo layout)
  - Getting started (prerequisites, install, build, run dev, run tests)
  - Configuration (environment variables / config options)
  - Link to FACILITATOR.md design doc
- `/src/README.md` — API reference:
  - All endpoints with request/response JSON schemas:
    - `GET /supported` — returns supported schemes/networks
    - `POST /verify` — x402 off-chain verification
    - `POST /settle` — x402 on-chain settlement
    - `POST /submit` — core gasless submission (non-x402)
  - Note: nonce queries are done directly on-chain by clients (no facilitator endpoint)
  - Full curl examples for each endpoint
  - Example full flow walkthrough (read nonce from contract → sign → submit → verify result)
  - Error responses and status codes
- `/packages/x402-private-vela-fixed/README.md` — Scheme package docs:
  - What the package provides
  - How to register the scheme in an x402Facilitator (with code example)
  - Note on EIP-2612 vs EIP-3009 compatibility with Coinbase reference facilitator
  - Exported types and interfaces
  - EIP-712 domain and type definitions
**Acceptance**: All three READMEs are clear, accurate, and include working examples.

## Key Technical Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| x402 integration | Use `@x402/core` `x402Facilitator` + custom scheme | Follows Coinbase pattern; uses EIP-2612 instead of EIP-3009, so own verify/settle logic needed |
| Scheme package | Separate `@horizen/x402-private-vela-fixed` in monorepo | Publishable independently; custom verify/settle via `submitRequestFor()` |
| Deposit authorization | EIP-2612 (`permit`) | More widely adopted than EIP-3009; sequential nonces; sufficient security for our use case |
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

## Verification

After all tasks are complete:
```bash
pnpm install                                              # Dependencies
pnpm --filter contracts exec hardhat compile              # Contracts compile
pnpm --filter @horizen/x402-private-vela-fixed run build  # Scheme package builds
pnpm test                                                 # All integration + e2e tests pass
pnpm dev                                                  # Service starts, curl /supported works
```
