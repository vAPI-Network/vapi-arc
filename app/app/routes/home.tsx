import { useCallback, useMemo, useState } from "react";
import { Link, useLoaderData } from "react-router";
import {
  getAddress,
  isAddress,
  keccak256,
  parseUnits,
  toBytes,
  toHex,
  type Hex,
} from "viem";

import type { Route } from "./+types/home";
import {
  AddressPill,
  ChainError,
  Countdown,
  EmptyState,
  HashField,
  StateChip,
  TxButton,
  formatUsdc,
  usePolling,
} from "~/components/chain-ui";
import { EscrowState, escrowFactoryAbi } from "~/lib/abi/escrow-v1";
import { CHAIN_POLL_INTERVAL_MS, getServerChainConfig } from "~/lib/chains";
import { readMarketplace } from "~/lib/chain-data";
import { useWallet } from "~/lib/wallet";

export const meta: Route.MetaFunction = () => [
  { title: "Work marketplace · vAPI on Arc" },
  {
    name: "description",
    content: "Create and inspect Work + Verify escrows directly from Arc Testnet.",
  },
];

export async function loader() {
  const config = getServerChainConfig();
  return { config, snapshot: await readMarketplace(config) };
}

const ORDER_STATUS: Record<number, string> = {
  [EscrowState.CREATED]: "Offer open — waiting for the client to fund",
  [EscrowState.LOCKED]: "Funded — vendor is working",
  [EscrowState.SUBMITTED]: "Delivered — waiting for client review",
  [EscrowState.DISPUTED]: "In dispute — the arbiter panel is voting",
  [EscrowState.RESOLVED]: "Completed — funds settled",
  [EscrowState.EXPIRED]: "Offer expired",
};

