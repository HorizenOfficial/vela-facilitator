# @horizen/x402-private-vela-fixed

x402 payment scheme implementation for [Vela](https://github.com/HorizenOfficial/vela) private transfers. Implements the `private-vela-fixed` scheme for all three x402 roles: facilitator, client (buyer), and resource server (seller).

## What it provides

- **Facilitator**: verify and settle payments via `submitRequestFor()` on `ProcessorEndpoint`. `/settle` blocks until the TEE emits the matching `AppEvent` — a successful response is cryptographic proof that the transfer landed as specified.
- **Client**: build, sign, and encrypt transfer payloads (EIP-712 + EIP-2612 + P-521 ECIES)
- **Resource server**: configure `PaymentRequirements` with vela-nova `invoiceId` tracking
- **`computeTransferReceiptHash`**: helper that recomputes vela-nova's `AppEvent.eventSubType` hash, for off-facilitator monitoring.

## Installation

```bash
npm install @horizen/x402-private-vela-fixed @x402/core ethers
```

> Requires `@horizen/vela-common-ts` for client-side P-521 encryption.

---

## Facilitator usage

Register the scheme on an `x402Facilitator` instance from `@x402/core`:

```typescript
import { x402Facilitator } from "@x402/core/facilitator";
import { registerPrivateVelaFixedScheme } from "@horizen/x402-private-vela-fixed";
import { ethers } from "ethers";

const facilitator = new x402Facilitator();

registerPrivateVelaFixedScheme(facilitator, {
  rpcUrl: "https://rpc.vela.network",
  contractAddress: "0x<ProcessorEndpoint address>",
  signer: new ethers.Wallet(process.env.FACILITATOR_PRIVATE_KEY!),
  maxFeeValue: 0n,          // ETH in wei for service fees
  applicationId: 1n,        // vela-nova app ID
  network: "eip155:2651420",
  // Optional: how long `/settle` waits for the TEE AppEvent (defaults 2s / 60s).
  appEventPollIntervalMs: 2_000,
  appEventPollTimeoutMs: 60_000,
});
```

The facilitator will handle `POST /verify` and `POST /settle` for the `private-vela-fixed` scheme. On `/settle`, the facilitator submits the request on-chain and then polls for the TEE's `AppEvent` matching the computed receipt hash before returning success; on timeout it returns `errorReason: "tee_processing_timeout"` while still reporting the on-chain `requestId` in `extensions`.

### `VelaSchemeConfig`

| Field | Type | Description |
|---|---|---|
| `rpcUrl` | `string` | Ethereum JSON-RPC URL |
| `contractAddress` | `string` | `ProcessorEndpoint` contract address |
| `signer` | `ethers.Signer` | Facilitator wallet (pays gas) |
| `maxFeeValue` | `bigint` | ETH in wei sent as `msg.value` for service fees |
| `applicationId` | `bigint` | vela-nova application ID |
| `network` | `string` | CAIP-2 network (e.g. `"eip155:2651420"`) |
| `appEventPollIntervalMs` | `number?` | Poll interval for the TEE `AppEvent` (default `2000`) |
| `appEventPollTimeoutMs` | `number?` | Timeout before `/settle` returns `tee_processing_timeout` (default `60000`) |

---

## Client (buyer) usage

Register the scheme on an `x402Client` instance to enable automatic payment on 402 responses:

```typescript
import { x402Client } from "@x402/core/client";
import { registerPrivateVelaFixedClient } from "@horizen/x402-private-vela-fixed";
import { ethers } from "ethers";

const client = new x402Client("https://my-facilitator.example.com");

registerPrivateVelaFixedClient(client, {
  signer: buyerSigner,           // ethers.Signer for EIP-712 + EIP-2612
  p521PrivateKey: buyerP521Key,  // buyer's P-521 CryptoKey (from vela-common-ts)
  teePublicKey: teeP521Key,      // TEE's P-521 CryptoKey (from ProcessorEndpoint.getPubSecp521r1())
  rpcUrl: "https://rpc.vela.network",
  contractAddress: "0x<ProcessorEndpoint address>",
  network: "eip155:2651420",
});

// Automatically handles 402 responses:
const response = await client.fetch("https://seller.example.com/protected-content");
```

When the resource server returns a `402 Payment Required`, the client:
1. Reads the current nonce from `facilitatorNonces[sender]` on-chain
2. Builds the `PayloadInstructions` JSON: `{ type: "transfer", transfer: { to, amount, invoice_id } }`
3. Encrypts the payload with the TEE's P-521 public key using ECIES (via `@horizen/vela-common-ts`)
4. Signs the `RequestAuthorization` with EIP-712
5. Signs an EIP-2612 permit for the ERC-20 deposit
6. Retries the request with the payment payload in the `X-PAYMENT` header

### `VelaClientConfig`

| Field | Type | Description |
|---|---|---|
| `signer` | `ethers.Signer` | Buyer's Ethereum signer |
| `p521PrivateKey` | `CryptoKey` | Buyer's P-521 ECDH private key |
| `teePublicKey` | `CryptoKey` | TEE's P-521 ECDH public key |
| `rpcUrl` | `string` | Ethereum JSON-RPC URL |
| `contractAddress` | `string` | `ProcessorEndpoint` contract address |
| `network` | `string` | CAIP-2 network identifier |

---

## Resource server (seller) usage

Register the scheme on an `x402ResourceServer` to protect routes with payment requirements:

```typescript
import { x402ResourceServer } from "@x402/core/server";
import { registerPrivateVelaFixedServer } from "@horizen/x402-private-vela-fixed";

const facilitatorClient = /* fetch-based facilitator client */;
const resourceServer = new x402ResourceServer(facilitatorClient);

registerPrivateVelaFixedServer(resourceServer, {
  network: "eip155:2651420",
  payTo: "0x<seller address>",
  tokenAddress: "0x<ERC-20 token address>",
  contractAddress: "0x<ProcessorEndpoint address>",
});

// Express middleware example:
app.use("/paid-content", resourceServer.middleware({
  amount: "1000000",         // token units
  extra: { invoiceId: "INV-001" },  // seller tracks this via TEE events
}));
```

The seller configures an `invoiceId` per-route in `PaymentRequirements.extra`. The facilitator cannot verify it (payload is encrypted), so the seller checks the `invoice_id` in the TEE event emitted after the TEE processes the transfer.

### `VelaServerConfig`

| Field | Type | Description |
|---|---|---|
| `network` | `string` | CAIP-2 network identifier |
| `payTo` | `string` | Seller's Ethereum address |
| `tokenAddress` | `string` | ERC-20 token for payments |
| `contractAddress` | `string` | `ProcessorEndpoint` contract address |

---

## EIP-712 domain and types

**Domain**:
```
name: "Vela"
version: "0"
chainId: <chain ID>
verifyingContract: <ProcessorEndpoint address>
```

**RequestAuthorization type hash**:
```
RequestAuthorization(
  address sender,
  uint8 protocolVersion,
  uint64 applicationId,
  uint8 requestType,
  bytes32 payloadHash,
  address tokenAddress,
  uint256 assetAmount,
  uint256 nonce,
  uint256 deadline
)
```

**Request type constants**:
- `REQUEST_TYPE_PROCESS = 1` — private transfer
- `REQUEST_TYPE_ASSOCIATEKEY = 3` — P-521 key registration

---

## Exported types and interfaces

```typescript
// From "@horizen/x402-private-vela-fixed"

// EIP-712 typed data
interface RequestAuthorization { sender, protocolVersion, applicationId, requestType, payloadHash, tokenAddress, assetAmount, nonce, deadline }

// EIP-2612 permit
interface DepositPermit { owner, spender, value, nonce, deadline, v, r, s }

// Full x402 payment payload
interface VelaPaymentPayload { sender, requestSignature, depositPermit, requestAuthorization, payload }

// Payload sent to TEE (encrypted)
interface PayloadInstructions { type: "transfer"; transfer: TransferInstruction }
interface TransferInstruction { to, amount, invoice_id, asset }

// Config types
interface VelaSchemeConfig { ... }   // facilitator
interface VelaClientConfig { ... }   // buyer
interface VelaServerConfig { ... }   // seller
```

---

## Transfer receipt hash

`computeTransferReceiptHash` is a TypeScript port of the hash vela-nova emits as `AppEvent.eventSubType` when the TEE successfully processes a transfer with a non-empty `invoiceId`:

```
keccak256(
  uint32_be(len(invoiceId)) ||
  invoiceId                 ||
  sender        (20 bytes)  ||
  tokenAddress  (20 bytes)  ||
  amount        (32 bytes, big-endian zero-padded) ||
  recipient     (20 bytes)
)
```

Because the hash binds `invoiceId + sender + tokenAddress + amount + recipient`, a matching `AppEvent` is cryptographic proof that the TEE executed exactly that transfer. The facilitator uses this internally in `/settle`; sellers can use it to subscribe to the right `AppEvent` independently:

```typescript
import { computeTransferReceiptHash } from "@horizen/x402-private-vela-fixed";

const expected = computeTransferReceiptHash({
  invoiceId: "INV-001",
  sender: buyerAddress,
  tokenAddress,
  amount: 1_000_000n,
  recipient: sellerAddress,
});

// Subscribe via VelaClient.getAppEvents(fromBlock, toBlock, appId, requestId, expected)
```

## Compatibility note

This scheme uses EIP-2612 `permit()` for gasless ERC-20 approval (sequential nonces). Coinbase's reference x402 scheme uses EIP-3009 `transferWithAuthorization` instead. The two are not interchangeable — the `ProcessorEndpoint.submitRequestFor()` contract function specifically accepts EIP-2612 permit signatures, not EIP-3009.

## References

- [x402 protocol](https://x402.org) — Payment protocol specification
- [ProcessorEndpoint.sol](https://github.com/HorizenOfficial/vela/blob/main/contracts/contracts/ProcessorEndpoint.sol) — On-chain contract
- [vela-nova payload format](https://github.com/HorizenOfficial/vela-nova) — `PayloadInstructions` types
- [vela-starterkit](https://github.com/HorizenOfficial/vela-starterkit/blob/main/docs/2_private-transfer-app.md) — Private transfer app docs
