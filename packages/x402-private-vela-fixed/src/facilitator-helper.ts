import { ethers } from "ethers";
import { encrypt, generateKeyPair, importPublicKeyFromHex } from "@horizen/vela-common-ts";
import {
  EIP712_DOMAIN_NAME,
  EIP712_DOMAIN_VERSION,
  REQUEST_AUTHORIZATION_TYPEHASH,
  type DepositPermit,
  type RequestAuthorization,
  type SupportedRequestType,
  type PayloadInstructions,
} from "./types.js";
import type { PaymentRequirements, PaymentPayload } from "@x402/core/types";

// ABI fragments for on-chain reads
const ENDPOINT_ABI = [
  "function facilitatorNonces(address) view returns (uint256)",
];

const TOKEN_ABI = [
  "function nonces(address) view returns (uint256)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function allowance(address, address) view returns (uint256)",
];

export interface FacilitatorHelperConfig {
  wallet: ethers.Wallet;
  provider: ethers.JsonRpcProvider;
  contractAddress: string;
  tokenAddress: string;
  chainId: number;
  teePublicKeyHex: string;
  facilitatorUrl: string;
  applicationId?: bigint;
  buyerP521PrivateKey?: CryptoKey;  // buyer's registered P-521 key (for ECIES encryption)
}

export interface HttpResponse<T = Record<string, unknown>> {
  status: number;
  body: T;
}

/**
 * FacilitatorHelper: client library for interacting with a vela-facilitator server.
 * Handles EIP-712 + EIP-2612 signing, payload encryption, and HTTP calls.
 */
export class FacilitatorHelper {
  readonly wallet: ethers.Wallet;
  private readonly provider: ethers.JsonRpcProvider;
  private readonly contractAddress: string;
  private readonly tokenAddress: string;
  private readonly chainId: number;
  private readonly teePublicKeyHex: string;
  private readonly facilitatorUrl: string;
  private readonly applicationId: bigint;
  private readonly buyerP521PrivateKey?: CryptoKey;

  constructor(config: FacilitatorHelperConfig) {
    this.wallet = config.wallet.connect(config.provider);
    this.provider = config.provider;
    this.contractAddress = config.contractAddress;
    this.tokenAddress = config.tokenAddress;
    this.chainId = config.chainId;
    this.teePublicKeyHex = config.teePublicKeyHex;
    this.facilitatorUrl = config.facilitatorUrl;
    this.applicationId = config.applicationId ?? 1n;
    this.buyerP521PrivateKey = config.buyerP521PrivateKey;
  }

  get address(): string {
    return this.wallet.address;
  }

  // ---------------------------------------------------------------------------
  // HTTP
  // ---------------------------------------------------------------------------

