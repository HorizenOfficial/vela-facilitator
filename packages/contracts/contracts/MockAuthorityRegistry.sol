// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

interface IAuthorityRegistry {
    function isAuthorized(address account) external view returns (bool);
    function addAuthority(address account) external;
    function removeAuthority(address account) external;
}

contract MockAuthorityRegistry is IAuthorityRegistry {
    mapping(address => bool) private authorities;
    address public owner;

    constructor() {
        owner = msg.sender;
        authorities[msg.sender] = true;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "MockAuthorityRegistry: not owner");
        _;
    }

    function isAuthorized(address account) external view override returns (bool) {
        return authorities[account];
    }

    function addAuthority(address account) external override onlyOwner {
        authorities[account] = true;
    }

    function removeAuthority(address account) external override onlyOwner {
        authorities[account] = false;
    }
}
