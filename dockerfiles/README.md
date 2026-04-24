# Docker setup for vela-facilitator

## Quick start

```bash
cd dockerfiles

# Create your .env from the template and fill in the required values
cp .env.template .env

# Build and run
docker compose up -d
```

## Configuration

Copy `.env.template` to `.env` and set the required variables:

| Variable | Required | Default | Description |
|---|---|---|---|
| `CHAIN_RPC_PROTOCOL` | yes | | Ethereum JSON-RPC protocol (e.g. `http`, `https`). |
| `CHAIN_RPC_ADDRESS` | yes | | Ethereum JSON-RPC host. |
| `CHAIN_RPC_PORT` | yes | | Ethereum JSON-RPC port. The chain ID is derived from the resulting URL at startup. |
| `FACILITATOR_PRIVATE_KEY` | yes | | Hex private key of the facilitator wallet (pays gas) |
| `CHAIN_PROCESSOR_ADDRESS` | yes | | `ProcessorEndpoint` contract address |
| `MAX_FEE_VALUE` | no | `50` | ETH in wei sent as `msg.value` for service fees |
| `VELA_NOVA_APPLICATION_ID` | no | `1` | vela-nova application ID for x402 payments |
| `PORT` | no | `3000` | HTTP server port |
| `APP_EVENT_POLL_INTERVAL_MS` | no | `2000` | How often `/settle` polls for the TEE `AppEvent` after submission |
| `APP_EVENT_POLL_TIMEOUT_MS` | no | `60000` | How long `/settle` waits before returning `tee_processing_timeout` |

If you have started the vela dev local environment you can also use the .env.dev instead, with values already set for it.

## Standalone Docker build (without Compose)

```bash
# From the repository root
docker build -f dockerfiles/Dockerfile -t vela-facilitator .
docker run --env-file dockerfiles/.env -p 3000:3000 vela-facilitator
```

## Smoke test

Once the container is up you can run a quick HTTP smoke test from the repo root:

```bash
pnpm dev:smoke
```

It hits `GET /supported`, `POST /submit` (ASSOCIATEKEY), `POST /verify`, and `POST /settle`. Defaults match the vela dev stack; override `FACILITATOR_URL`, `CHAIN_RPC_PROTOCOL`/`CHAIN_RPC_ADDRESS`/`CHAIN_RPC_PORT`, `CHAIN_PROCESSOR_ADDRESS`, etc. to target a different environment. See the [root README](../README.md#dev-smoke-test) and [`scripts/dev-smoke.ts`](../scripts/dev-smoke.ts) for details.

## Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | Landing page: runtime info + endpoint directory (HTML or JSON) |
| `GET` | `/supported` | Supported x402 schemes and networks |
| `POST` | `/verify` | Off-chain payment signature verification |
| `POST` | `/settle` | On-chain settlement via `submitRequestFor()`, blocks until the TEE emits the matching `AppEvent` |
| `POST` | `/submit` | Application-agnostic gasless request submission |
| `POST` | `/claim` | Permissionless claim of pending balances |
