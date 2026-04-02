import { ethers } from "ethers";
import { encrypt, generateKeyPair, importPublicKeyFromHex } from "@horizen/vela-common-ts";
import {
  REQUEST_TYPE_PROCESS,
  REQUEST_TYPE_ASSOCIATEKEY,
  EIP712_DOMAIN_NAME,
  EIP712_DOMAIN_VERSION,
  REQUEST_AUTHORIZATION_TYPEHASH,
  type VelaPaymentPayload,
  type DepositPermit,
  type RequestAuthorization,
  type SupportedRequestType,
  type PayloadInstructions,
} from "../../packages/x402-private-vela-fixed/src/types.js";
// ABI fragments for on-chain reads
const ENDPOINT_ABI = [
  "function facilitatorNonces(address) view returns (uint256)",
];

const TOKEN_ABI = [
  "function nonces(address) view returns (uint256)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function allowance(address, address) view returns (uint256)",
];

export interface TestUserConfig {
  wallet: ethers.Wallet;
  provider: ethers.JsonRpcProvider;
  contractAddress: string;
  tokenAddress: string;
  chainId: number;
  teePublicKeyHex: string; // hex string of TEE's P-521 public key
}

/**
 * TestUser: helper for building signed test payloads.
 * Handles EIP-712 + EIP-2612 signing and payload encryption.
 */
export class TestUser {
  readonly wallet: ethers.Wallet;
  private readonly provider: ethers.JsonRpcProvider;
  private readonly contractAddress: string;
  private readonly tokenAddress: string;
  private readonly chainId: number;
  private readonly teePublicKeyHex: string;

  constructor(config: TestUserConfig) {
    this.wallet = config.wallet.connect(config.provider);
    this.provider = config.provider;
    this.contractAddress = config.contractAddress;
    this.tokenAddress = config.tokenAddress;
    this.chainId = config.chainId;
    this.teePublicKeyHex = config.teePublicKeyHex;
  }

  get address(): string {
    return this.wallet.address;
  }

  /**
   * Read the current facilitator nonce for this user from chain
   */
  async getFacilitatorNonce(): Promise<bigint> {
    const endpoint = new ethers.Contract(this.contractAddress, ENDPOINT_ABI, this.provider);
    return endpoint.facilitatorNonces(this.wallet.address);
  }

  /**
   * Build the EIP-712 domain separator for the ProcessorEndpoint contract
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
   * Sign an EIP-712 RequestAuthorization
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
    const applicationId = params.applicationId ?? 1n;
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
   * Sign an EIP-2612 permit
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

  /**
   * Encrypt a JSON payload with the TEE's P-521 public key using real ECIES.
   */
  async encryptPayload(plaintext: Uint8Array): Promise<Uint8Array> {
    const buyerKeyPair = await generateKeyPair();
    const teePublicKey = await importPublicKeyFromHex(this.teePublicKeyHex);
    return encrypt(buyerKeyPair.privateKey, teePublicKey, plaintext);
  }

  /**
   * Build a vela-nova transfer payload and encrypt it
   */
  async buildTransferPayload(params: {
    to: string;
    amount: string;
    invoice_id?: string;
    asset: string;
  }): Promise<Uint8Array> {
    const instructions: PayloadInstructions = {
      type: "transfer",
      transfer: {
        to: params.to,
        amount: params.amount,
        invoice_id: params.invoice_id ?? "",
        asset: params.asset
      },
    };
    const plaintext = new TextEncoder().encode(JSON.stringify(instructions));
    return this.encryptPayload(plaintext);
  }

  /**
   * Build a full POST /submit payload
   */
  async buildSubmitPayload(params: {
    requestType: SupportedRequestType;
    payload: Uint8Array;
    tokenAddress?: string;
    assetAmount?: bigint;
    to?: string;
    invoiceId?: string;
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
      applicationId: Number(authorization.applicationId),
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

  /**
   * Build an x402 PaymentPayload for the facilitator
   */
  async buildX402Payload(params: {
    requirements: import("@x402/core/types").PaymentRequirements;
    x402Version?: number;
  }): Promise<import("@x402/core/types").PaymentPayload> {
    const req = params.requirements;
    const assetAmount = BigInt(req.amount);
    const tokenAddress = assetAmount > 0n ? this.tokenAddress : ethers.ZeroAddress;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);

    const invoiceId = (req.extra as Record<string, string>)?.invoiceId ?? "";
    const payloadBytes = await this.buildTransferPayload({
      to: req.payTo,
      amount: req.amount,
      invoice_id: invoiceId,
      asset: tokenAddress
    });

    const payloadHex = ethers.hexlify(payloadBytes);
    const payloadHash = ethers.keccak256(payloadBytes);

    const { signature: requestSignature, authorization } = await this.signRequestAuthorization({
      requestType: REQUEST_TYPE_PROCESS,
      payloadHash,
      tokenAddress,
      assetAmount,
      deadline,
    });

    let depositPermit: DepositPermit | null = null;
    if (assetAmount > 0n) {
      depositPermit = await this.signDepositPermit({
        spender: this.contractAddress,
        value: assetAmount,
        deadline,
      });
    }

    const velaPayload: VelaPaymentPayload = {
      sender: this.wallet.address,
      requestSignature,
      depositPermit,
      requestAuthorization: authorization,
      payload: payloadHex,
    };

    return {
      x402Version: params.x402Version ?? 2,
      accepted: req,
      payload: velaPayload as unknown as Record<string, unknown>,
    };
  }
}

/**
 * Create a TestUser from a test account and fixtures
 */
export function createTestUser(
  privateKey: string,
  fixtures: import("../setup.js").TestFixtures
): TestUser {
  const provider = new ethers.JsonRpcProvider(fixtures.rpcUrl);
  const wallet = new ethers.Wallet(privateKey);

  return new TestUser({
    wallet,
    provider,
    contractAddress: fixtures.contracts.processorEndpoint.address,
    tokenAddress: fixtures.contracts.token.address,
    chainId: fixtures.chainId,
    teePublicKeyHex: fixtures.teePublicKeyHex,
  });
}
