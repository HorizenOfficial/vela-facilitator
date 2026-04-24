// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "./Structs.sol";

// Simplified ITeeAuthenticator interface for local use
interface ITeeAuthenticator {
    function checkSignature(
        Structs.SignatureParams memory params,
        bytes memory signature
    ) external view returns (bool);

    function getTeeSigner() external view returns (address);

    function getPubSecp521r1() external view returns (bytes memory);
}

// Based on https://github.com/HorizenOfficial/vela/blob/main/contracts/contracts/mocks/MockTeeAuthenticator.sol
contract MockTeeAuthenticator is ITeeAuthenticator {
    address public teeSigner;
    bytes public pubSecp521r1;

    constructor(address _teeSigner, bytes memory _pubSecp521r1) {
        teeSigner = _teeSigner;
        pubSecp521r1 = _pubSecp521r1;
    }

    function checkSignature(
        Structs.SignatureParams memory, /*params*/
        bytes memory /*signature*/
    ) external pure override returns (bool) {
        return true; // Always return true for mock
    }

    function getTeeSigner() external view override returns (address) {
        return teeSigner;
    }

    function getPubSecp521r1() external view override returns (bytes memory) {
        return pubSecp521r1;
    }
}