  /**
   * Low-level POST to the facilitator server (via helper).
   * Handles BigInt serialization automatically.
   */
  async post<T = Record<string, unknown>>(path: string, body: unknown): Promise<HttpResponse<T>> {
    const res = await fetch(`${this.facilitatorUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body, (_key, value) =>
        typeof value === "bigint" ? value.toString() : value
      ),
    });
    return { status: res.status, body: await res.json() as T };
  }

  /**
   * Low-level GET to the facilitator server.
   */
  async get<T = Record<string, unknown>>(path: string): Promise<HttpResponse<T>> {
    const res = await fetch(`${this.facilitatorUrl}${path}`);
    return { status: res.status, body: await res.json() as T };
  }

  // ---------------------------------------------------------------------------
  // High-level API
  // ---------------------------------------------------------------------------

  /**
   * Submit a request to POST /submit.
   * Builds the signed payload and posts it in one call.
   */
  async submit(params: {
    requestType: SupportedRequestType;
    payload: Uint8Array;
    tokenAddress?: string;
    assetAmount?: bigint;
    applicationId?: bigint;
  }): Promise<HttpResponse> {
    const body = await this.buildSubmitPayload(params);
    return this.post("/submit", body);
  }

  /**
   * Verify a payment via POST /verify.
   */
  async verify(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<HttpResponse> {
    return this.post("/verify", { paymentPayload, paymentRequirements });
  }

  /**
   * Settle a payment via POST /settle.
   */
  async settle(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<HttpResponse> {
    return this.post("/settle", { paymentPayload, paymentRequirements });
  }

  /**
   * Query supported schemes via GET /supported.
   */
  async supported(): Promise<HttpResponse> {
    return this.get("/supported");
  }

  /**
   * Trigger a pending-claim release via POST /claim.
   * Calls `ProcessorEndpoint.claim(tokenAddress, payee)` on-chain (facilitator pays gas).
   * Permissionless: anyone can claim for any `payee` — funds always go to `payee`.
   * Returns `amount = "0"` when there was nothing pending.
   */
  async claim(params: { tokenAddress: string; payee: string }): Promise<HttpResponse> {
    return this.post("/claim", {
      tokenAddress: params.tokenAddress,
      payee: params.payee,
    });
  }

  // ---------------------------------------------------------------------------
  // On-chain reads
  // ---------------------------------------------------------------------------

  /**
   * Read the current facilitator nonce for this user from chain.
   */
  async getFacilitatorNonce(): Promise<bigint> {
    const endpoint = new ethers.Contract(this.contractAddress, ENDPOINT_ABI, this.provider);
    return endpoint.facilitatorNonces(this.wallet.address);
  }

  // ---------------------------------------------------------------------------
  // Signing
  // ---------------------------------------------------------------------------

  /**
   * Build the EIP-712 domain separator for the ProcessorEndpoint contract.
   */
  private getDomainSeparatorHash(): string {
    return ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "bytes32", "bytes32", "uint256", "address"],
        [
          ethers.keccak256(
            ethers.toUtf8Bytes(
              "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
            )
          ),
          ethers.keccak256(ethers.toUtf8Bytes(EIP712_DOMAIN_NAME)),
          ethers.keccak256(ethers.toUtf8Bytes(EIP712_DOMAIN_VERSION)),
          this.chainId,
          this.contractAddress,
        ]
      )
    );
  }

  /**
   * Sign an EIP-712 RequestAuthorization.
   */
  async signRequestAuthorization(params: {
    requestType: SupportedRequestType;
    payloadHash: string;
    tokenAddress?: string;
    assetAmount?: bigint;
    deadline?: bigint;
    nonce?: bigint;
    applicationId?: bigint;
  }): Promise<{ signature: string; authorization: RequestAuthorization }> {
    const nonce = params.nonce ?? (await this.getFacilitatorNonce());
    const deadline = params.deadline ?? BigInt(Math.floor(Date.now() / 1000) + 300);
    const tokenAddress = params.tokenAddress ?? ethers.ZeroAddress;
    const assetAmount = params.assetAmount ?? 0n;
    const applicationId = params.applicationId ?? this.applicationId;
    const PROTOCOL_VERSION = 0;

    const domainSeparator = this.getDomainSeparatorHash();

    const structHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        [
          "bytes32", "address", "uint8", "uint64", "uint8",
          "bytes32", "address", "uint256", "uint256", "uint256",
        ],
        [
          ethers.keccak256(ethers.toUtf8Bytes(REQUEST_AUTHORIZATION_TYPEHASH)),
          this.wallet.address,
          PROTOCOL_VERSION,
          applicationId,
          params.requestType,
          params.payloadHash,
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

    const sigRaw = this.wallet.signingKey.sign(ethers.getBytes(digest));
    const signature = ethers.Signature.from(sigRaw).serialized;

    const authorization: RequestAuthorization = {
      sender: this.wallet.address,
      protocolVersion: PROTOCOL_VERSION,
      applicationId,
      requestType: params.requestType,
      payloadHash: params.payloadHash,
      tokenAddress,
      assetAmount,
      nonce,
      deadline,
    };

    return { signature, authorization };
  }

  /**
   * Sign an EIP-2612 permit.
   */
  async signDepositPermit(params: {
    spender: string;
    value: bigint;
    deadline?: bigint;
  }): Promise<DepositPermit> {
    const deadline = params.deadline ?? BigInt(Math.floor(Date.now() / 1000) + 300);

    const tokenContract = new ethers.Contract(this.tokenAddress, TOKEN_ABI, this.provider);
    const tokenNonce: bigint = await tokenContract.nonces(this.wallet.address);
    const tokenDomainSeparator: string = await tokenContract.DOMAIN_SEPARATOR();

    const PERMIT_TYPEHASH = ethers.keccak256(
      ethers.toUtf8Bytes(
        "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
      )
    );

    const permitStructHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "address", "address", "uint256", "uint256", "uint256"],
        [PERMIT_TYPEHASH, this.wallet.address, params.spender, params.value, tokenNonce, deadline]
      )
    );

    const permitDigest = ethers.keccak256(
      ethers.concat([ethers.toUtf8Bytes("\x19\x01"), tokenDomainSeparator, permitStructHash])
    );

    const permitSigRaw = this.wallet.signingKey.sign(ethers.getBytes(permitDigest));
    const permitSig = ethers.Signature.from(permitSigRaw);

    return {
      owner: this.wallet.address,
      spender: params.spender,
      value: params.value,
      nonce: tokenNonce,
      deadline,
      v: permitSig.v,
      r: permitSig.r,
      s: permitSig.s,
    };
  }

  // ---------------------------------------------------------------------------
  // Payload building
  // ---------------------------------------------------------------------------

  /**
   * Encrypt a JSON payload with the TEE's P-521 public key using real ECIES.
   */
  async encryptPayload(plaintext: Uint8Array): Promise<Uint8Array> {
    const privateKey = this.buyerP521PrivateKey ?? (await generateKeyPair()).privateKey;
    const teePublicKey = await importPublicKeyFromHex(this.teePublicKeyHex);
    return encrypt(privateKey, teePublicKey, plaintext);
  }

  /**
   * Build a vela-nova transfer payload and encrypt it.
   */
  async buildTransferPayload(params: {
    to: string;
    amount: string;
    invoice_id?: string;
    tokenAddress?: string;
  }): Promise<Uint8Array> {
    // vela-nova TEE expects amount as a lowercase 0x-prefixed hex string
    const amountHex = "0x" + BigInt(params.amount).toString(16);
    const instructions: PayloadInstructions = {
      type: "transfer",
      transfer: {
        to: params.to,
        tokenAddress: params.tokenAddress,
        amount: amountHex,
        invoice_id: params.invoice_id,
      },
    };
    const plaintext = new TextEncoder().encode(JSON.stringify(instructions));
    return this.encryptPayload(plaintext);
  }

  /**
   * Build a vela-nova withdraw payload and encrypt it.
   */
  async buildWithdrawPayload(params: {
    to: string;
    amount: string;
    tokenAddress?: string;
  }): Promise<Uint8Array> {
    const amountHex = "0x" + BigInt(params.amount).toString(16);
    const instructions: PayloadInstructions = {
      type: "withdraw",
      withdraw: {
        to: params.to,
        tokenAddress: params.tokenAddress,
        amount: amountHex,
      },
    };
    const plaintext = new TextEncoder().encode(JSON.stringify(instructions));
    return this.encryptPayload(plaintext);
  }

  /**
   * Build a full POST /submit payload (without sending it).
   */
  async buildSubmitPayload(params: {
    requestType: SupportedRequestType;
    payload: Uint8Array;
    tokenAddress?: string;
    assetAmount?: bigint;
    applicationId?: bigint;
  }): Promise<Record<string, unknown>> {
    const payloadHash = ethers.keccak256(params.payload);
    const assetAmount = params.assetAmount ?? 0n;
    const tokenAddress = assetAmount > 0n ? params.tokenAddress ?? this.tokenAddress : ethers.ZeroAddress;

    const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
    const { signature: requestSignature, authorization } = await this.signRequestAuthorization({
      requestType: params.requestType,
      payloadHash,
      tokenAddress,
      assetAmount,
      deadline,
      applicationId: params.applicationId,
    });

    let depositPermit: DepositPermit | undefined;
    if (assetAmount > 0n) {
      depositPermit = await this.signDepositPermit({
        spender: this.contractAddress,
        value: assetAmount,
        deadline,
      });
    }

    return {
      sender: this.wallet.address,
      protocolVersion: authorization.protocolVersion,
      applicationId: String(authorization.applicationId),
      requestType: authorization.requestType,
      payload: ethers.hexlify(params.payload),
      tokenAddress: authorization.tokenAddress,
      assetAmount: String(assetAmount),
      deadline: String(deadline),
      requestSignature,
      depositPermit: depositPermit
        ? { v: depositPermit.v, r: depositPermit.r, s: depositPermit.s }
        : null,
    };
  }

}
