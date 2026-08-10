# vAPI Work + Verify on Arc: final deck copy

This copy accompanies the final white presentation deck.

**Live app:** <https://vapi-web-production.up.railway.app> · **Arc explorer:** <https://testnet.arcscan.app> · **Public repo:** <https://github.com/vAPI-Network/vapi-arc>

## Slide 1: Arc settles money fast. Work still needs review.

**vAPI Work + Verify on Arc**

A non-custodial USDC work marketplace where humans and AI agents hire each other.

**Speaker line:** “Arc closes the payment leg in under a second. vAPI gives the work time to be delivered, reviewed, and settled.”

## Slide 2: Rules for work between strangers

A work marketplace needs more than a payment button. It needs:

- escrow between a client and vendor;
- work and review deadlines;
- fixed acceptance, refund, and timeout rules;
- dispute review;
- reputation based on settled orders.

vAPI puts those rules on-chain without asking a platform operator to hold the client's money.

**Speaker line:** “Fast payment does not tell us whether the logo was delivered, the dataset matched the brief, or the client stopped responding after receiving the work.”

## Slide 3: What we built

- `EscrowFactory` with deterministic EIP-1167 `EscrowV1` clones
- a six-state order lifecycle with permissionless timeouts
- a three-reviewer commit-reveal panel with a fixed two-vote threshold
- a time-gated council fallback limited to three settlement outcomes
- a 500 bp fee on vendor payouts, transferred atomically
- permissionless, one-time settlement attestation
- 50 Foundry tests
- four English-first views: **Marketplace** (The Forum), **Order detail**, **Disputes** (The Praetors), and **Reputation** (The Census)
- readable job briefs, role-specific actions, and plain-language transaction receipts

Hashes are on-chain. Full evidence retrieval, economic reviewer security, and portable identity remain on the roadmap. The contracts have not had an independent production audit.

## Slide 4: Six states with explicit exits

`CREATED → LOCKED → SUBMITTED → RESOLVED`

Branches:

- an unfunded offer passes its deadline → `EXPIRED`
- either party disputes a `LOCKED` or `SUBMITTED` order → `DISPUTED`
- a missed work deadline → client refund
- an unchallenged delivery passes its review deadline → vendor payout
- the vendor can refund early; the client can release early

Vendor silence after the work deadline permits a refund. Client silence after the review deadline permits a release. Anyone can call either timeout function when it becomes available.

## Slide 5: Reviewers choose an outcome, never a payee

1. The client or vendor raises a dispute with an evidence hash.
2. The other party gets an evidence window for one counter-evidence hash.
3. Three registered reviewers commit sealed votes.
4. They reveal `RELEASE`, `REFUND`, or `SPLIT` in the next window.
5. In this three-reviewer deployment, two release votes choose `RELEASE` and two refund votes choose `REFUND`. Every other executable tally chooses `SPLIT`.
6. Anyone can execute after three reveals, or after the reveal deadline.

After the deadlock timeout, the council can choose the same three outcomes. The panel and council cannot supply a payout address. `ArbiterRegistry` still has an owner-managed allowlist. The fixed outcome threshold remains two if that owner adds reviewers. The ≥2/3 description applies only to the deployed three-reviewer configuration.

## Slide 6: Why Arc

**One asset for gas and escrow**

- USDC is the native gas asset and the escrowed ERC-20 balance.
- ERC-20 precompile/interface: `0x3600000000000000000000000000000000000000`.
- Confirmed transactions have sub-second deterministic finality.
- EVM compatibility supports familiar contracts and wallet flows.

**Track fit**

- **Agentic Economy:** humans and agents can contract, review outcomes, and build settlement history.
- **DeFi:** escrow and payout follow public contract rules instead of operator discretion.

Sources: [Arc connection details](https://docs.arc.io/arc/references/connect-to-arc), [USDC contract reference](https://docs.arc.io/arc/references/contract-addresses), and [deterministic finality](https://docs.arc.io/arc/concepts/deterministic-finality).

## Slide 7: Live proof on Arc Testnet

The app reads these deployed contracts on chain `5042002`:

| Contract | Arc Testnet address | Explorer |
| --- | --- | --- |
| `EscrowFactory` | `0xb6546d4A7FC5B75FF04828165d17e6a4ad397Da3` | [view](https://testnet.arcscan.app/address/0xb6546d4A7FC5B75FF04828165d17e6a4ad397Da3) |
| `EscrowV1` implementation | `0x6A0A6fec9002A5b13AEB08F8Dd001b22739C6a5B` | [view](https://testnet.arcscan.app/address/0x6A0A6fec9002A5b13AEB08F8Dd001b22739C6a5B) |
| `DisputePanel` | `0x0EA143967B3470948329F0304cBBE78Ba8cd827B` | [view](https://testnet.arcscan.app/address/0x0EA143967B3470948329F0304cBBE78Ba8cd827B) |
| `ArbiterRegistry` | `0x4e1395F57DB8781aDdAbeaf689898f82fe6abb59` | [view](https://testnet.arcscan.app/address/0x4e1395F57DB8781aDdAbeaf689898f82fe6abb59) |
| `FeeRouter` | `0x2ab6ba6005b7bE5BCD30F24e8d0E5921e8e489e8` | [view](https://testnet.arcscan.app/address/0x2ab6ba6005b7bE5BCD30F24e8d0E5921e8e489e8) |
| `ReputationRegistryV0` | `0x3962f3e536A55F230bF8Bfa133518eb1Fe1c51e3` | [view](https://testnet.arcscan.app/address/0x3962f3e536A55F230bF8Bfa133518eb1Fe1c51e3) |

The final rehearsal completed create → fund → deliver → dispute → 3× commit → 3× reveal → execute → attest. Its resolved order is [`0x9A30090D090E3C8CA3C9A2FB37116D4f4735bD15`](https://testnet.arcscan.app/address/0x9A30090D090E3C8CA3C9A2FB37116D4f4735bD15).

The receipts show the clone, exact USDC funding, delivery hash, revealed votes, selected outcome, 95/5 payout split, and one-time attestation.

## Slide 8: Authority stays inside fixed bounds

- The per-order escrow holds funds until terminal settlement.
- Resolver input is an enum, not an address or arbitrary call.
- Full refunds have no platform fee.
- Vendor transfers and fee math succeed together or revert together.
- Anyone can execute an available panel outcome.
- Reputation accepts only registered, resolved escrows and rejects duplicate attestations.

Current trust assumptions are the reviewer allowlist owner, configured council, treasury, contract correctness, and off-chain evidence availability.

## Slide 9: Next steps

- close the dispute window when its settlement timeout opens;
- add stake-weighted reviewer participation with bounded power;
- use agreement history for future assignments and rewards;
- define an appeal policy before adding slashing;
- add dispute bonds (the current bond is zero);
- store retrievable evidence dossiers on IPFS;
- add an x402 request flow around the implemented EIP-3009 funding path;
- connect escrow history to ERC-8004 identities.

## Slide 10: Team and ask

**Built for the Arc hackathon by the vAPI team.**

The code is public at <https://github.com/vAPI-Network/vapi-arc>.

**Ask:**

- pressure-test the dispute and timeout design;
- connect us with marketplaces and agent builders that need neutral work review;
- help move the contracts from a tested MVP to an independent audit and adversarial pilot.

**Close:** “Open the live app, choose an order, and verify its state on Arcscan.”
