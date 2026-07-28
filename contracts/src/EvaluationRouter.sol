// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAgenticCommerce {
    struct Job {
        uint256 id;
        address client;
        address provider;
        address evaluator;
        string description;
        uint256 budget;
        uint256 expiredAt;
        uint8 status;
        address hook;
    }

    function getJob(uint256 jobId) external view returns (Job memory);
    function complete(uint256 jobId, bytes32 reason, bytes calldata optParams) external;
    function reject(uint256 jobId, bytes32 reason, bytes calldata optParams) external;
}

interface IERC20Minimal {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// vAPI EvaluationRouter — holds the ERC-8183 evaluator seat on AgenticCommerce.
///
/// Trust model (deliberate, documented):
/// - `oracle` is a narrowly-authorized service wallet. The AI judge never holds
///   this key; an off-chain deterministic layer validates the model's structured
///   verdict before this wallet signs anything.
/// - The job's client chooses the review lane. `HumanOnly` makes AI settlement
///   revert at the contract level; the default lane allows the guarded AI path.
/// - The AI path can only settle jobs whose escrow budget is at or below
///   `autoSettleCap` and whose reported confidence meets `minConfidenceBP`, and
///   never past job expiry. Everything else must go through `humanResolve`.
/// - Settlement on the target is terminal (ERC-8183 has no appeals), so every
///   verdict here is one-shot: `resolutions` records exactly one terminal
///   action per job and its provenance (AI vs human), forming the on-chain
///   audit trail together with the emitted evidence hashes.
contract EvaluationRouter {
    uint8 internal constant STATUS_SUBMITTED = 2;

    enum Resolution {
        None,
        AutoCompleted,
        AutoRejected,
        Escalated,
        HumanCompleted,
        HumanRejected
    }

    /// Client-chosen evaluation path. AIAllowed (default) permits guarded
    /// auto-settlement; HumanOnly requires a human verdict.
    enum ReviewLane {
        AIAllowed,
        HumanOnly
    }

    IAgenticCommerce public immutable target;

    address public owner;
    address public oracle;
    address public humanResolver;

    /// Max escrow budget (payment-token base units) the AI path may settle.
    uint256 public autoSettleCap;
    /// Min model confidence (basis points) required for auto-settlement.
    uint16 public minConfidenceBP;

    mapping(uint256 => Resolution) public resolutions;
    mapping(uint256 => bytes32) public evidence;
    mapping(uint256 => ReviewLane) public lanes;
    /// Human-review provenance. These fields are populated only for terminal
    /// human resolutions; the resolver attests that the off-chain payout was
    /// completed before settlement.
    mapping(uint256 => address) public reviewers;
    mapping(uint256 => uint256) public reviewerRewards;
    mapping(uint256 => bytes32) public reviewerPayouts;

    event AIVerdict(uint256 indexed jobId, bool approved, uint16 confidenceBP, bytes32 evidenceHash);
    event Escalated(uint256 indexed jobId, bytes32 reasonHash);
    event HumanVerdict(
        uint256 indexed jobId,
        address indexed reviewer,
        bool approved,
        uint256 reward,
        bytes32 evidenceHash,
        bytes32 payoutTxHash
    );
    event LaneSet(uint256 indexed jobId, ReviewLane lane);
    event ConfigUpdated(address oracle, address humanResolver, uint256 autoSettleCap, uint16 minConfidenceBP);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error NotOwner();
    error NotOracle();
    error NotHumanResolver();
    error InvalidReviewer();
    error MissingPayoutTransaction();
    error NotClient(uint256 jobId);
    error LaneLocked(uint256 jobId);
    error HumanReviewRequired(uint256 jobId);
    error ZeroAddress();
    error AlreadyResolved(uint256 jobId);
    error NotEscalatable(uint256 jobId);
    error NotEvaluator(uint256 jobId);
    error WrongStatus(uint256 jobId, uint8 status);
    error AboveAutoCap(uint256 jobId, uint256 budget, uint256 cap);
    error BelowConfidence(uint16 confidenceBP, uint16 minimum);
    error JobExpired(uint256 jobId);
    error SweepFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyOracle() {
        if (msg.sender != oracle) revert NotOracle();
        _;
    }

    modifier onlyHumanResolver() {
        if (msg.sender != humanResolver) revert NotHumanResolver();
        _;
    }

    constructor(
        address target_,
        address oracle_,
        address humanResolver_,
        uint256 autoSettleCap_,
        uint16 minConfidenceBP_
    ) {
        if (target_ == address(0) || oracle_ == address(0) || humanResolver_ == address(0)) {
            revert ZeroAddress();
        }
        target = IAgenticCommerce(target_);
        owner = msg.sender;
        oracle = oracle_;
        humanResolver = humanResolver_;
        autoSettleCap = autoSettleCap_;
        minConfidenceBP = minConfidenceBP_;
    }

    // ------------------------------------------------------------------ lanes

    /// The job's client picks the evaluation path. Flippable both ways until
    /// the router records a resolution for the job.
    function setLane(uint256 jobId, ReviewLane lane) external {
        if (resolutions[jobId] != Resolution.None) revert LaneLocked(jobId);
        IAgenticCommerce.Job memory job = target.getJob(jobId);
        if (job.evaluator != address(this)) revert NotEvaluator(jobId);
        if (msg.sender != job.client) revert NotClient(jobId);
        lanes[jobId] = lane;
        emit LaneSet(jobId, lane);
    }

    // ---------------------------------------------------------------- verdicts

    /// AI path: guarded auto-settlement. Reverts (and therefore leaves no state
    /// behind) if the target call fails for any reason.
    function submitAIVerdict(uint256 jobId, bool approve, uint16 confidenceBP, bytes32 evidenceHash)
        external
        onlyOracle
    {
        if (resolutions[jobId] != Resolution.None) revert AlreadyResolved(jobId);
        if (lanes[jobId] == ReviewLane.HumanOnly) revert HumanReviewRequired(jobId);
        if (confidenceBP < minConfidenceBP) revert BelowConfidence(confidenceBP, minConfidenceBP);

        IAgenticCommerce.Job memory job = _checkedJob(jobId);
        if (job.budget > autoSettleCap) revert AboveAutoCap(jobId, job.budget, autoSettleCap);
        if (block.timestamp >= job.expiredAt) revert JobExpired(jobId);

        resolutions[jobId] = approve ? Resolution.AutoCompleted : Resolution.AutoRejected;
        evidence[jobId] = evidenceHash;
        _settle(jobId, approve, evidenceHash);
        emit AIVerdict(jobId, approve, confidenceBP, evidenceHash);
    }

    /// Oracle refuses auto-settlement (low confidence, above cap, suspected
    /// prompt injection, ...) and queues the job for a human. Non-terminal.
    function escalate(uint256 jobId, bytes32 reasonHash) external onlyOracle {
        if (resolutions[jobId] != Resolution.None) revert NotEscalatable(jobId);
        resolutions[jobId] = Resolution.Escalated;
        evidence[jobId] = reasonHash;
        emit Escalated(jobId, reasonHash);
    }

    /// Human fallback: allowed from None or Escalated, exempt from cap and
    /// confidence gates. `reviewer`, `reward`, and `payoutTxHash` are
    /// resolver-attested payout provenance; this contract does not custody the
    /// reviewer reward. Still pre-settlement — settlement remains terminal.
    function humanResolve(
        uint256 jobId,
        address reviewer,
        bool approve,
        uint256 reward,
        bytes32 evidenceHash,
        bytes32 payoutTxHash
    ) external onlyHumanResolver {
        Resolution current = resolutions[jobId];
        if (current != Resolution.None && current != Resolution.Escalated) revert AlreadyResolved(jobId);
        if (reviewer == address(0)) revert InvalidReviewer();
        if (reward != 0 && payoutTxHash == bytes32(0)) revert MissingPayoutTransaction();

        _checkedJob(jobId);

        resolutions[jobId] = approve ? Resolution.HumanCompleted : Resolution.HumanRejected;
        evidence[jobId] = evidenceHash;
        reviewers[jobId] = reviewer;
        reviewerRewards[jobId] = reward;
        reviewerPayouts[jobId] = payoutTxHash;
        _settle(jobId, approve, evidenceHash);
        emit HumanVerdict(jobId, reviewer, approve, reward, evidenceHash, payoutTxHash);
    }

    // ---------------------------------------------------------------- internal

    function _checkedJob(uint256 jobId) internal view returns (IAgenticCommerce.Job memory job) {
        job = target.getJob(jobId);
        if (job.evaluator != address(this)) revert NotEvaluator(jobId);
        if (job.status != STATUS_SUBMITTED) revert WrongStatus(jobId, job.status);
    }

    function _settle(uint256 jobId, bool approve, bytes32 evidenceHash) internal {
        if (approve) {
            target.complete(jobId, evidenceHash, "");
        } else {
            target.reject(jobId, evidenceHash, "");
        }
    }

    // ------------------------------------------------------------------ config

    function setConfig(address oracle_, address humanResolver_, uint256 autoSettleCap_, uint16 minConfidenceBP_)
        external
        onlyOwner
    {
        if (oracle_ == address(0) || humanResolver_ == address(0)) revert ZeroAddress();
        oracle = oracle_;
        humanResolver = humanResolver_;
        autoSettleCap = autoSettleCap_;
        minConfidenceBP = minConfidenceBP_;
        emit ConfigUpdated(oracle_, humanResolver_, autoSettleCap_, minConfidenceBP_);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    /// Evaluator fees (if the platform enables `evaluatorFeeBP`) accrue to this
    /// contract on `complete`. Escape hatch for those funds.
    function sweep(address token, address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        IERC20Minimal erc20 = IERC20Minimal(token);
        if (!erc20.transfer(to, erc20.balanceOf(address(this)))) revert SweepFailed();
    }
}
