import { useCallback, useMemo, useState } from "react";
import { data, Link, useLoaderData } from "react-router";
import {
  concatHex,
  getAddress,
  isAddress,
  keccak256,
  pad,
  toBytes,
  toHex,
  type Hex,
} from "viem";

import type { Route } from "./+types/order";
import {
  AddressPill,
  Countdown,
  EmptyState,
  HashField,
  StateChip,
  TxButton,
  formatUsdc,
  usePolling,
} from "~/components/chain-ui";
import {
  EscrowResolution,
  EscrowState,
  escrowV1Abi,
} from "~/lib/abi/escrow-v1";
import { CHAIN_POLL_INTERVAL_MS, getServerChainConfig } from "~/lib/chains";
import { readOrder, type OrderSnapshot } from "~/lib/chain-data";
import { useWallet } from "~/lib/wallet";

export const meta: Route.MetaFunction = ({ params }) => [
  { title: `Order ${params.address?.slice(0, 10) ?? ""} · vAPI` },
  {
    name: "description",
    content: "Inspect and advance a Work + Verify escrow directly on Arc Testnet.",
  },
];

export async function loader({ params }: Route.LoaderArgs) {
  if (!params.address || !isAddress(params.address)) {
    throw data("Invalid address", { status: 400 });
  }
  const config = getServerChainConfig();
  const address = getAddress(params.address);
  const order = await readOrder(config, address);
  if (config.contracts.factory && !order) {
    throw data("Order not found", { status: 404 });
  }
  return { config, address, order };
}

const RESOLUTION_LABELS: Record<number, string> = {
  [EscrowResolution.NONE]: "Pending",
  [EscrowResolution.RELEASE]: "Released to vendor",
  [EscrowResolution.REFUND]: "Refunded to buyer",
  [EscrowResolution.SPLIT]: "Split settlement",
};

function Step({
  state,
  current,
  reached,
}: {
  state: number;
  current: boolean;
  reached: boolean;
}) {
  return (
    <li className={`rail-step ${current ? "rail-current" : ""} ${reached ? "rail-reached" : ""}`}>
      <span className="rail-node" aria-hidden="true" />
      <strong>{state === EscrowState.RESOLVED ? "Resolved" : state === EscrowState.SUBMITTED ? "Submitted" : state === EscrowState.LOCKED ? "Locked" : "Created"}</strong>
    </li>
  );
}

function StateRail({ state }: { state: number }) {
  const main = [
    EscrowState.CREATED,
    EscrowState.LOCKED,
    EscrowState.SUBMITTED,
    EscrowState.RESOLVED,
  ];
  const reached = (step: number) => {
    if (state === EscrowState.DISPUTED) return step <= EscrowState.SUBMITTED;
    if (state === EscrowState.EXPIRED) return step === EscrowState.CREATED;
    return state >= step;
  };
  return (
    <div className="state-rail-wrap">
      <ol className="state-rail" aria-label="Order state">
        {main.map((step) => (
          <Step key={step} state={step} current={state === step} reached={reached(step)} />
        ))}
      </ol>
      <div className="rail-branches">
        <span className={`rail-branch rail-disputed ${state === EscrowState.DISPUTED ? "rail-branch-active" : ""}`}>
          Disputed
        </span>
        <span className={`rail-branch rail-expired ${state === EscrowState.EXPIRED ? "rail-branch-active" : ""}`}>
          Expired
        </span>
      </div>
    </div>
  );
}

function approveData(spender: `0x${string}`, amount: string): Hex {
  return concatHex([
    "0x095ea7b3",
    pad(spender, { size: 32 }),
    pad(toHex(BigInt(amount)), { size: 32 }),
  ]);
}

export default function OrderDetail() {
  const { config, address, order: initial } = useLoaderData<typeof loader>();
  const wallet = useWallet();
  const [delivery, setDelivery] = useState("");
  const [evidence, setEvidence] = useState("");
  const [counterEvidence, setCounterEvidence] = useState("");
  const load = useCallback(
    async () => (await readOrder(config, address)) ?? initial,
    [address, config, initial],
  );
  const [order, setOrder] = usePolling(
    initial,
    load,
    config.mock ? 0 : CHAIN_POLL_INTERVAL_MS,
  );

  if (!config.contracts.factory || !order) {
    return (
      <div className="order-page">
        <Link className="back-link" to="/">Back to marketplace</Link>
        <EmptyState title="Contract addresses pending">
          <p>
            Order reads begin when <code>VAPI_ESCROW_FACTORY</code> is set to the
            Arc deployment address.
          </p>
        </EmptyState>
      </div>
    );
  }

  return (
    <OrderView
      config={config}
      order={order}
      delivery={delivery}
      evidence={evidence}
      counterEvidence={counterEvidence}
      setDelivery={setDelivery}
      setEvidence={setEvidence}
      setCounterEvidence={setCounterEvidence}
      refresh={async () => {
        const next = await load();
        if (next) setOrder(next);
      }}
      wallet={wallet}
    />
  );
}

