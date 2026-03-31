# vela-facilitator — Implementation Plan

> See `ARCHITECTURE.md` for project architecture, structure, and technical decisions.

## Task 0: Project Scaffolding
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

## Task 1: Mock Structs & Interfaces (Solidity)
**Scope**: Extended Solidity data structures based on vela's [`Structs.sol`](https://github.com/HorizenOfficial/vela/blob/main/contracts/contracts/Structs.sol). Add `facilitator`, `tokenAddress`, `assetAmount` to PendingRequest. Add simplified interfaces (ITeeAuthenticator, IAuthorityRegistry). Token allowlists are global only (no per-app allowlists).
**Dependencies**: Task 0
**Files**:
- `/packages/contracts/contracts/Structs.sol`
- `/packages/contracts/contracts/MockTeeAuthenticator.sol` (based on [`MockTeeAuthenticator.sol`](https://github.com/HorizenOfficial/vela/blob/main/contracts/contracts/mocks/MockTeeAuthenticator.sol))
- `/packages/contracts/contracts/MockAuthorityRegistry.sol`
**Acceptance**: `hardhat compile` succeeds.

---

## Task 2: MockEIP2612Token (Solidity)
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

## Task 3: MockProcessorEndpoint (Solidity)
**Scope**: Main mock contract implementing the "future" ProcessorEndpoint with facilitator support as described in [FACILITATOR.md](https://github.com/HorizenOfficial/vela/blob/main/docs/design/FACILITATOR.md).
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

## Task 4: Mock Infrastructure (Anvil + Deploy)
**Scope**: TypeScript utilities to manage Anvil lifecycle and deploy mock contracts.
**Dependencies**: Task 3
**Files**:
- `/mock/anvil.ts` — `startAnvil()`, `stopAnvil()`, `waitForReady()`. Returns RPC URL + pre-funded accounts.
- `/mock/deploy.ts` — `deployContracts(provider)`. Deploys MockProcessorEndpoint + MockEIP2612Token. Returns typed contract instances (from typechain). Sets up initial state (deploy app, allow token, mint tokens to test users).
- `/mock/simulate.ts` — `simulateProcessing(contract, requestId, opts)`. Calls `simulateProcessing()` on mock contract.
**Acceptance**: Programmatically starts Anvil, deploys contracts, and returns usable instances.

---

## Task 5: Scheme Types (`@horizen/x402-private-vela-fixed`)
**Scope**: TypeScript type definitions for the Vela payment scheme.
**Dependencies**: Task 0
**Files**:
- `/packages/x402-private-vela-fixed/src/types.ts`:
  - `RequestAuthorization` — EIP-712 typed data fields (sender, protocolVersion, applicationId, requestType, payloadHash, tokenAddress, assetAmount, nonce, deadline)
  - `DepositPermit` — EIP-2612 fields (owner, spender, value, nonce, deadline) + signature components (v, r, s)
  - `VelaPaymentPayload` — scheme-specific payload (sender, requestSignature, depositPermit, requestAuthorization, payload)
  - `VelaPaymentRequirementsExtra` — scheme-specific extra fields in `PaymentRequirements`: `{ invoiceId }`. The `invoiceId` (required, max 100 chars) lets the seller identify and correlate the payment; the client must include it in the vela-nova transfer payload as `invoice_id`. Note: `applicationId` (always `1`, vela-nova) and `requestType` (always `PROCESS`) are constants of the scheme, not parameters.
  - `VelaSchemeConfig` — config for scheme (rpcUrl, contractAddress, signerPrivateKey, maxFeeValue)
  - Scheme constants: `VELA_NOVA_APPLICATION_ID = 1`, `REQUEST_TYPE_PROCESS = 1` — hardcoded in the scheme, not configurable
  - vela-nova payload types: `TransferInstruction { to, amount, invoice_id }`, `PayloadInstructions { type: "transfer", transfer }` — these represent the JSON payload that gets encrypted before submission
  - EIP-712 domain constants (name: "Vela", version, chainId, verifyingContract) + REQUEST_AUTHORIZATION_TYPEHASH
**Acceptance**: Types compile and are importable.

---

## Task 6: Scheme Verify (`@horizen/x402-private-vela-fixed`)
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
  - If `PaymentRequirements.extra.invoiceId` is present: verify the payload contains a matching `invoice_id` in the transfer instruction (required for x402 flow — seller must be able to identify the payment)
  - Return `VerifyResponse` (from `@x402/core`)
**Acceptance**: Unit tests for valid + invalid signatures.

---

## Task 7: Scheme Settle (`@horizen/x402-private-vela-fixed`)
**Scope**: On-chain settlement — calls `submitRequestFor()` on the ProcessorEndpoint contract. Note: a successful settle confirms on-chain submission, not TEE completion (see ARCHITECTURE.md "Settle Semantics").
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

## Task 8: Scheme Class + Registration Helper
**Scope**: Wire verify + settle into `SchemeNetworkFacilitator` implementation and provide registration helper.
**Dependencies**: Task 6, Task 7
**Files**:
- `/packages/x402-private-vela-fixed/src/scheme.ts`:
  - `PrivateVelaFixedScheme implements SchemeNetworkFacilitator`
  - `scheme = "private-vela-fixed"`
  - `caipFamily = "eip155:*"`
  - `getExtra(network)` → `{ invoiceId }` (scheme-specific PaymentRequirements extra; `applicationId = 1` and `requestType = PROCESS` are hardcoded constants of the scheme)
  - `getSigners(network)` → facilitator wallet address
  - `verify()` → delegates to verify.ts
  - `settle()` → delegates to settle.ts
- `/packages/x402-private-vela-fixed/src/register.ts`:
  - `registerPrivateVelaFixedScheme(facilitator: x402Facilitator, config: VelaSchemeConfig): x402Facilitator`
  - Creates `PrivateVelaFixedScheme` instance, registers with `facilitator.register(network, scheme)`
- `/packages/x402-private-vela-fixed/src/index.ts` — public exports
**Acceptance**: Scheme can be instantiated and registered on an x402Facilitator. Uses EIP-2612 for deposit authorization.

---

## Task 9: Facilitator Server + x402 Routes
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

## Task 10: Core Facilitation Routes
**Scope**: Non-x402 endpoint for direct facilitator usage (mobile SDK, CLI, bots). Unlike the x402 scheme (which targets vela-nova specifically), `/submit` is **application-agnostic** — it forwards any `ASSOCIATEKEY` or `PROCESS` request to any application on the chain. Note: nonce queries are NOT part of the facilitator API — clients read `facilitatorNonces[user]` directly from the `ProcessorEndpoint` contract (public mapping with auto-generated getter).
**Dependencies**: Task 9
**Files**:
- `/src/routes/submit.ts` — `POST /submit`:
  - Accepts: `{ sender, protocolVersion, applicationId, requestType, payload, tokenAddress, assetAmount, deadline, requestSignature, depositPermit }` (no nonce param — contract reads it from chain)
  - Only allows `ASSOCIATEKEY` and `PROCESS` request types
  - Wraps into x402 PaymentPayload format internally, delegates to scheme's settle logic
  - Returns: `{ requestId, txHash }`
**Acceptance**: Endpoint responds correctly (tested in Task 12).

---

## Task 11: Test Setup + Helpers
**Scope**: Shared test infrastructure: Anvil lifecycle, contract deployment, user signing helpers.
**Dependencies**: Task 4, Task 5
**Files**:
- `/test/setup.ts` — Vitest globalSetup: start Anvil, deploy contracts, mint tokens, create facilitator service, expose fixtures (contract addresses, RPC URL, server URL)
- `/test/helpers/signer.ts` — `TestUser` class:
  - Creates ethers Wallet + P-521 key pair (for vela-nova key registration)
  - `signRequestAuthorization(params)` → EIP-712 signature (includes `sender` field, nonce read from chain)
  - `signDepositPermit(params)` → EIP-2612 permit signature (v, r, s)
  - `buildAssociateKeyPayload()` → ASSOCIATEKEY payload with raw P-521 public key bytes (133 bytes, unencrypted)
  - `buildTransferPayload(params)` → vela-nova PROCESS transfer payload: `{ type: "transfer", transfer: { to, amount, invoice_id } }` (in tests, payload is passed as plaintext since we don't have a real TEE; the mock contract doesn't decrypt)
  - `buildSubmitPayload(params)` → full payload ready for POST /submit
  - `buildX402Payload(params)` → full x402 PaymentPayload ready for POST /settle
**Acceptance**: Setup starts Anvil, deploys contracts, provides ready-to-use fixtures.

---

## Task 12: Core Integration Tests
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

## Task 13: x402 Integration Tests
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

## Task 14: End-to-End Flow Test
**Scope**: Full lifecycle test covering the complete facilitator flow, including vela-nova specific flows with key registration and invoiceId.
**Dependencies**: Task 12, Task 13
**Files**:
- `/test/e2e/full-flow.test.ts`:

  **Core /submit flow (application-agnostic):**
  1. Register buyer's P-521 key: `POST /submit` with `requestType = ASSOCIATEKEY`, `assetAmount = 0`, payload = raw P-521 public key bytes (133 bytes). No EIP-2612 permit needed.
  2. Register seller's P-521 key: same ASSOCIATEKEY flow for the seller address.
  3. Buyer queries `facilitatorNonces[buyer]` directly from contract → verify nonce incremented after registrations.
  4. Buyer signs EIP-712 + EIP-2612 permit for a PROCESS transfer request with ERC-20 deposit. Payload is a vela-nova transfer instruction: `{ type: "transfer", transfer: { to: seller, amount, invoice_id: "INV-001" } }`.
  5. Facilitator receives `POST /submit` → returns `{ requestId, txHash }`.
  6. Verify on-chain: PendingRequest has sender = buyer, facilitator = facilitator address.
  7. Call `simulateProcessing()` → request completed successfully.
  8. Buyer claims asset refund via `claim(tokenAddress, buyer)`.
  9. Facilitator claims ETH fee refund via `claim(address(0), facilitator)`.
  10. Error case: simulateProcessing with error → buyer gets deposit back, facilitator gets partial fee refund.

  **x402 flow (vela-nova private transfer with invoiceId):**
  11. (Keys already registered from steps 1-2.)
  12. Build `PaymentRequirements` with `extra: { invoiceId: "INV-002" }` (applicationId and requestType are scheme constants — always vela-nova PROCESS).
  13. Build vela-nova transfer payload with `invoice_id: "INV-002"`, sign EIP-712 + EIP-2612.
  14. `POST /verify` with payload + requirements → `{ isValid: true }`.
  15. `POST /settle` with payload + requirements → submits on-chain → returns `{ success: true, txHash, requestId }`. Note: this confirms on-chain submission, not TEE completion (async).
  16. Verify on-chain: PendingRequest created correctly.
  17. Verify invoiceId mismatch: `POST /verify` with `extra.invoiceId: "INV-002"` but payload `invoice_id: "WRONG"` → `{ isValid: false }`.

**Acceptance**: All tests pass, demonstrating the complete facilitator lifecycle including vela-nova key registration prerequisites, invoiceId validation, and async settle semantics.

Note: the resource server (seller) is **not** part of the facilitator and is **not** tested here. The seller is responsible for: returning 402 with PaymentRequirements, calling our verify/settle endpoints, and waiting for the vela-nova encrypted event with `invoice_id` to confirm payment completion.

---

## Task 15: Documentation (README files)
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
