// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

interface IEscrowV1 {
    event Funded(address indexed buyer, uint8 method, uint64 workDeadline);
    event OfferCancelled(address indexed by);
    event DeliverySubmitted(bytes32 indexed deliveryHash, uint64 reviewDeadline);
    event DisputeRaised(address indexed by, bytes32 evidenceHash, uint64 counterEvidenceDeadline);
    event CounterEvidenceSubmitted(address indexed by, bytes32 evidenceHash);
    event Resolved(
        uint8 indexed resolution,
        address indexed executor,
        uint256 buyerAmount,
        uint256 sellerNet,
        uint256 fee
    );

    function initialize(
        address seller,
        address buyer,
        address token,
        uint256 amount,
        uint64 offerDeadline,
        uint64 workDuration,
        uint64 reviewWindow,
        bytes32 termsHash
    ) external;

    function state() external view returns (uint8);
    function resolution() external view returns (uint8);
    function buyer() external view returns (address);
    function seller() external view returns (address);
    function token() external view returns (address);
    function amount() external view returns (uint256);
    function termsHash() external view returns (bytes32);
    function deliveryHash() external view returns (bytes32);
    function offerDeadline() external view returns (uint64);
    function workDeadline() external view returns (uint64);
    function reviewDeadline() external view returns (uint64);
    function disputedAt() external view returns (uint64);
    function counterEvidenceDeadline() external view returns (uint64);
    function depositFunds() external;
    function fundWithAuthorization(
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external;
    function cancelOffer() external;
    function submitDelivery(bytes32 deliveryHash) external;
    function releaseFunds() external;
    function refundBuyer() external;
    function timeoutRefund() external;
    function finalize() external;
    function raiseDispute(bytes32 evidenceHash) external;
    function submitCounterEvidence(bytes32 evidenceHash) external;
    function resolveDispute(uint8 outcome) external;
}

