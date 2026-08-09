// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import { IEscrowFactory } from "./interfaces/IEscrowFactory.sol";
import { IEscrowV1 } from "./interfaces/IEscrowV1.sol";

contract ReputationRegistryV0 {
    uint8 internal constant RESOLVED_STATE = 5;
    uint8 internal constant RELEASE_RESOLUTION = 1;
    uint8 internal constant REFUND_RESOLUTION = 2;
    uint8 internal constant SPLIT_RESOLUTION = 3;

    struct Score {
        uint64 settled;
        uint64 released;
        uint64 refunded;
        uint64 disputed;
        uint64 splits;
    }

    IEscrowFactory public immutable factory;
    mapping(address escrow => bool attested) public isAttested;
    mapping(address subject => Score score) private _scores;

    event SettlementAttested(
        address indexed escrow, address indexed seller, address indexed buyer, uint8 resolution
    );

    error InvalidAddress();
    error NotRegisteredEscrow();
    error EscrowNotResolved();
    error AlreadyAttested();
    error InvalidResolution();

    constructor(address factory_) {
        if (factory_ == address(0)) revert InvalidAddress();
        factory = IEscrowFactory(factory_);
    }

    function attest(address escrow) external {
        if (!factory.isEscrow(escrow)) revert NotRegisteredEscrow();
        if (isAttested[escrow]) revert AlreadyAttested();

        IEscrowV1 settledEscrow = IEscrowV1(escrow);
        if (settledEscrow.state() != RESOLVED_STATE) revert EscrowNotResolved();
        uint8 result = settledEscrow.resolution();
        if (result < RELEASE_RESOLUTION || result > SPLIT_RESOLUTION) {
            revert InvalidResolution();
        }

        isAttested[escrow] = true;
        address seller = settledEscrow.seller();
        address buyer = settledEscrow.buyer();
        _record(_scores[seller], result, settledEscrow.disputedAt() != 0);
        _record(_scores[buyer], result, settledEscrow.disputedAt() != 0);

        emit SettlementAttested(escrow, seller, buyer, result);
    }

    function scoreOf(address subject)
        external
        view
        returns (uint64 settled, uint64 released, uint64 refunded, uint64 disputed, uint64 splits)
    {
        Score storage score = _scores[subject];
        return (score.settled, score.released, score.refunded, score.disputed, score.splits);
    }

    function _record(Score storage score, uint8 result, bool wasDisputed) private {
        ++score.settled;
        if (result == RELEASE_RESOLUTION) ++score.released;
        else if (result == REFUND_RESOLUTION) ++score.refunded;
        else ++score.splits;
        if (wasDisputed) ++score.disputed;
    }
}

