// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./Structs.sol";

// Minimal EIP-2612 permit interface
interface IERC20Permit {
    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;

    function nonces(address owner) external view returns (uint256);
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

/**
 * @title MockProcessorEndpoint
 * @notice Mock contract implementing the "future" ProcessorEndpoint with facilitator support.
 * Based on the design described in https://github.com/HorizenOfficial/vela/blob/main/docs/design/FACILITATOR.md
 *
 * Key features:
 * - submitRequest(): direct path for users with ETH
 * - submitRequestFor(): facilitator path with EIP-712 request authorization + EIP-2612 deposit permit
 * - EIP-712 domain (name: "Vela") for request authorization signatures
 * - Global token allowlist for ERC-20 deposits
 * - Per-user facilitator nonces (independent from direct submitRequest calls)
 */
contract MockProcessorEndpoint is ReentrancyGuard {
    // -------------------------------------------------------------------------
    // Constants
    // -------------------------------------------------------------------------

    uint8 public constant PROTOCOL_VERSION = 0;

    // EIP-712 domain separator
    bytes32 public immutable DOMAIN_SEPARATOR;

    // REQUEST_AUTHORIZATION_TYPEHASH includes sender for facilitator authorization
    bytes32 public constant REQUEST_AUTHORIZATION_TYPEHASH = keccak256(
        "RequestAuthorization(address sender,uint8 protocolVersion,uint64 applicationId,uint8 requestType,bytes32 payloadHash,address tokenAddress,uint256 assetAmount,uint256 nonce,uint256 deadline)"
    );

    // -------------------------------------------------------------------------
    // State variables
    // -------------------------------------------------------------------------

    address public owner;

    // Application registry: applicationId => deployed (simplified)
    mapping(uint64 => bool) public deployedApplications;

    // Requests
    mapping(bytes32 => Structs.PendingRequest) public requestById;

    // Facilitator nonces: user address => nonce (independent from direct submitRequest)
    mapping(address => uint256) public facilitatorNonces;

    // Global token allowlist
    mapping(address => bool) public globalAllowedTokens;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event RequestSubmitted(
        bytes32 indexed requestId,
        address indexed sender,
        address indexed facilitator,
        uint64 applicationId,
        Structs.RequestType requestType
    );

    event ApplicationDeployed(uint64 indexed applicationId);

    event TokenAllowed(address indexed tokenAddress);

    event TokenDisallowed(address indexed tokenAddress);

    // -------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------

    error InvalidRequestType();
    error InvalidProtocolVersion();
    error ApplicationNotDeployed();
    error InvalidValue();
    error InvalidSignature();
    error DeadlineExpired();
    error InvalidNonce();
    error TokenNotAllowed();
    error InvalidPermit();
    error TransferFailed();
    error NotOwner();

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    constructor() {
        owner = msg.sender;

        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("Vela")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    // -------------------------------------------------------------------------
    // Admin functions
    // -------------------------------------------------------------------------

    /**
     * @notice Deploy an application (simplified mock — just registers the applicationId)
     */
    function deployApplication(uint64 applicationId) external onlyOwner {
        deployedApplications[applicationId] = true;
        emit ApplicationDeployed(applicationId);
    }

    /**
     * @notice Add a token to the global allowlist for ERC-20 deposits
     */
    function addAllowedToken(address tokenAddress) external onlyOwner {
        globalAllowedTokens[tokenAddress] = true;
        emit TokenAllowed(tokenAddress);
    }

    /**
     * @notice Remove a token from the global allowlist
     */
    function removeAllowedToken(address tokenAddress) external onlyOwner {
        globalAllowedTokens[tokenAddress] = false;
        emit TokenDisallowed(tokenAddress);
    }

    // -------------------------------------------------------------------------
    // Nonce queries
    // -------------------------------------------------------------------------

    /**
     * @notice Get the current facilitator nonce for a user
     * @dev Clients read this directly rather than calling a facilitator API
     */
    function getFacilitatorNonce(address user) external view returns (uint256) {
        return facilitatorNonces[user];
    }

    // -------------------------------------------------------------------------
    // Direct submission (existing path)
    // -------------------------------------------------------------------------

    /**
     * @notice Submit a request directly (ETH only, simplified)
     * @dev The direct path does NOT increment facilitatorNonces
     */
    function submitRequest(
        uint8 protocolVersion,
        uint64 applicationId,
        Structs.RequestType requestType,
        bytes calldata payload,
        uint256 maxFeeValue
    ) external payable nonReentrant returns (bytes32) {
        if (protocolVersion != PROTOCOL_VERSION) revert InvalidProtocolVersion();
        if (!deployedApplications[applicationId]) revert ApplicationNotDeployed();
        if (requestType == Structs.RequestType.DEPLOYAPP || requestType == Structs.RequestType.DEANONYMIZATION) {
            revert InvalidRequestType();
        }
        if (msg.value != maxFeeValue) revert InvalidValue();

        bytes32 requestId = _generateRequestId(msg.sender, applicationId, requestType, payload);

        requestById[requestId] = Structs.PendingRequest({
            timestamp: block.timestamp,
            depositAmount: 0,
            maxFeeValue: maxFeeValue,
            requestId: requestId,
            payload: payload,
            sender: msg.sender,
            facilitator: address(0),
            tokenAddress: address(0),
            assetAmount: 0,
            applicationId: applicationId,
            protocolVersion: protocolVersion,
            requestType: requestType
        });

        emit RequestSubmitted(requestId, msg.sender, address(0), applicationId, requestType);
        return requestId;
    }

    // -------------------------------------------------------------------------
    // Facilitator submission path
    // -------------------------------------------------------------------------

    /**
     * @notice Submit a request on behalf of a user (facilitator path)
     * @dev Verifies EIP-712 request authorization signed by the user.
     *      Nonce is read from chain (NOT passed as parameter).
     *      If assetAmount > 0, handles ERC-20 deposit:
     *        - If current allowance >= assetAmount, skips permit and calls transferFrom directly
     *        - Otherwise calls permit then transferFrom
     *      depositPermit is abi.encode(v, r, s) when assetAmount > 0, empty bytes otherwise.
     *
     * @param sender The user who signed the request
     * @param protocolVersion Protocol version
     * @param applicationId Target application
     * @param requestType Request type (ASSOCIATEKEY or PROCESS only)
     * @param payload Encrypted request payload
     * @param tokenAddress ERC-20 token address (address(0) if no deposit)
     * @param assetAmount ERC-20 amount to deposit (0 if no deposit)
     * @param deadline Signature expiry timestamp
     * @param requestSignature EIP-712 request authorization signature
     * @param depositPermit ABI-encoded (v, r, s) for EIP-2612 permit, or empty bytes
     */
    function submitRequestFor(
        address sender,
        uint8 protocolVersion,
        uint64 applicationId,
        Structs.RequestType requestType,
        bytes calldata payload,
        address tokenAddress,
        uint256 assetAmount,
        uint256 deadline,
        bytes calldata requestSignature,
        bytes calldata depositPermit
    ) external payable nonReentrant returns (bytes32) {
        // Validate request type: only ASSOCIATEKEY and PROCESS allowed
        if (
            requestType != Structs.RequestType.ASSOCIATEKEY &&
            requestType != Structs.RequestType.PROCESS
        ) revert InvalidRequestType();

        if (protocolVersion != PROTOCOL_VERSION) revert InvalidProtocolVersion();
        if (!deployedApplications[applicationId]) revert ApplicationNotDeployed();

        // Check deadline
        if (block.timestamp > deadline) revert DeadlineExpired();

        // Read nonce from chain
        uint256 nonce = facilitatorNonces[sender];

        // Build and verify EIP-712 request authorization signature
        bytes32 payloadHash = keccak256(payload);
        bytes32 structHash = keccak256(
            abi.encode(
                REQUEST_AUTHORIZATION_TYPEHASH,
                sender,
                protocolVersion,
                applicationId,
                uint8(requestType),
                payloadHash,
                tokenAddress,
                assetAmount,
                nonce,
                deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));

        address recovered = _recoverSigner(digest, requestSignature);
        if (recovered != sender) revert InvalidSignature();

        // Consume nonce
        facilitatorNonces[sender]++;

        // Handle ERC-20 deposit if needed
        if (assetAmount > 0) {
            if (!globalAllowedTokens[tokenAddress]) revert TokenNotAllowed();

            IERC20 token = IERC20(tokenAddress);
            uint256 currentAllowance = token.allowance(sender, address(this));

            if (currentAllowance < assetAmount) {
                // Need to call permit first
                if (depositPermit.length == 0) revert InvalidPermit();
                (uint8 v, bytes32 r, bytes32 s) = abi.decode(depositPermit, (uint8, bytes32, bytes32));
                IERC20Permit(tokenAddress).permit(sender, address(this), assetAmount, deadline, v, r, s);
            }

            bool success = token.transferFrom(sender, address(this), assetAmount);
            if (!success) revert TransferFailed();
        }

        bytes32 requestId = _generateRequestId(sender, applicationId, requestType, payload);

        requestById[requestId] = Structs.PendingRequest({
            timestamp: block.timestamp,
            depositAmount: assetAmount,
            maxFeeValue: msg.value,
            requestId: requestId,
            payload: payload,
            sender: sender,
            facilitator: msg.sender,
            tokenAddress: tokenAddress,
            assetAmount: assetAmount,
            applicationId: applicationId,
            protocolVersion: protocolVersion,
            requestType: requestType
        });

        emit RequestSubmitted(requestId, sender, msg.sender, applicationId, requestType);
        return requestId;
    }

    // -------------------------------------------------------------------------
    // Internal helpers
    // -------------------------------------------------------------------------

    function _generateRequestId(
        address sender,
        uint64 applicationId,
        Structs.RequestType requestType,
        bytes calldata payload
    ) internal view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                sender,
                applicationId,
                requestType,
                keccak256(payload),
                block.timestamp,
                block.number,
                facilitatorNonces[sender]
            )
        );
    }

    function _recoverSigner(bytes32 digest, bytes calldata sig) internal pure returns (address) {
        require(sig.length == 65, "MockProcessorEndpoint: invalid signature length");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        return ecrecover(digest, v, r, s);
    }
}
