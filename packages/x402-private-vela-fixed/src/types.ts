import type { Signer } from "ethers";

// ============================================================================
// Request types (mirrors Solidity enum)
// ============================================================================

export const REQUEST_TYPE_PROCESS = 1 as const;   // Structs.RequestType.PROCESS
export const REQUEST_TYPE_ASSOCIATEKEY = 3 as const; // Structs.RequestType.ASSOCIATEKEY

export type SupportedRequestType =
  | typeof REQUEST_TYPE_PROCESS
  | typeof REQUEST_TYPE_ASSOCIATEKEY;

// ============================================================================
// EIP-712 domain constants
// ============================================================================

export const EIP712_DOMAIN_NAME = "Vela" as const;
export const EIP712_DOMAIN_VERSION = "0" as const;

export const REQUEST_AUTHORIZATION_TYPEHASH =
  "RequestAuthorization(address sender,uint8 protocolVersion,uint64 applicationId,uint8 requestType,bytes32 payloadHash,address tokenAddress,uint256 assetAmount,uint256 nonce,uint256 deadline)";

// ============================================================================
// Core data structures
// ============================================================================

/**
 * EIP-712 typed data for request authorization.
 * Signed by the user to authorize the facilitator to submit on their behalf.
 */
export interface RequestAuthorization {
  sender: string;          // user's Ethereum address
  protocolVersion: number;
  applicationId: bigint;
  requestType: SupportedRequestType;
  payloadHash: string;     // keccak256 of the payload bytes (hex string with 0x prefix)
  tokenAddress: string;    // ERC-20 token address (address(0) if no deposit)
  assetAmount: bigint;     // ERC-20 amount (0 if no deposit)
  nonce: bigint;           // facilitatorNonces[sender] at time of signing
  deadline: bigint;        // Unix timestamp
}

/**
 * EIP-2612 permit data for gasless ERC-20 approvals.
 * Signed by the user to allow the ProcessorEndpoint to transferFrom their tokens.
 */
export interface DepositPermit {
  owner: string;
  spender: string;
  value: bigint;
  nonce: bigint;   // ERC-20 token nonce (sequential, from token contract)
  deadline: bigint;
  // Signature components
  v: number;
  r: string;
  s: string;
}

/**
 * Full payment payload for the private-vela-fixed x402 scheme.
 * Stored in PaymentPayload.payload when the scheme is "private-vela-fixed".
 */
export interface VelaPaymentPayload {
  sender: string;                        // user's Ethereum address
  requestSignature: string;              // EIP-712 request authorization signature (65 bytes hex)
  depositPermit: DepositPermit | null;   // null when assetAmount = 0
  requestAuthorization: RequestAuthorization;
  payload: string;                       // encrypted payload as hex string (0x prefixed)
}

/**
 * Scheme-specific extra fields in PaymentRequirements.
 * Set by the seller in the 402 response.
 */
export interface VelaPaymentRequirementsExtra {
  invoiceId: string; // max 100 chars, for seller tracking via TEE events
}

/**
 * Configuration for the private-vela-fixed scheme (facilitator side).
 */
export interface VelaSchemeConfig {
  rpcUrl: string;
  contractAddress: string;   // ProcessorEndpoint contract address
  signer: Signer;            // ethers.Signer (facilitator wallet, pays gas + maxFeeValue)
  maxFeeValue: bigint;       // ETH in wei sent as msg.value for service fees
  applicationId: bigint;     // vela-nova application ID (from VELA_NOVA_APPLICATION_ID)
  network: string;           // CAIP-2 network identifier, e.g. "eip155:2651420"
}

// ============================================================================
// vela-nova payload types
// ============================================================================

/**
 * Transfer instruction for vela-nova private transfers.
 * This JSON is encrypted with the TEE's P-521 public key before submission.
 */
export interface TransferInstruction {
  to: string;              // recipient address
  tokenAddress?: string;   // token address (omit for ETH = 0x0)
  amount: string;          // hex Uint256 (e.g. "0x6f05b59d3b20000")
  invoice_id?: string;     // optional, max 100 chars, correlates payment to seller's invoice
}

/**
 * Withdraw instruction for vela-nova private withdrawals.
 * This JSON is encrypted with the TEE's P-521 public key before submission.
 */
export interface WithdrawInstruction {
  to: string;              // destination address (on-chain recipient)
  tokenAddress?: string;   // token address (omit for ETH = 0x0)
  amount: string;          // hex Uint256
}

/**
 * Full vela-nova payload instruction.
 * The payload submitted to the ProcessorEndpoint for a PROCESS request.
 */
export interface PayloadInstructions {
  type: "transfer" | "withdraw";
  transfer?: TransferInstruction;
  withdraw?: WithdrawInstruction;
}
