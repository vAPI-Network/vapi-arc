import { parseAbi } from "viem";

export const escrowFactoryAbi = parseAbi([
  "function createEscrow(address buyer, address token, uint256 amount, uint64 workDuration, uint64 reviewWindow, bytes32 termsHash, bytes32 salt) returns (address)",
  "function predictEscrow(address seller, bytes32 salt) view returns (address)",
  "function implementation() view returns (address)",
  "function paymentToken() view returns (address)",
  "function platformTreasury() view returns (address)",
  "function platformFeeBP() view returns (uint16)",
  "function isEscrow(address) view returns (bool)",
  "function offerTtl() view returns (uint64)",
  "event EscrowCreated(address indexed escrow, address indexed seller, address indexed buyer, address token, uint256 amount, uint64 offerDeadline, uint64 workDuration, uint64 reviewWindow, bytes32 termsHash, bytes32 salt)",
]);

export const escrowV1Abi = parseAbi([
  "function state() view returns (uint8)",
  "function resolution() view returns (uint8)",
  "function buyer() view returns (address)",
  "function seller() view returns (address)",
  "function token() view returns (address)",
  "function amount() view returns (uint256)",
  "function termsHash() view returns (bytes32)",
  "function deliveryHash() view returns (bytes32)",
  "function offerDeadline() view returns (uint64)",
  "function workDeadline() view returns (uint64)",
  "function reviewDeadline() view returns (uint64)",
  "function disputedAt() view returns (uint64)",
  "function counterEvidenceDeadline() view returns (uint64)",
  "function depositFunds()",
  "function fundWithAuthorization(uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)",
  "function cancelOffer()",
  "function submitDelivery(bytes32 deliveryHash)",
  "function releaseFunds()",
  "function refundBuyer()",
  "function timeoutRefund()",
  "function finalize()",
  "function raiseDispute(bytes32 evidenceHash)",
  "function submitCounterEvidence(bytes32 evidenceHash)",
  "function resolveDispute(uint8 outcome)",
  "event Funded(address indexed buyer, uint8 method, uint64 workDeadline)",
  "event OfferCancelled(address indexed by)",
  "event DeliverySubmitted(bytes32 indexed deliveryHash, uint64 reviewDeadline)",
  "event DisputeRaised(address indexed by, bytes32 evidenceHash, uint64 counterEvidenceDeadline)",
  "event CounterEvidenceSubmitted(address indexed by, bytes32 evidenceHash)",
  "event Resolved(uint8 indexed resolution, address indexed executor, uint256 buyerAmount, uint256 sellerNet, uint256 fee)",
]);

export const disputePanelAbi = parseAbi([
  "function open(address raisedBy, bytes32 evidenceHash)",
  "function commit(address escrow, bytes32 commitment)",
  "function reveal(address escrow, uint8 vote, bytes32 salt)",
  "function execute(address escrow)",
  "function factory() view returns (address)",
  "function registry() view returns (address)",
  "event DisputeOpened(address indexed escrow, address indexed raisedBy, uint64 commitDeadline, uint64 revealDeadline)",
  "event VoteCommitted(address indexed escrow, address indexed arbiter, bytes32 commitment)",
  "event VoteRevealed(address indexed escrow, address indexed arbiter, uint8 vote)",
  "event DisputeExecuted(address indexed escrow, uint8 outcome, uint8 releaseVotes, uint8 refundVotes, uint8 splitVotes)",
]);

export const feeRouterAbi = parseAbi([
  "function treasury() view returns (address)",
  "function feeBp() view returns (uint16)",
  "function distribute(address token, address seller, uint256 gross) returns (uint256 net, uint256 fee)",
  "event FeeSplit(address indexed payer, address indexed seller, address token, uint256 net, uint256 fee, address treasury)",
]);

export const arbiterRegistryAbi = parseAbi([
  "function isArbiter(address) view returns (bool)",
  "function arbiterCount() view returns (uint256)",
  "event ArbiterSet(address indexed arbiter, bool allowed)",
]);

export const reputationRegistryAbi = parseAbi([
  "function attest(address escrow)",
  "function scoreOf(address subject) view returns (uint64 settled, uint64 released, uint64 refunded, uint64 disputed, uint64 splits)",
  "event SettlementAttested(address indexed escrow, address indexed seller, address indexed buyer, uint8 resolution)",
]);

export const EscrowState = {
  NONE: 0,
  CREATED: 1,
  LOCKED: 2,
  SUBMITTED: 3,
  DISPUTED: 4,
  RESOLVED: 5,
  EXPIRED: 6,
} as const;

export const EscrowResolution = {
  NONE: 0,
  RELEASE: 1,
  REFUND: 2,
  SPLIT: 3,
} as const;

export const PanelVoteValue = {
  RELEASE: 1,
  REFUND: 2,
  SPLIT: 3,
} as const;

export const Outcome = {
  RELEASE: 0,
  REFUND: 1,
  SPLIT: 2,
} as const;

/** commitment = keccak256(abi.encodePacked(escrow, arbiter, uint8 vote, bytes32 salt)) */
export const COMMIT_HASH =
  "keccak256(abi.encodePacked(escrow, arbiter, uint8 vote, bytes32 salt))" as const;
