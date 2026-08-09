// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

interface IFeeRouter {
    event FeeSplit(
        address indexed payer,
        address indexed seller,
        address token,
        uint256 net,
        uint256 fee,
        address treasury
    );

    function treasury() external view returns (address);
    function feeBp() external view returns (uint16);
    function distribute(address token, address seller, uint256 gross)
        external
        returns (uint256 net, uint256 fee);
}

