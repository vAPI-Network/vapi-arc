// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {EvaluationRouter, IAgenticCommerce, IERC20Minimal} from "../src/EvaluationRouter.sol";

contract MockAgenticCommerce is IAgenticCommerce {
    mapping(uint256 => Job) internal _jobs;
    bool public revertOnSettle;
    uint256 public lastSettledJob;
    bool public lastApproved;
    bytes32 public lastReason;

    function setJob(uint256 jobId, Job memory job) external {
        _jobs[jobId] = job;
    }

    function setRevertOnSettle(bool v) external {
        revertOnSettle = v;
    }

    function getJob(uint256 jobId) external view returns (Job memory) {
        return _jobs[jobId];
    }

    function complete(uint256 jobId, bytes32 reason, bytes calldata) external {
        require(!revertOnSettle, "settle reverted");
        require(_jobs[jobId].status == 2, "wrong status");
        require(msg.sender == _jobs[jobId].evaluator, "not evaluator");
        _jobs[jobId].status = 3;
        lastSettledJob = jobId;
        lastApproved = true;
        lastReason = reason;
    }

    function reject(uint256 jobId, bytes32 reason, bytes calldata) external {
        require(!revertOnSettle, "settle reverted");
        require(_jobs[jobId].status == 1 || _jobs[jobId].status == 2, "wrong status");
        require(msg.sender == _jobs[jobId].evaluator, "not evaluator");
        _jobs[jobId].status = 4;
        lastSettledJob = jobId;
        lastApproved = false;
        lastReason = reason;
    }
}

contract MockToken is IERC20Minimal {
    mapping(address => uint256) public balances;
    bool public failTransfers;

    function mint(address to, uint256 amount) external {
        balances[to] += amount;
    }

    function setFailTransfers(bool v) external {
        failTransfers = v;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (failTransfers) return false;
        balances[msg.sender] -= amount;
        balances[to] += amount;
        return true;
    }

    function balanceOf(address account) external view returns (uint256) {
        return balances[account];
    }
}

