// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAgenticCommerce {
    function complete(uint256 jobId, bytes32 reason, bytes calldata optParams) external;
    function reject(uint256 jobId, bytes32 reason, bytes calldata optParams) external;
}

/// Minimal proof that a contract can hold the ERC-8183 evaluator seat on the
/// deployed AgenticCommerce instance (Arc Testnet). The production
/// EvaluationRouter adds roles, policy hashes, value caps, replay protection,
/// expiry handling and evidence records on top of this seat.
contract EvaluatorProof {
    IAgenticCommerce public immutable target;
    address public immutable oracle;

    event Settled(uint256 indexed jobId, bool completed, bytes32 evidenceHash);

    constructor(address target_, address oracle_) {
        target = IAgenticCommerce(target_);
        oracle = oracle_;
    }

    modifier onlyOracle() {
        require(msg.sender == oracle, "not oracle");
        _;
    }

    function completeJob(uint256 jobId, bytes32 evidenceHash) external onlyOracle {
        target.complete(jobId, evidenceHash, "");
        emit Settled(jobId, true, evidenceHash);
    }

    function rejectJob(uint256 jobId, bytes32 evidenceHash) external onlyOracle {
        target.reject(jobId, evidenceHash, "");
        emit Settled(jobId, false, evidenceHash);
    }
}