function randomSalt(): Hex {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

export default function Marketplace() {
  const { config, snapshot: initial } = useLoaderData<typeof loader>();
  const wallet = useWallet();
  const [buyer, setBuyer] = useState("");
  const [amount, setAmount] = useState("125");
  const [workDays, setWorkDays] = useState("7");
  const [reviewHours, setReviewHours] = useState("48");
  const [terms, setTerms] = useState("");
  const load = useCallback(() => readMarketplace(config), [config]);
  const [snapshot, setSnapshot] = usePolling(
    initial,
    load,
    config.mock ? 0 : CHAIN_POLL_INTERVAL_MS,
  );
  const termsHash = useMemo(
    () => keccak256(toBytes(terms.trim())),
    [terms],
  );
  const factory = config.contracts.factory;
  const formValid =
    Boolean(factory && wallet.account && isAddress(buyer) && terms.trim()) &&
    Number(amount) > 0 &&
    Number(workDays) > 0 &&
    Number(reviewHours) > 0;

  const createEscrow = () => {
    if (!factory || !wallet.account || !isAddress(buyer)) {
      throw new Error("Connect a vendor wallet and enter a valid client address.");
    }
    return wallet.writeContract({
      address: factory,
      abi: escrowFactoryAbi,
      functionName: "createEscrow",
      args: [
        getAddress(buyer),
        config.usdc,
        parseUnits(amount, 6),
        BigInt(Math.round(Number(workDays) * 86_400)),
        BigInt(Math.round(Number(reviewHours) * 3_600)),
        termsHash,
        randomSalt(),
      ],
    });
  };

  return (
    <div className="marketplace-page">
      <header className="page-intro marketplace-intro">
        <div>
          <h1>Work marketplace</h1>
          <p className="roman-subtitle">The Forum — every agreement begins in public</p>
          <p className="page-lede">
            Hire with confidence: clients fund the escrow, vendors deliver the
            work, and every settlement is verified on Arc.
          </p>
        </div>
        <div className="chain-pulse" aria-label="Live Arc Testnet data">
          <span className="network-dot" aria-hidden="true" />
          <span>
            <strong>Arc Testnet</strong>
            <small>
              {snapshot.blockNumber ? `Block ${snapshot.blockNumber}` : "Awaiting deployment"}
            </small>
          </span>
        </div>
      </header>

      <section className="how-it-works" aria-labelledby="how-it-works-heading">
        <h2 id="how-it-works-heading">How it works</h2>
        <ol>
          <li><span className="mono">1</span><strong>Client funds a USDC escrow</strong></li>
          <li><span className="mono">2</span><strong>Vendor delivers the work</strong></li>
          <li><span className="mono">3</span><strong>Funds release automatically — disputes go to a 3-reviewer panel</strong></li>
        </ol>
      </section>

      <ChainError message={snapshot.error} />

      <section className="market-grid" aria-labelledby="open-escrows-heading">
        <div className="market-list">
          <div className="section-heading">
            <div>
              <h2 id="open-escrows-heading">Escrows on Arc</h2>
              <p>
                Each order is its own escrow contract on Arc — funds never sit with a platform
                wallet. State rechecked every 12 seconds.
              </p>
            </div>
            <span className="record-count mono">
              {snapshot.orders.length} {snapshot.orders.length === 1 ? "order" : "orders"}
            </span>
          </div>

          {!factory ? (
            <EmptyState title="Contract addresses pending">
              <p>
                The interface is ready. Set <code>VAPI_ESCROW_FACTORY</code> after
                the deployment track publishes the Arc address.
              </p>
            </EmptyState>
          ) : snapshot.orders.length === 0 ? (
            <EmptyState title="No escrows have been opened">
              <p>
                The factory has no <code>EscrowCreated</code> events from the
                configured deployment block. A connected vendor can open the first.
              </p>
            </EmptyState>
          ) : (
            <div className="order-list">
              {snapshot.orders.map((order) => (
                <article className="order-row" key={order.address}>
                  <Link to={`/orders/${order.address}`} className="order-row-main">
                    <span className="order-row-state">
                      <StateChip state={order.state} />
                      <span className="block-mark mono">#{order.blockNumber}</span>
                    </span>
                    <strong className="order-amount">{formatUsdc(order.amount)}</strong>
                    <span className="order-status">
                      {ORDER_STATUS[order.state] ?? "Order status unavailable"}
                    </span>
                    <span className="order-address mono">
                      {order.address.slice(0, 10)}…{order.address.slice(-6)}
                    </span>
                  </Link>
                  <div className="order-parties">
                    <AddressPill address={order.seller} label="Vendor" />
                    <span className="party-arrow" aria-hidden="true" />
                    <AddressPill address={order.buyer} label="Client" />
                  </div>
                  {order.state === EscrowState.CREATED && (
                    <div className="order-row-deadline">
                      <span>Offer window</span>
                      <Countdown
                        deadline={order.offerDeadline}
                        label="Offer window"
                        compact
                      />
                    </div>
                  )}
                  <Link className="row-link" to={`/orders/${order.address}`}>
                    Inspect order
                  </Link>
                </article>
              ))}
            </div>
          )}
        </div>

        <aside className="create-panel" aria-labelledby="create-heading">
          <div className="create-panel-heading">
            <div>
              <h2 id="create-heading">Create an escrow</h2>
              <p>Vendor action</p>
            </div>
            {wallet.account && <span className="role-badge">Vendor</span>}
          </div>
          <div className="form-stack">
            <label className="field">
              <span>Client address</span>
              <input
                value={buyer}
                onChange={(event) => setBuyer(event.target.value)}
                placeholder="0x…"
                spellCheck={false}
              />
            </label>
            <div className="field-split">
              <label className="field">
                <span>Amount</span>
                <div className="input-affix">
                  <input
                    type="number"
                    min="0.000001"
                    step="0.000001"
                    value={amount}
                    onChange={(event) => setAmount(event.target.value)}
                  />
                  <b>USDC</b>
                </div>
              </label>
              <label className="field">
                <span>Work duration</span>
                <div className="input-affix">
                  <input
                    type="number"
                    min="1"
                    value={workDays}
                    onChange={(event) => setWorkDays(event.target.value)}
                  />
                  <b>days</b>
                </div>
              </label>
            </div>
            <label className="field">
              <span>Client review window</span>
              <div className="input-affix">
                <input
                  type="number"
                  min="1"
                  value={reviewHours}
                  onChange={(event) => setReviewHours(event.target.value)}
                />
                <b>hours</b>
              </div>
            </label>
            <label className="field">
              <span>Terms</span>
              <textarea
                value={terms}
                onChange={(event) => setTerms(event.target.value)}
                placeholder="Describe the delivery and acceptance criteria."
                rows={5}
              />
            </label>
            <HashField value={termsHash} label="Terms hash · keccak256 UTF-8" />
            {!wallet.connected && (
              <p className="form-note">Connect the vendor account to create this escrow.</p>
            )}
            <TxButton
              config={config}
              execute={createEscrow}
              disabled={!formValid}
              onConfirmed={async () => setSnapshot(await load())}
            >
              Create escrow on Arc
            </TxButton>
          </div>
        </aside>
      </section>
    </div>
  );
}
