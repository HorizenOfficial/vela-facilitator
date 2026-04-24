// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

// Extended structs based on vela's Structs.sol (https://github.com/HorizenOfficial/vela/blob/main/contracts/contracts/Structs.sol)
// Adds facilitator field to PendingRequest to track who submitted on behalf of the user.
contract Structs {
    enum RequestType {
        DEPLOYAPP,
        PROCESS,
        DEANONYMIZATION,
        ASSOCIATEKEY
    }

    enum RequestResult {
        COMPLETED,
        FAILED
    }

    enum ErrorCode {
        NO_ERROR,
        UNKNOWN,
        INTERNAL,
        APPLICATION_ALREADY_DEPLOYED,
        FUNCTION_NOT_FOUND,
        DEPOSIT_FAILED,
        REQUEST_FUNC_FAILED,
        APP_NOT_DEPLOYED,
        WRONG_KEY_SENT,
        PUB_KEY_NOT_REGISTERED,
        NO_REPORT_DATA_FOUND,
        WASM_INTERNAL,
        INSUFFICIENT_FUEL
    }

    struct PendingRequest {
        uint256 timestamp;      // assigned automatically
        address tokenAddress;   // address(0) = ETH, otherwise ERC-20 token
        uint256 assetAmount;    // deposited asset amount (0 if ETH-only or no deposit)
        uint256 maxFeeValue;
        bytes32 requestId;      // assigned automatically
        bytes payload;
        address sender;         // assigned automatically (the user, not the facilitator)
        address facilitator;    // the facilitator that submitted the request (address(0) for direct submissions)
        uint64 applicationId;
        uint8 protocolVersion;
        RequestType requestType;
    }

    struct WithdrawalRequest {
        address payable receiver;
        uint256 amount;
    }

    struct SignatureParams {
        uint64 applicationId;
        bytes32 prevStateRoot;
        bytes32 newStateRoot;
        bytes32 processedRequestId;
        bytes[] events;
        string[] eventSubTypes;
        WithdrawalRequest[] withdrawalRequests;
        uint256 refundAmount;
        uint256 applicationFee;
        Structs.ErrorCode errorCode;
        string errorMsg;
    }
}
