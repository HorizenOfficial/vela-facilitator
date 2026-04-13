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
| `RPC_URL` | yes | | Ethereum JSON-RPC endpoint |
| `FACILITATOR_PRIVATE_KEY` | yes | | Hex private key of the facilitator wallet (pays gas) |
| `PROCESSOR_ENDPOINT_ADDRESS` | yes | | `ProcessorEndpoint` contract address |
| `CHAIN_ID` | yes | | EVM chain ID |
| `MAX_FEE_VALUE` | no | `50` | ETH in wei sent as `msg.value` for service fees |
| `VELA_NOVA_APPLICATION_ID` | no | `1` | vela-nova application ID for x402 payments |
| `PORT` | no | `3000` | HTTP server port |

If you have started the vela dev local environment you can also use the .env.dev instead, with values already set for it.

## Standalone Docker build (without Compose)

```bash
# From the repository root
docker build -f dockerfiles/Dockerfile -t vela-facilitator .
docker run --env-file dockerfiles/.env -p 3000:3000 vela-facilitator
```

## Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/supported` | Supported x402 schemes and networks |
| `POST` | `/verify` | Off-chain payment signature verification |
| `POST` | `/settle` | On-chain settlement via `submitRequestFor()` |
| `POST` | `/submit` | Application-agnostic gasless request submission |