function OrderView({
  config,
  order,
  delivery,
  evidence,
  counterEvidence,
  setDelivery,
  setEvidence,
  setCounterEvidence,
  refresh,
  wallet,
}: {
  config: ReturnType<typeof getServerChainConfig>;
  order: OrderSnapshot;
  delivery: string;
  evidence: string;
  counterEvidence: string;
  setDelivery(value: string): void;
  setEvidence(value: string): void;
  setCounterEvidence(value: string): void;
  refresh(): Promise<void>;
  wallet: ReturnType<typeof useWallet>;
}) {
  const now = Math.floor(Date.now() / 1000);
  const account = wallet.account?.toLowerCase();
  const isBuyer = account === order.buyer.toLowerCase();
  const isSeller = account === order.seller.toLowerCase();
  const isParty = isBuyer || isSeller;
  const isCounterparty =
    order.state === EscrowState.DISPUTED &&
    Boolean(account && order.disputeRaisedBy) &&
    account !== order.disputeRaisedBy?.toLowerCase() &&
    isParty;
  const deliveryHash = useMemo(
    () => keccak256(toBytes(delivery.trim())),
    [delivery],
  );
  const evidenceHash = useMemo(
    () => keccak256(toBytes(evidence.trim())),
    [evidence],
  );
  const counterHash = useMemo(
    () => keccak256(toBytes(counterEvidence.trim())),
    [counterEvidence],
  );
  const write = (functionName: string, args?: readonly unknown[]) =>
    wallet.writeContract({
      address: order.address,
      abi: escrowV1Abi,
      functionName,
      args,
    });

  const activeDeadline =
    order.state === EscrowState.CREATED
      ? { value: order.offerDeadline, label: "Funding closes" }
      : order.state === EscrowState.LOCKED
        ? { value: order.workDeadline, label: "Delivery due" }
        : order.state === EscrowState.SUBMITTED
          ? { value: order.reviewDeadline, label: "Review closes" }
          : order.state === EscrowState.DISPUTED
            ? { value: order.counterEvidenceDeadline, label: "Counter-evidence due" }
            : undefined;

  return (
    <div className="order-page">
      <Link className="back-link" to="/">Back to marketplace</Link>
      <header className="order-hero">
        <div>
          <div className="order-title-line">
            <StateChip state={order.state} />
            <span className="mono block-mark">Created in block #{order.blockNumber}</span>
          </div>
          <h1>{formatUsdc(order.amount)}</h1>
          <p className="roman-subtitle">A single covenant, settled by the chain</p>
          <AddressPill address={order.address} />
        </div>
        {activeDeadline ? (
          <Countdown deadline={activeDeadline.value} label={activeDeadline.label} />
        ) : (
          <div className="resolution-panel">
            <span>Final resolution</span>
            <strong>{RESOLUTION_LABELS[order.resolution]}</strong>
            <small>Immutable settlement on Arc</small>
          </div>
        )}
      </header>

      <StateRail state={order.state} />

      <section className="order-facts" aria-label="Order participants and terms">
        <div className="fact-block">
          <span>Vendor</span>
          <AddressPill address={order.seller} />
          {isSeller && <b className="role-badge">You · Vendor</b>}
        </div>
        <div className="fact-block">
          <span>Buyer</span>
          <AddressPill address={order.buyer} />
          {isBuyer && <b className="role-badge">You · Buyer</b>}
        </div>
        <div className="fact-block fact-hash">
          <span>Terms commitment</span>
          <code>{order.termsHash}</code>
        </div>
        {order.deliveryHash !== `0x${"0".repeat(64)}` && (
          <div className="fact-block fact-hash">
            <span>Delivery commitment</span>
            <code>{order.deliveryHash}</code>
          </div>
        )}
      </section>

      <section className="actions-section" aria-labelledby="actions-heading">
        <div className="section-heading actions-heading">
          <div>
            <h2 id="actions-heading">Available actions</h2>
            <p>Only actions valid for this state and connected actor are shown.</p>
          </div>
          {!wallet.account && <span className="action-context">Connect a wallet to act</span>}
          {wallet.account && !isParty && <span className="action-context">Observer account</span>}
        </div>

        <div className="action-layout">
          {isBuyer && order.state === EscrowState.CREATED && (
            <article className="action-module funding-module">
              <div className="action-copy">
                <span className="action-kicker">Buyer · funding</span>
                <h3>Lock {formatUsdc(order.amount)}</h3>
                <p>
                  Approve the USDC precompile first, then let the escrow pull the
                  exact order amount. USDC also pays Arc gas.
                </p>
              </div>
              <ol className="funding-steps">
                <li>
                  <span className="step-number mono">1</span>
                  <div>
                    <strong>Approve USDC</strong>
                    <TxButton
                      config={config}
                      execute={() =>
                        wallet.sendTransaction(
                          config.usdc,
                          approveData(order.address, order.amount),
                        )
                      }
                    >
                      Approve exact amount
                    </TxButton>
                  </div>
                </li>
                <li>
                  <span className="step-number mono">2</span>
                  <div>
                    <strong>Deposit into escrow</strong>
                    <TxButton
                      config={config}
                      execute={() => write("depositFunds")}
                      onConfirmed={refresh}
                    >
                      Fund order
                    </TxButton>
                  </div>
                </li>
              </ol>
            </article>
          )}

          {isSeller && order.state === EscrowState.LOCKED && (
            <article className="action-module text-action-module">
              <div className="action-copy">
                <span className="action-kicker">Vendor · delivery</span>
                <h3>Submit the work</h3>
                <p>The delivery stays private; its UTF-8 commitment goes on-chain.</p>
              </div>
              <label className="field">
                <span>Delivery or evidence text</span>
                <textarea
                  rows={4}
                  value={delivery}
                  onChange={(event) => setDelivery(event.target.value)}
                  placeholder="Paste the final delivery record or content-addressed reference."
                />
              </label>
              <HashField value={deliveryHash} label="Delivery hash" />
              <TxButton
                config={config}
                execute={() => write("submitDelivery", [deliveryHash])}
                disabled={!delivery.trim()}
                onConfirmed={refresh}
              >
                Submit delivery
              </TxButton>
            </article>
          )}

          {isBuyer && order.state === EscrowState.SUBMITTED && (
            <article className="action-module decisive-module">
              <div className="action-copy">
                <span className="action-kicker">Buyer · acceptance</span>
                <h3>Accept the delivery</h3>
                <p>Release the escrowed amount to the vendor, less the protocol fee.</p>
              </div>
              <TxButton config={config} execute={() => write("releaseFunds")} onConfirmed={refresh}>
                Release funds
              </TxButton>
            </article>
          )}

          {isSeller &&
            (order.state === EscrowState.LOCKED || order.state === EscrowState.SUBMITTED) && (
              <article className="action-module">
                <div className="action-copy">
                  <span className="action-kicker">Vendor · concession</span>
                  <h3>Return the escrow</h3>
                  <p>Refund the full locked amount to the buyer.</p>
                </div>
                <TxButton config={config} execute={() => write("refundBuyer")} onConfirmed={refresh}>
                  Refund buyer
                </TxButton>
              </article>
            )}

          {isParty &&
            (order.state === EscrowState.LOCKED || order.state === EscrowState.SUBMITTED) && (
              <article className="action-module dispute-module">
                <div className="action-copy">
                  <span className="action-kicker">Buyer or vendor · dispute</span>
                  <h3>Raise a dispute</h3>
                  <p>Commit evidence for a three-seat independent panel to resolve.</p>
                </div>
                <label className="field">
                  <span>Evidence text</span>
                  <textarea
                    rows={4}
                    value={evidence}
                    onChange={(event) => setEvidence(event.target.value)}
                    placeholder="State the claim and include content-addressed evidence references."
                  />
                </label>
                <HashField value={evidenceHash} label="Evidence hash" />
                <TxButton
                  config={config}
                  execute={() => write("raiseDispute", [evidenceHash])}
                  disabled={!evidence.trim()}
                  onConfirmed={refresh}
                >
                  Raise dispute
                </TxButton>
              </article>
            )}

          {isCounterparty && now <= order.counterEvidenceDeadline && (
            <article className="action-module dispute-module">
              <div className="action-copy">
                <span className="action-kicker">Counterparty · response</span>
                <h3>Submit counter-evidence</h3>
                <p>One response is allowed before the evidence deadline.</p>
              </div>
              <label className="field">
                <span>Counter-evidence text</span>
                <textarea
                  rows={4}
                  value={counterEvidence}
                  onChange={(event) => setCounterEvidence(event.target.value)}
                  placeholder="Answer the claim with verifiable references."
                />
              </label>
              <HashField value={counterHash} label="Counter-evidence hash" />
              <TxButton
                config={config}
                execute={() => write("submitCounterEvidence", [counterHash])}
                disabled={!counterEvidence.trim()}
                onConfirmed={refresh}
              >
                Submit counter-evidence
              </TxButton>
            </article>
          )}

          {order.state === EscrowState.LOCKED && now > order.workDeadline && (
            <article className="action-module crank-module">
              <div className="action-copy">
                <span className="action-kicker">Permissionless · timeout</span>
                <h3>Delivery window elapsed</h3>
                <p>Anyone can return the escrow to the buyer.</p>
              </div>
              <TxButton config={config} execute={() => write("timeoutRefund")} onConfirmed={refresh}>
                Timeout refund
              </TxButton>
            </article>
          )}

          {order.state === EscrowState.SUBMITTED && now > order.reviewDeadline && (
            <article className="action-module crank-module">
              <div className="action-copy">
                <span className="action-kicker">Permissionless · finalization</span>
                <h3>Review window elapsed</h3>
                <p>Anyone can release the order to the vendor.</p>
              </div>
              <TxButton config={config} execute={() => write("finalize")} onConfirmed={refresh}>
                Finalize order
              </TxButton>
            </article>
          )}
        </div>
      </section>
    </div>
  );
}
