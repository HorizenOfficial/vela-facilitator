import { ethers } from "ethers";
import type { VerifyResponse } from "@x402/core/types";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import {
  REQUEST_TYPE_PROCESS,
  REQUEST_TYPE_ASSOCIATEKEY,
  EIP712_DOMAIN_NAME,
  EIP712_DOMAIN_VERSION,
  REQUEST_AUTHORIZATION_TYPEHASH,
  VelaPaymentPayload,
  VelaSchemeConfig,
} from "./types";

/**
 * Off-chain verification of a VelaPaymentPayload.
 * Verifies:
 * 1. Request type is ASSOCIATEKEY or PROCESS
 * 2. Deadline is not expired
 * 3. EIP-712 request authorization signature recovers to the declared sender
 * 4. payloadHash matches keccak256(payload)
 * 5. On-chain nonce matches the signed nonce
 * 6. If assetAmount > 0: EIP-2612 permit signature is valid
 */
export async function verifyPayment(
  paymentPayload: PaymentPayload,
  requirements: PaymentRequirements,
  config: VelaSchemeConfig
): Promise<VerifyResponse> {
  try {
    const velaPayload = paymentPayload.payload as unknown as VelaPaymentPayload;

    const { sender, requestSignature, depositPermit, requestAuthorization } = velaPayload;

    // 1. Validate request type
    const rt = requestAuthorization.requestType;
    if (rt !== REQUEST_TYPE_PROCESS && rt !== REQUEST_TYPE_ASSOCIATEKEY) {
      return { isValid: false, invalidReason: "unsupported request type" };
    }

    // 2. Check deadline
    const now = Math.floor(Date.now() / 1000);
    if (Number(requestAuthorization.deadline) < now) {
      return { isValid: false, invalidReason: "deadline expired" };
    }

    // 3. Recover signer from EIP-712 request authorization signature
    const provider = new ethers.JsonRpcProvider(config.rpcUrl);

    const domainSeparator = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "bytes32", "bytes32", "uint256", "address"],
        [
          ethers.keccak256(ethers.toUtf8Bytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")),
          ethers.keccak256(ethers.toUtf8Bytes(EIP712_DOMAIN_NAME)),
          ethers.keccak256(ethers.toUtf8Bytes(EIP712_DOMAIN_VERSION)),
          (await provider.getNetwork()).chainId,
          config.contractAddress,
        ]
      )
    );

    const payloadBytes = ethers.getBytes(velaPayload.payload);
    const payloadHash = ethers.keccak256(payloadBytes);

    // 4. Verify payloadHash matches
    if (payloadHash.toLowerCase() !== requestAuthorization.payloadHash.toLowerCase()) {
      return { isValid: false, invalidReason: "payload hash mismatch" };
    }

    const structHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        [
          "bytes32",
          "address",
          "uint8",
          "uint64",
          "uint8",
          "bytes32",
          "address",
          "uint256",
          "uint256",
          "uint256",
        ],
        [
          ethers.keccak256(ethers.toUtf8Bytes(REQUEST_AUTHORIZATION_TYPEHASH)),
          requestAuthorization.sender,
          requestAuthorization.protocolVersion,
          requestAuthorization.applicationId,
          requestAuthorization.requestType,
          requestAuthorization.payloadHash,
          requestAuthorization.tokenAddress,
          requestAuthorization.assetAmount,
          requestAuthorization.nonce,
          requestAuthorization.deadline,
        ]
      )
    );

    const digest = ethers.keccak256(
      ethers.concat([ethers.toUtf8Bytes("\x19\x01"), domainSeparator, structHash])
    );

    const recoveredSender = ethers.recoverAddress(digest, requestSignature);
    if (recoveredSender.toLowerCase() !== sender.toLowerCase()) {
      return { isValid: false, invalidReason: "invalid request authorization signature" };
    }

    // 5. Read on-chain nonce and verify
    const endpointAbi = [
      "function facilitatorNonces(address) view returns (uint256)",
    ];
    const endpoint = new ethers.Contract(config.contractAddress, endpointAbi, provider);
    const onChainNonce: bigint = await endpoint.facilitatorNonces(sender);

    if (onChainNonce !== BigInt(requestAuthorization.nonce)) {
      return { isValid: false, invalidReason: "invalid nonce" };
    }

    // 6. If assetAmount > 0, verify EIP-2612 permit signature
    if (BigInt(requestAuthorization.assetAmount) > 0n) {
      if (!depositPermit) {
        return { isValid: false, invalidReason: "deposit permit required for assetAmount > 0" };
      }

      const tokenAbi = [
        "function DOMAIN_SEPARATOR() view returns (bytes32)",
        "function nonces(address) view returns (uint256)",
      ];
      const tokenContract = new ethers.Contract(
        requestAuthorization.tokenAddress,
        tokenAbi,
        provider
      );

      const tokenDomainSeparator: string = await tokenContract.DOMAIN_SEPARATOR();
      const tokenNonce: bigint = await tokenContract.nonces(depositPermit.owner);

      const permitTypehash = ethers.keccak256(
        ethers.toUtf8Bytes(
          "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
        )
      );

      const permitStructHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["bytes32", "address", "address", "uint256", "uint256", "uint256"],
          [
            permitTypehash,
            depositPermit.owner,
            depositPermit.spender,
            depositPermit.value,
            tokenNonce,
            depositPermit.deadline,
          ]
        )
      );

      const permitDigest = ethers.keccak256(
        ethers.concat([
          ethers.toUtf8Bytes("\x19\x01"),
          tokenDomainSeparator,
          permitStructHash,
        ])
      );

      const permitSig = ethers.Signature.from({
        v: depositPermit.v,
        r: depositPermit.r,
        s: depositPermit.s,
      });

      const recoveredOwner = ethers.recoverAddress(permitDigest, permitSig);
      if (recoveredOwner.toLowerCase() !== depositPermit.owner.toLowerCase()) {
        return { isValid: false, invalidReason: "invalid deposit permit signature" };
      }
    }

    return { isValid: true, payer: sender };
  } catch (err) {
    return {
      isValid: false,
      invalidReason: "verification error",
      invalidMessage: err instanceof Error ? err.message : String(err),
    };
  }
}
