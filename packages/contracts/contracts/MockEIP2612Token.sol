// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/**
 * @title MockEIP2612Token
 * @notice ERC-20 token implementing EIP-2612 permit for gasless approvals.
 * Implements sequential nonces as per EIP-2612 specification.
 */
contract MockEIP2612Token is ERC20 {
    // EIP-712 domain separator
    bytes32 public immutable DOMAIN_SEPARATOR;

    // EIP-2612 permit typehash
    bytes32 public constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    // EIP-2612 sequential nonces per owner
    mapping(address => uint256) private _nonces;

    constructor(string memory name, string memory symbol) ERC20(name, symbol) {
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(name)),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    /**
     * @notice Mint tokens to an address (for test setup)
     */
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /**
     * @notice Returns the current nonce for an owner (EIP-2612)
     */
    function nonces(address owner) external view returns (uint256) {
        return _nonces[owner];
    }

    /**
     * @notice EIP-2612 permit: approve by signature
     * @param owner Token owner
     * @param spender Approved spender
     * @param value Amount to approve
     * @param deadline Signature expiry
     * @param v Signature v
     * @param r Signature r
     * @param s Signature s
     */
    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        require(block.timestamp <= deadline, "MockEIP2612Token: permit expired");

        bytes32 structHash = keccak256(
            abi.encode(PERMIT_TYPEHASH, owner, spender, value, _nonces[owner], deadline)
        );

        bytes32 hash = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));

        address signer = ECDSA.recover(hash, v, r, s);
        require(signer == owner, "MockEIP2612Token: invalid permit signature");

        _nonces[owner]++;
        _approve(owner, spender, value);
    }
}
