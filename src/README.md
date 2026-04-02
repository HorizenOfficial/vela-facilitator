# vela-facilitator

Gasless request submission service for the Vela blockchain platform. Accepts signed EIP-712 requests from clients and submits them on-chain via `submitRequestFor()` on the `ProcessorEndpoint` contract, covering gas on their behalf. Also implements the `private-vela-fixed` x402 payment scheme for the [vela-nova](https://github.com/HorizenOfficial/vela-nova) private transfer app.

---

# Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `RPC_URL` | yes | — | Ethereum JSON-RPC endpoint |
| `FACILITATOR_PRIVATE_KEY` | yes | — | Private key of the facilitator wallet (pays gas) |
| `PROCESSOR_ENDPOINT_ADDRESS` | yes | — | Address of the `ProcessorEndpoint` contract |
| `CHAIN_ID` | yes | — | EVM chain ID (e.g. `2651420`) |
| `PORT` | no | `3000` | HTTP server port |
| `MAX_FEE_VALUE` | no | `50` | Maximum fee the facilitator pays per request (in base units) |
| `VELA_NOVA_APPLICATION_ID` | no | `1` | Application ID forwarded in x402 settle calls |

---

# API Reference

Base URL: `http://<host>:<PORT>` (default port: `3000`)

---

## GET /supported

Returns the list of supported x402 payment schemes and networks.

**Request**: no body

**Response** `200 OK`:
```json
{
  "schemes": [
    {
      "scheme": "private-vela-fixed",
      "network": "eip155:2651420"
    }
  ]
}
```

**Example**:
```bash
curl http://localhost:3000/supported
```

---

## POST /verify

Verifies an x402 payment payload off-chain (no transaction). Checks the EIP-712 signature, deadline, nonce, and permit validity.

**Request body**:
```json
{
  "paymentPayload": {
    "x402Version": 2,
    "accepted": { ... },
    "payload": {
      "sender": "0xUSER_ADDRESS",
      "requestSignature": "0x...",
      "depositPermit": { "v": 27, "r": "0x...", "s": "0x..." },
      "requestAuthorization": {
        "sender": "0xUSER_ADDRESS",
        "protocolVersion": 0,
        "applicationId": "1",
        "requestType": 1,
        "payloadHash": "0x...",
        "tokenAddress": "0xTOKEN_ADDRESS",
        "assetAmount": "1000000",
        "nonce": "0",
        "deadline": "1711929600"
      },
      "payload": "0xENCRYPTED_PAYLOAD_HEX"
    }
  },
  "paymentRequirements": {
    "scheme": "private-vela-fixed",
    "network": "eip155:2651420",
    "asset": "0xTOKEN_ADDRESS",
    "amount": "1000000",
    "payTo": "0xSELLER_ADDRESS",
    "maxTimeoutSeconds": 300,
    "extra": { "invoiceId": "INV-001" }
  }
}
```

**Response** `200 OK` (valid):
```json
{ "isValid": true }
```

**Response** `200 OK` (invalid):
```json
{ "isValid": false, "invalidReason": "deadline expired" }
```

**Example**:
```bash
curl -X POST http://localhost:3000/verify \
  -H "Content-Type: application/json" \
  -d '{ "paymentPayload": {...}, "paymentRequirements": {...} }'
```

---

## POST /settle

Settles an x402 payment on-chain by calling `submitRequestFor()` on the `ProcessorEndpoint` contract. Settlement is **asynchronous** — a successful response means the transaction was submitted, not that the TEE has processed it.

**Request body**: same shape as `/verify`

**Response** `200 OK`:
```json
{
  "success": true,
  "transaction": "0xTX_HASH",
  "network": "eip155:2651420",
  "payer": "0xUSER_ADDRESS",
  "extensions": {
    "requestId": "0xREQUEST_ID"
  }
}
```

**Response** `402 Payment Required` (invalid payment):
```json
{ "error": "deadline expired" }
```

**Example**:
```bash
curl -X POST http://localhost:3000/settle \
  -H "Content-Type: application/json" \
  -d '{ "paymentPayload": {...}, "paymentRequirements": {...} }'
```

---

## POST /submit

Application-agnostic facilitator endpoint for direct clients (mobile SDK, CLI, bots). Accepts signed `ASSOCIATEKEY` or `PROCESS` requests and submits them on-chain.

Unlike `/settle`, this endpoint does not require the full x402 payment protocol. Clients sign EIP-712 `RequestAuthorization` directly and submit.

**Nonce**: clients read `facilitatorNonces[senderAddress]` directly from the contract before signing. The facilitator does not provide a nonce endpoint.

**Request body**:
```json
{
  "sender": "0xUSER_ADDRESS",
  "protocolVersion": 0,
  "applicationId": 1,
  "requestType": 3,
  "payload": "0xPAYLOAD_HEX",
  "tokenAddress": "0x0000000000000000000000000000000000000000",
  "assetAmount": "0",
  "deadline": "1711929600",
  "requestSignature": "0xEIP712_SIGNATURE",
  "depositPermit": null
}
```

Fields:
- `requestType`: `1` = `PROCESS`, `3` = `ASSOCIATEKEY`
- `payload`: hex-encoded bytes
  - For `ASSOCIATEKEY`: raw 133-byte P-521 uncompressed public key (`0x04 || x || y`)
  - For `PROCESS`: ECIES-encrypted `PayloadInstructions` JSON (see [vela-nova payload format](https://github.com/HorizenOfficial/vela-nova))
- `tokenAddress`: ERC-20 address, or `address(0)` if `assetAmount = 0`
- `assetAmount`: token amount in base units (as string)
- `depositPermit`: EIP-2612 permit `{ v, r, s }` — required when `assetAmount > 0`, `null` otherwise

**Response** `200 OK`:
```json
{ "requestId": "0xREQUEST_ID" }
```

**Response** `400 Bad Request`:
```json
{ "error": "Missing required fields" }
```

**Response** `500 Internal Server Error`:
```json
{ "error": "POST /submit error: <message>" }
```

**Example: ASSOCIATEKEY (no deposit)**:
```bash
# First read current nonce from chain:
# cast call $PROCESSOR_ENDPOINT "facilitatorNonces(address)(uint256)" $USER_ADDRESS

curl -X POST http://localhost:3000/submit \
  -H "Content-Type: application/json" \
  -d '{
    "sender": "0xUSER",
    "protocolVersion": 0,
    "applicationId": 1,
    "requestType": 3,
    "payload": "0x04040404...133bytes",
    "tokenAddress": "0x0000000000000000000000000000000000000000",
    "assetAmount": "0",
    "deadline": "1711929600",
    "requestSignature": "0x...",
    "depositPermit": null
  }'
```

**Example: PROCESS with ERC-20 deposit**:
```bash
curl -X POST http://localhost:3000/submit \
  -H "Content-Type: application/json" \
  -d '{
    "sender": "0xUSER",
    "protocolVersion": 0,
    "applicationId": 1,
    "requestType": 1,
    "payload": "0xENCRYPTED_PAYLOAD",
    "tokenAddress": "0xTOKEN_ADDRESS",
    "assetAmount": "1000000000000000000",
    "deadline": "1711929600",
    "requestSignature": "0x...",
    "depositPermit": { "v": 27, "r": "0x...", "s": "0x..." }
  }'
```

---

## EIP-712 signing

All requests use EIP-712 typed data signing. The domain and type hash:

**Domain**:
```json
{
  "name": "Vela",
  "version": "1",
  "chainId": <CHAIN_ID>,
  "verifyingContract": "<PROCESSOR_ENDPOINT_ADDRESS>"
}
```

**RequestAuthorization type**:
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

**DepositPermit** (EIP-2612 `Permit` type, signed against the token contract's domain):
```
Permit(address owner, address spender, uint256 value, uint256 nonce, uint256 deadline)
```

---

## Error responses

| Status | Meaning |
|---|---|
| `200` | Success |
| `400` | Bad request (missing/invalid fields, unsupported request type) |
| `402` | Payment required (invalid x402 payment) |
| `500` | Internal server error (on-chain call failed) |