contract EvaluationRouterTest is Test {
    MockAgenticCommerce internal ac;
    EvaluationRouter internal router;

    address internal constant ORACLE = address(0xA11CE);
    address internal constant HUMAN = address(0xBEEF);
    address internal constant STRANGER = address(0xBAD);

    uint256 internal constant CAP = 100e6; // 100 USDC
    uint16 internal constant MIN_CONF = 8000; // 80%

    uint256 internal constant JOB = 42;
    bytes32 internal constant EVIDENCE = keccak256("evidence-record-v1");

    function setUp() public {
        ac = new MockAgenticCommerce();
        router = new EvaluationRouter(address(ac), ORACLE, HUMAN, CAP, MIN_CONF);
        _setJob(JOB, 10e6, 2, address(router), block.timestamp + 1 days);
    }

    function _setJob(uint256 jobId, uint256 budget, uint8 status, address evaluator, uint256 expiredAt) internal {
        ac.setJob(
            jobId,
            IAgenticCommerce.Job({
                id: jobId,
                client: address(0xC11E47),
                provider: address(0x9807),
                evaluator: evaluator,
                description: "summarize doc per rubric v1",
                budget: budget,
                expiredAt: expiredAt,
                status: status,
                hook: address(0)
            })
        );
    }

    // ------------------------------------------------------------------ authz

    function test_onlyOracleCanSubmitAIVerdict() public {
        vm.prank(STRANGER);
        vm.expectRevert(EvaluationRouter.NotOracle.selector);
        router.submitAIVerdict(JOB, true, 9000, EVIDENCE);
    }

    function test_onlyHumanResolverCanHumanResolve() public {
        vm.prank(STRANGER);
        vm.expectRevert(EvaluationRouter.NotHumanResolver.selector);
        router.humanResolve(JOB, true, EVIDENCE);
    }

    function test_onlyOracleCanEscalate() public {
        vm.prank(STRANGER);
        vm.expectRevert(EvaluationRouter.NotOracle.selector);
        router.escalate(JOB, EVIDENCE);
    }

    function test_onlyOwnerCanSetConfigAndSweep() public {
        vm.startPrank(STRANGER);
        vm.expectRevert(EvaluationRouter.NotOwner.selector);
        router.setConfig(ORACLE, HUMAN, CAP, MIN_CONF);
        vm.expectRevert(EvaluationRouter.NotOwner.selector);
        router.sweep(address(0x70CE), STRANGER);
        vm.stopPrank();
    }

    // --------------------------------------------------------------- AI path

    function test_aiApproveSettlesAndRecordsProvenance() public {
        vm.prank(ORACLE);
        router.submitAIVerdict(JOB, true, 9500, EVIDENCE);

        assertEq(uint8(router.resolutions(JOB)), uint8(EvaluationRouter.Resolution.AutoCompleted));
        assertEq(router.evidence(JOB), EVIDENCE);
        assertEq(ac.lastSettledJob(), JOB);
        assertTrue(ac.lastApproved());
        assertEq(ac.lastReason(), EVIDENCE);
    }

    function test_aiRejectSettles() public {
        vm.prank(ORACLE);
        router.submitAIVerdict(JOB, false, 9500, EVIDENCE);
        assertEq(uint8(router.resolutions(JOB)), uint8(EvaluationRouter.Resolution.AutoRejected));
        assertFalse(ac.lastApproved());
    }

    function test_aiVerdictReplayBlocked() public {
        vm.startPrank(ORACLE);
        router.submitAIVerdict(JOB, true, 9500, EVIDENCE);
        vm.expectRevert(abi.encodeWithSelector(EvaluationRouter.AlreadyResolved.selector, JOB));
        router.submitAIVerdict(JOB, true, 9500, EVIDENCE);
        vm.stopPrank();
    }

    function test_aiVerdictBelowConfidenceBlocked() public {
        vm.prank(ORACLE);
        vm.expectRevert(abi.encodeWithSelector(EvaluationRouter.BelowConfidence.selector, uint16(7999), MIN_CONF));
        router.submitAIVerdict(JOB, true, 7999, EVIDENCE);
    }

    function test_aiVerdictAboveCapBlocked() public {
        _setJob(JOB, CAP + 1, 2, address(router), block.timestamp + 1 days);
        vm.prank(ORACLE);
        vm.expectRevert(abi.encodeWithSelector(EvaluationRouter.AboveAutoCap.selector, JOB, CAP + 1, CAP));
        router.submitAIVerdict(JOB, true, 9500, EVIDENCE);
    }

    function test_aiVerdictExpiredJobBlocked() public {
        _setJob(JOB, 10e6, 2, address(router), block.timestamp);
        vm.prank(ORACLE);
        vm.expectRevert(abi.encodeWithSelector(EvaluationRouter.JobExpired.selector, JOB));
        router.submitAIVerdict(JOB, true, 9500, EVIDENCE);
    }

    function test_aiVerdictWrongEvaluatorBlocked() public {
        _setJob(JOB, 10e6, 2, address(0xD00D), block.timestamp + 1 days);
        vm.prank(ORACLE);
        vm.expectRevert(abi.encodeWithSelector(EvaluationRouter.NotEvaluator.selector, JOB));
        router.submitAIVerdict(JOB, true, 9500, EVIDENCE);
    }

    function test_aiVerdictWrongStatusBlocked() public {
        _setJob(JOB, 10e6, 1, address(router), block.timestamp + 1 days);
        vm.prank(ORACLE);
        vm.expectRevert(abi.encodeWithSelector(EvaluationRouter.WrongStatus.selector, JOB, uint8(1)));
        router.submitAIVerdict(JOB, true, 9500, EVIDENCE);
    }

    // ------------------------------------------------------------------ lanes

    address internal constant CLIENT = address(0xC11E47);

    function test_clientSetsHumanOnlyLaneAndAIVerdictReverts() public {
        vm.prank(CLIENT);
        router.setLane(JOB, EvaluationRouter.ReviewLane.HumanOnly);
        assertEq(uint8(router.lanes(JOB)), uint8(EvaluationRouter.ReviewLane.HumanOnly));

        vm.prank(ORACLE);
        vm.expectRevert(abi.encodeWithSelector(EvaluationRouter.HumanReviewRequired.selector, JOB));
        router.submitAIVerdict(JOB, true, 9500, EVIDENCE);
    }

    function test_nonClientCannotSetLane() public {
        vm.prank(STRANGER);
        vm.expectRevert(abi.encodeWithSelector(EvaluationRouter.NotClient.selector, JOB));
        router.setLane(JOB, EvaluationRouter.ReviewLane.HumanOnly);
    }

    function test_laneLockedAfterResolution() public {
        vm.prank(ORACLE);
        router.escalate(JOB, EVIDENCE);
        vm.prank(CLIENT);
        vm.expectRevert(abi.encodeWithSelector(EvaluationRouter.LaneLocked.selector, JOB));
        router.setLane(JOB, EvaluationRouter.ReviewLane.HumanOnly);
    }

    function test_laneRequiresRouterAsEvaluator() public {
        _setJob(77, 10e6, 2, STRANGER, block.timestamp + 1 days);
        vm.prank(CLIENT);
        vm.expectRevert(abi.encodeWithSelector(EvaluationRouter.NotEvaluator.selector, 77));
        router.setLane(77, EvaluationRouter.ReviewLane.HumanOnly);
    }

    function test_laneFlipBackReenablesAIPath() public {
        vm.startPrank(CLIENT);
        router.setLane(JOB, EvaluationRouter.ReviewLane.HumanOnly);
        router.setLane(JOB, EvaluationRouter.ReviewLane.AIAllowed);
        vm.stopPrank();

        vm.prank(ORACLE);
        router.submitAIVerdict(JOB, true, 9500, EVIDENCE);
        assertEq(uint8(router.resolutions(JOB)), uint8(EvaluationRouter.Resolution.AutoCompleted));
    }

    function test_laneSettableBeforeSubmission() public {
        _setJob(78, 10e6, 1, address(router), block.timestamp + 1 days);
        vm.prank(CLIENT);
        router.setLane(78, EvaluationRouter.ReviewLane.HumanOnly);
        assertEq(uint8(router.lanes(78)), uint8(EvaluationRouter.ReviewLane.HumanOnly));
    }

    function test_humanResolveWorksOnHumanOnlyLane() public {
        vm.prank(CLIENT);
        router.setLane(JOB, EvaluationRouter.ReviewLane.HumanOnly);

        vm.prank(HUMAN);
        router.humanResolve(JOB, true, EVIDENCE);
        assertEq(uint8(router.resolutions(JOB)), uint8(EvaluationRouter.Resolution.HumanCompleted));
        assertTrue(ac.lastApproved());
    }

    function test_escalateWorksOnHumanOnlyLane() public {
        vm.prank(CLIENT);
        router.setLane(JOB, EvaluationRouter.ReviewLane.HumanOnly);

        vm.prank(ORACLE);
        router.escalate(JOB, keccak256("client requested human review"));
        assertEq(uint8(router.resolutions(JOB)), uint8(EvaluationRouter.Resolution.Escalated));
    }

    // ------------------------------------------------------- escalation/human

    function test_escalateThenHumanResolve() public {
        vm.prank(ORACLE);
        router.escalate(JOB, keccak256("injection-suspected"));
        assertEq(uint8(router.resolutions(JOB)), uint8(EvaluationRouter.Resolution.Escalated));

        vm.prank(HUMAN);
        router.humanResolve(JOB, false, EVIDENCE);
        assertEq(uint8(router.resolutions(JOB)), uint8(EvaluationRouter.Resolution.HumanRejected));
        assertFalse(ac.lastApproved());
    }

    function test_aiVerdictBlockedAfterEscalation() public {
        vm.startPrank(ORACLE);
        router.escalate(JOB, EVIDENCE);
        vm.expectRevert(abi.encodeWithSelector(EvaluationRouter.AlreadyResolved.selector, JOB));
        router.submitAIVerdict(JOB, true, 9500, EVIDENCE);
        vm.stopPrank();
    }

    function test_escalateReplayBlocked() public {
        vm.startPrank(ORACLE);
        router.escalate(JOB, EVIDENCE);
        vm.expectRevert(abi.encodeWithSelector(EvaluationRouter.NotEscalatable.selector, JOB));
        router.escalate(JOB, EVIDENCE);
        vm.stopPrank();
    }

    function test_humanResolveExemptFromCapConfidenceAndExpiry() public {
        _setJob(JOB, CAP + 1_000e6, 2, address(router), block.timestamp);
        vm.prank(HUMAN);
        router.humanResolve(JOB, true, EVIDENCE);
        assertEq(uint8(router.resolutions(JOB)), uint8(EvaluationRouter.Resolution.HumanCompleted));
    }

    function test_humanResolveReplayBlocked() public {
        vm.prank(HUMAN);
        router.humanResolve(JOB, true, EVIDENCE);
        vm.prank(HUMAN);
        vm.expectRevert(abi.encodeWithSelector(EvaluationRouter.AlreadyResolved.selector, JOB));
        router.humanResolve(JOB, false, EVIDENCE);
    }

    function test_humanResolveStillChecksEvaluatorAndStatus() public {
        _setJob(JOB, 10e6, 3, address(router), block.timestamp + 1 days);
        vm.prank(HUMAN);
        vm.expectRevert(abi.encodeWithSelector(EvaluationRouter.WrongStatus.selector, JOB, uint8(3)));
        router.humanResolve(JOB, true, EVIDENCE);
    }

    // ------------------------------------------------- external-call failure

    function test_targetRevertRollsBackResolution() public {
        ac.setRevertOnSettle(true);
        vm.prank(ORACLE);
        vm.expectRevert(bytes("settle reverted"));
        router.submitAIVerdict(JOB, true, 9500, EVIDENCE);
        // State must be untouched: the job can still be resolved later.
        assertEq(uint8(router.resolutions(JOB)), uint8(EvaluationRouter.Resolution.None));
        assertEq(router.evidence(JOB), bytes32(0));
    }

    // ------------------------------------------------------------------ config

    function test_setConfigAndUse() public {
        address newOracle = address(0x0AC1E2);
        router.setConfig(newOracle, HUMAN, CAP, MIN_CONF);
        vm.prank(ORACLE);
        vm.expectRevert(EvaluationRouter.NotOracle.selector);
        router.submitAIVerdict(JOB, true, 9500, EVIDENCE);
        vm.prank(newOracle);
        router.submitAIVerdict(JOB, true, 9500, EVIDENCE);
    }

    function test_constructorRejectsZeroAddresses() public {
        vm.expectRevert(EvaluationRouter.ZeroAddress.selector);
        new EvaluationRouter(address(0), ORACLE, HUMAN, CAP, MIN_CONF);
        vm.expectRevert(EvaluationRouter.ZeroAddress.selector);
        new EvaluationRouter(address(ac), address(0), HUMAN, CAP, MIN_CONF);
    }

    function test_sweep() public {
        MockToken token = new MockToken();
        token.mint(address(router), 5e6);
        router.sweep(address(token), address(this));
        assertEq(token.balanceOf(address(this)), 5e6);
        assertEq(token.balanceOf(address(router)), 0);
    }
}
