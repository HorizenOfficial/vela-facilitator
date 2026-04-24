import { ethers } from "ethers";
import { encrypt } from "@horizen/vela-common-ts";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import {
  REQUEST_TYPE_PROCESS,
  EIP712_DOMAIN_NAME,
  EIP712_DOMAIN_VERSION,
  REQUEST_AUTHORIZATION_TYPEHASH,
  VelaPaymentPayload,
  VelaPaymentRequirementsExtra,
  PayloadInstructions,
} from "./types.js";

// ABI fragments for on-chain reads
const ENDPOINT_ABI = [
  "function facilitatorNonces(address) view returns (uint256)",
];

const TOKEN_ABI = [
  "function nonces(address) view returns (uint256)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function name() view returns (string)",
];

export interface VelaClientConfig {
  signer: ethers.Signer;         // ethers.Signer (for EIP-712 + EIP-2612 signing)
  p521PrivateKey: CryptoKey;     // buyer's P-521 private key (for ECIES encryption)
  teePublicKey: CryptoKey;       // TEE's P-521 public key (to encrypt payload for TEE)
  rpcUrl: string;
  contractAddress: string;       // ProcessorEndpoint contract address
  applicationId?: bigint;        // vela-nova application ID (defaults to 1n)
  /**
   * If true, the settle will be a pure private-state transfer: no on-chain
   * token deposit is pulled from the buyer (assetAmount=0, no permit). The
   * buyer must have already deposited the required amount into their
   * vela-nova private balance via /submit beforehand.
   *
   * Default: false (the settle performs deposit+transfer in one tx).
   */
  skipOnchainDeposit?: boolean;
}

/**
 * Build and sign a VelaPaymentPayload from PaymentRequirements.
 * Handles all vela-nova specifics:
 * - Reads nonces from chain
 * - Builds and encrypts the transfer payload
 * - Signs EIP-712 request authorization
 * - Signs EIP-2612 permit
 */
export async function signPayment(
  x402Version: number,
  requirements: PaymentRequirements,
  config: VelaClientConfig,
  deadlineSeconds = 300 // 5 minutes from now
): Promise<PaymentPayload> {
  const provider = new ethers.JsonRpcProvider(config.rpcUrl);
  const signer = config.signer.connect(provider);
  const sender = await signer.getAddress();
  const network = await provider.getNetwork();
  const chainId = network.chainId;

  const extra = requirements.extra as unknown as VelaPaymentRequirementsExtra;
  const invoiceId = extra?.invoiceId ?? "";

  // 1. Read facilitator nonce from chain
  const endpoint = new ethers.Contract(config.contractAddress, ENDPOINT_ABI, provider);
  const nonce: bigint = await endpoint.facilitatorNonces(sender);

  const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineSeconds);
  const privateAmount = BigInt(requirements.amount);
  // On-chain assetAmount: 0 when the buyer has already deposited (skipOnchainDeposit),
  // else the full business amount (deposit+transfer in one settle).
  const assetAmount = config.skipOnchainDeposit ? 0n : privateAmount;
  // On-chain tokenAddress: must be ZeroAddress when assetAmount=0 (the ProcessorEndpoint
  // reverts with InvalidValue otherwise). Real token is used only when we're also
  // performing an on-chain deposit.
  const tokenAddress = assetAmount > 0n ? requirements.asset : ethers.ZeroAddress;

  // 2. Build vela-nova transfer payload
  // vela-nova TEE expects amount as a lowercase 0x-prefixed hex string
  const amountHex = "0x" + BigInt(requirements.amount).toString(16);
  const payloadInstructions: PayloadInstructions = {
    type: "transfer",
    transfer: {
      to: requirements.payTo,
      tokenAddress: requirements.asset,
      amount: amountHex,
      invoice_id: invoiceId,
    },
  };

  // 3. Encrypt payload with TEE's P-521 public key
  const plaintext = new TextEncoder().encode(JSON.stringify(payloadInstructions));
  const encrypted = await encrypt(config.p521PrivateKey, config.teePublicKey, plaintext);
  const payloadHex = ethers.hexlify(encrypted);
  const payloadHash = ethers.keccak256(encrypted);

  const applicationId = config.applicationId ?? 1n;

  // 4. Build EIP-712 domain separator
  const domainSeparator = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "bytes32", "bytes32", "uint256", "address"],
      [
        ethers.keccak256(ethers.toUtf8Bytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")),
        ethers.keccak256(ethers.toUtf8Bytes(EIP712_DOMAIN_NAME)),
        ethers.keccak256(ethers.toUtf8Bytes(EIP712_DOMAIN_VERSION)),
        chainId,
        config.contractAddress,
      ]
    )
  );

  const PROTOCOL_VERSION = 0;

  // 5. Sign EIP-712 request authorization
  const structHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      [
        "bytes32", "address", "uint8", "uint64", "uint8",
        "bytes32", "address", "uint256", "uint256", "uint256",
      ],
      [
        ethers.keccak256(ethers.toUtf8Bytes(REQUEST_AUTHORIZATION_TYPEHASH)),
        sender,
        PROTOCOL_VERSION,
        applicationId,
        REQUEST_TYPE_PROCESS,
        payloadHash,
        tokenAddress,
        assetAmount,
        nonce,
        deadline,
      ]
    )
  );

  const digest = ethers.keccak256(
    ethers.concat([ethers.toUtf8Bytes("\x19\x01"), domainSeparator, structHash])
  );

  // Use signingKey for raw EIP-712 signing (no Ethereum prefix)
  const requestSignatureRaw = (signer as ethers.Wallet).signingKey.sign(ethers.getBytes(digest));
  const requestSignatureHex = ethers.Signature.from(requestSignatureRaw).serialized;

  const velaPayload: VelaPaymentPayload = {
    sender,
    requestSignature: requestSignatureHex,
    depositPermit: null,
    requestAuthorization: {
      sender,
      protocolVersion: PROTOCOL_VERSION,
      applicationId,
      requestType: REQUEST_TYPE_PROCESS,
      payloadHash,
      tokenAddress,
      assetAmount,
      nonce,
      deadline,
    },
    payload: payloadHex,
  };

  // 6. Sign EIP-2612 permit if assetAmount > 0
  if (assetAmount > 0n) {
    const tokenContract = new ethers.Contract(tokenAddress, TOKEN_ABI, provider);
    const tokenNonce: bigint = await tokenContract.nonces(sender);
    const tokenDomainSeparator: string = await tokenContract.DOMAIN_SEPARATOR();

    const PERMIT_TYPEHASH = ethers.keccak256(
      ethers.toUtf8Bytes("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)")
    );

    const permitStructHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "address", "address", "uint256", "uint256", "uint256"],
        [PERMIT_TYPEHASH, sender, config.contractAddress, assetAmount, tokenNonce, deadline]
      )
    );

    const permitDigest = ethers.keccak256(
      ethers.concat([ethers.toUtf8Bytes("\x19\x01"), tokenDomainSeparator, permitStructHash])
    );

    const permitSigRaw = (signer as ethers.Wallet).signingKey.sign(ethers.getBytes(permitDigest));
    const permitSig = ethers.Signature.from(permitSigRaw);

    velaPayload.depositPermit = {
      owner: sender,
      spender: config.contractAddress,
      value: assetAmount,
      nonce: tokenNonce,
      deadline,
      v: permitSig.v,
      r: permitSig.r,
      s: permitSig.s,
    };
  }

  return {
    x402Version,
    resource: undefined,
    accepted: requirements,
    payload: velaPayload as unknown as Record<string, unknown>,
  };
}
