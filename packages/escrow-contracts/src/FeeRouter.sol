// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { IFeeRouter } from "./interfaces/IFeeRouter.sol";

contract FeeRouter is IFeeRouter {
    using SafeERC20 for IERC20;

    uint16 internal constant BP_DENOMINATOR = 10_000;

    address public immutable override treasury;
    uint16 public immutable override feeBp;

    error InvalidAddress();
    error InvalidFee();

    constructor(address treasury_, uint16 feeBp_) {
        if (treasury_ == address(0)) revert InvalidAddress();
        if (feeBp_ > BP_DENOMINATOR) revert InvalidFee();
        treasury = treasury_;
        feeBp = feeBp_;
    }

    function distribute(address token, address seller, uint256 gross)
        external
        override
        returns (uint256 net, uint256 fee)
    {
        if (token == address(0) || seller == address(0)) revert InvalidAddress();

        fee = Math.mulDiv(gross, feeBp, BP_DENOMINATOR);
        net = gross - fee;

        IERC20 paymentToken = IERC20(token);
        paymentToken.safeTransferFrom(msg.sender, seller, net);
        paymentToken.safeTransferFrom(msg.sender, treasury, fee);

        emit FeeSplit(msg.sender, seller, token, net, fee, treasury);
    }
}

