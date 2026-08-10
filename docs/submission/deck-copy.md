# vAPI Work + Verify on Arc — deck copy

## Slide 1 — Money is instant. Work is not.

**vAPI Work + Verify on Arc**

Non-custodial USDC escrow, commit-reveal verification, and on-chain reputation for real work.

**Speaker line:** “Arc closes the payment leg in under a second. We make sure the work leg deserves
to close.”

## Slide 2 — The missing trust layer

Web2 marketplaces did not win by adding a payment button. They added:

- escrow between strangers;
- deadlines and acceptance rules;
- dispute resolution;
- reputation that compounds across transactions.

Agentic commerce needs the same trust layer without reinstalling a platform custodian.

**Speaker line:** “Fast rails solve settlement latency. They do not solve whether the logo was
delivered, the dataset matched the brief, or the buyer vanished after receiving the work.”

## Slide 3 — What we built

- `EscrowFactory` + deterministic EIP-1167 `EscrowV1` clones
- six-state order lifecycle with permissionless timeouts
- current three-seed, allowlisted commit-reveal panel with a fixed two-vote threshold
- time-gated council liveness fallback with only three legal outcomes
- atomic 500 bp fee on seller-bound payouts
- permissionless, one-time settlement attestation
- four chain-native views: **The Forum**, Order detail, **The Praetors**, **The Census**

**Honest boundary:** hashes are on-chain; full evidence retrieval, economic security, and portable
identity are roadmap. The contracts are not presented as audited production infrastructure.

## Slide 4 — Six states. No ambiguous limbo.

`CREATED → LOCKED → SUBMITTED → RESOLVED`

Branches:

- unfunded offer after deadline → `EXPIRED`
- either party from `LOCKED` or `SUBMITTED` → `DISPUTED`
- missed work deadline → buyer refund
- unchallenged submitted delivery after review deadline → seller release
- seller can voluntarily refund; buyer can explicitly release

**Silence = consent, symmetrically:** seller silence after the work deadline consents to refund;
buyer silence after the review deadline consents to release.

## Slide 5 — A panel that cannot name itself as payee

1. Either party raises a dispute with an evidence hash.
2. The counterparty gets an evidence window.
3. The three seeded, allowlisted arbiters commit sealed votes.
4. They reveal `RELEASE`, `REFUND`, or `SPLIT` in the next window.
5. In that three-arbiter deployment, a ≥2/3 majority—two release or two refund votes—selects that outcome; every other executable tally splits.
6. Anyone executes after three reveals, or after the reveal deadline.

After the deadlock timeout, the council can choose the same three outcomes. Neither panel nor council
can nominate an arbitrary payout address. That is a structural constraint, not a claim that the
current governance is decentralized. The registry owner can change the allowlist; the contract's
outcome threshold remains two, so “≥2/3” is a claim about the deployed three-arbiter configuration.

## Slide 6 — Why Arc

**One asset, one transaction model**

- USDC is the native gas asset and the escrowed ERC-20 balance.
- ERC-20 precompile/interface: `0x3600000000000000000000000000000000000000`.
- Confirmed transactions have sub-second deterministic finality.
- EVM compatibility keeps contracts and wallet flows legible.

**Track fit**

- **Agentic Economy:** agents can contract, verify outcomes, and accumulate settlement history.
- **DeFi:** escrow and payout move under transparent contract rules, not operator discretion.

Sources: [Arc connection details](https://docs.arc.io/arc/references/connect-to-arc),
[USDC contract reference](https://docs.arc.io/arc/references/contract-addresses), and
[deterministic finality](https://docs.arc.io/arc/concepts/deterministic-finality).

## Slide 7 — Demo proof, not demo theater

Show these on Arcscan during the demo; replace every placeholder after final deployment/rehearsal.

<!-- PENDING-DEPLOY:BEGIN -->
| Proof point | Address or transaction | Explorer |
| --- | --- | --- |
| `EscrowFactory` | `PENDING_DEPLOY_ESCROW_FACTORY` | `PENDING_DEPLOY_ESCROW_FACTORY_EXPLORER` |
| `EscrowV1` implementation | `PENDING_DEPLOY_ESCROW_IMPLEMENTATION` | `PENDING_DEPLOY_ESCROW_IMPLEMENTATION_EXPLORER` |
| `DisputePanel` | `PENDING_DEPLOY_DISPUTE_PANEL` | `PENDING_DEPLOY_DISPUTE_PANEL_EXPLORER` |
| `ArbiterRegistry` | `PENDING_DEPLOY_ARBITER_REGISTRY` | `PENDING_DEPLOY_ARBITER_REGISTRY_EXPLORER` |
| `FeeRouter` | `PENDING_DEPLOY_FEE_ROUTER` | `PENDING_DEPLOY_FEE_ROUTER_EXPLORER` |
| `ReputationRegistryV0` | `PENDING_DEPLOY_REPUTATION_REGISTRY` | `PENDING_DEPLOY_REPUTATION_REGISTRY_EXPLORER` |
| Happy-path order | `PENDING_DEMO_HAPPY_ESCROW` | `PENDING_DEMO_HAPPY_ESCROW_EXPLORER` |
| Atomic release + fee split | `PENDING_DEMO_RELEASE_TX` | `PENDING_DEMO_RELEASE_TX_EXPLORER` |
| Commit-reveal execution | `PENDING_DEMO_EXECUTE_TX` | `PENDING_DEMO_EXECUTE_TX_EXPLORER` |
| Reputation attestation | `PENDING_DEMO_ATTEST_TX` | `PENDING_DEMO_ATTEST_TX_EXPLORER` |
<!-- PENDING-DEPLOY:END -->

**Say only what the receipts prove:** clone created, exact USDC funded, delivery hash submitted,
settlement and fee split atomic, dispute votes revealed, outcome executed, settlement attested once.

## Slide 8 — Security by constrained authority

- Funds sit only in the per-order escrow until terminal settlement.
- Resolver input is an enum, not an address or arbitrary call.
- Full refunds have no platform fee.
- Seller-bound transfers and fee math succeed atomically or revert together.
- Panel execution is permissionless once executable.
- Reputation accepts only registered, resolved escrows and rejects duplicate attestations.

**Trust assumptions today:** allowlist owner, configured council, treasury, contract correctness, and
off-chain evidence availability.

## Slide 9 — Roadmap: decentralize the judgment, not the payout rules

- stake-weighted participation with bounded power;
- accuracy multipliers for future assignments and rewards;
- slashing with explicit evidence and appeal policy;
- dispute bonds (the MVP bond is zero);
- retrievable IPFS evidence dossiers;
- x402 request flow around the implemented EIP-3009 authorization leg;
- ERC-8004 identity and reputation interoperability.

No roadmap item is required to make the current escrow state machine inspectable.

## Slide 10 — Team and ask

**Built for the Arc hackathon by the vAPI team.**

**Ask:**

- pressure-test the dispute and timeout design;
- connect us with marketplaces and agent builders who need a neutral work-verification layer;
- help take the contracts from tested MVP to independent audit and adversarial pilot.

**Close:** “Arc makes programmable money final. vAPI makes the work behind it verifiable.”
