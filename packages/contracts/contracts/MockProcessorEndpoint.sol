// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
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
    using SafeERC20 for IERC20;

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

    // Request counter used as index in generateRequestId (incremented on every submit)
    uint256 private _requestCount;

    // TEE simulation: one-shot AppEvent emission. Tests set `nextAppEventSubType` (and
    // optionally `nextAppEventData`) before calling submit*For(); the mock will emit
    // AppEvent in the same tx as a successful submission, mimicking the TEE stateUpdate
    // path. Reset to zero after emission. A zero subType means "no AppEvent emitted".
    bytes32 public nextAppEventSubType;
    bytes public nextAppEventData;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    // Matches the real IProcessorEndpoint.RequestSubmitted signature
    // (facilitator = address(0) for direct submitRequest calls).
    event RequestSubmitted(
        uint64 indexed applicationId,
        bytes32 indexed requestId,
        address indexed sender,
        address facilitator
    );

    // Matches the real ProcessorEndpoint AppEvent (unencrypted application-level events).
    event AppEvent(
        uint64 indexed applicationId,
        bytes32 indexed requestId,
        bytes32 indexed eventSubType,
        bytes data
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
    error InvalidPayload();
    error InvalidSignature();
    error DeadlineExpired();
    error InvalidNonce();
    error TokenNotAllowed();
    error InvalidPermit();
    error TransferFailed();
    error TransferAmountMismatch();
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
                // Must match the real ProcessorEndpoint and the TS client constants
                // (EIP712_DOMAIN_VERSION = "0", derived from PROTOCOL_VERSION).
                keccak256(bytes("0")),
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
    // TEE simulation (test helpers — not present on the real ProcessorEndpoint)
    // -------------------------------------------------------------------------

    /**
     * @notice Arm a one-shot AppEvent emission. The next successful submitRequest[For]
     *         will emit AppEvent(applicationId, requestId, eventSubType, data) in the
     *         same tx — simulating the TEE's stateUpdate path.
     *         Passing eventSubType = bytes32(0) disarms (no AppEvent is emitted).
     */
    function setNextAppEvent(bytes32 eventSubType, bytes calldata data) external {
        nextAppEventSubType = eventSubType;
        nextAppEventData = data;
    }

    /**
     * @notice Manually emit an AppEvent for an already-submitted request.
     *         Useful for tests that want to trigger TEE completion after the fact.
     */
    function emitAppEvent(
        uint64 applicationId,
        bytes32 requestId,
        bytes32 eventSubType,
        bytes calldata data
    ) external {
        emit AppEvent(applicationId, requestId, eventSubType, data);
    }

    function _maybeEmitQueuedAppEvent(uint64 applicationId, bytes32 requestId) internal {
        bytes32 subType = nextAppEventSubType;
        if (subType != bytes32(0)) {
            emit AppEvent(applicationId, requestId, subType, nextAppEventData);
            // One-shot: clear queued event so the next submission doesn't reuse it.
            nextAppEventSubType = bytes32(0);
            nextAppEventData = "";
        }
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
     * @notice Submit a request directly (ETH or ERC-20)
     * @dev The direct path does NOT increment facilitatorNonces.
     *      For ETH deposits: tokenAddress = address(0), msg.value = assetAmount + maxFeeValue.
     *      For ERC-20 deposits: tokenAddress = token address, msg.value = maxFeeValue only.
     *
     * @param protocolVersion Protocol version
     * @param applicationId Target application
     * @param requestType Request type (PROCESS, DEANONYMIZATION, or ASSOCIATEKEY)
     * @param payload Request payload
     * @param tokenAddress address(0) for ETH, ERC-20 token address otherwise
     * @param assetAmount Asset amount to deposit (0 for no deposit)
     * @param maxFeeValue ETH fee reserved for gas payment
     */
    function submitRequest(
        uint8 protocolVersion,
        uint64 applicationId,
        Structs.RequestType requestType,
        bytes calldata payload,
        address tokenAddress,
        uint256 assetAmount,
        uint256 maxFeeValue
    ) external payable nonReentrant returns (bytes32) {
        if (protocolVersion != PROTOCOL_VERSION) revert InvalidProtocolVersion();
        if (!deployedApplications[applicationId]) revert ApplicationNotDeployed();
        if (requestType == Structs.RequestType.DEPLOYAPP) revert InvalidRequestType();

        if (tokenAddress == address(0)) {
            // ETH deposit: msg.value must cover both the asset deposit and the fee
            if (msg.value != assetAmount + maxFeeValue) revert InvalidValue();
        } else {
            // ERC-20 deposit: msg.value covers fee only; token pulled via transferFrom
            if (msg.value != maxFeeValue) revert InvalidValue();
            if (assetAmount == 0) revert InvalidValue();
            if (!globalAllowedTokens[tokenAddress]) revert TokenNotAllowed();
            IERC20 token = IERC20(tokenAddress);
            uint256 balanceBefore = token.balanceOf(address(this));
            token.safeTransferFrom(msg.sender, address(this), assetAmount);
            uint256 received = token.balanceOf(address(this)) - balanceBefore;
            if (received != assetAmount) revert TransferAmountMismatch();
        }

        if (requestType == Structs.RequestType.ASSOCIATEKEY) {
            if (payload.length != 133 && payload.length != 226) revert InvalidPayload();
        }

        bytes32 requestId = _generateRequestId(msg.sender, applicationId, requestType, payload, tokenAddress, assetAmount, _requestCount);

        requestById[requestId] = Structs.PendingRequest({
            timestamp: block.timestamp,
            tokenAddress: tokenAddress,
            assetAmount: assetAmount,
            maxFeeValue: maxFeeValue,
            requestId: requestId,
            payload: payload,
            sender: msg.sender,
            facilitator: address(0),
            applicationId: applicationId,
            protocolVersion: protocolVersion,
            requestType: requestType
        });

        unchecked { _requestCount++; }

        emit RequestSubmitted(applicationId, requestId, msg.sender, address(0));
        _maybeEmitQueuedAppEvent(applicationId, requestId);
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

            token.safeTransferFrom(sender, address(this), assetAmount);
        }

        bytes32 requestId = _generateRequestId(sender, applicationId, requestType, payload, tokenAddress, assetAmount, _requestCount);

        requestById[requestId] = Structs.PendingRequest({
            timestamp: block.timestamp,
            tokenAddress: tokenAddress,
            assetAmount: assetAmount,
            maxFeeValue: msg.value,
            requestId: requestId,
            payload: payload,
            sender: sender,
            facilitator: msg.sender,
            applicationId: applicationId,
            protocolVersion: protocolVersion,
            requestType: requestType
        });

        unchecked { _requestCount++; }

        emit RequestSubmitted(applicationId, requestId, sender, msg.sender);
        _maybeEmitQueuedAppEvent(applicationId, requestId);
        return requestId;
    }

    // -------------------------------------------------------------------------
    // Internal helpers
    // -------------------------------------------------------------------------

    function _generateRequestId(
        address sender,
        uint64 applicationId,
        Structs.RequestType requestType,
        bytes calldata payload,
        address tokenAddress,
        uint256 assetAmount,
        uint256 idx
    ) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(sender, applicationId, requestType, payload, tokenAddress, assetAmount, idx)
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
