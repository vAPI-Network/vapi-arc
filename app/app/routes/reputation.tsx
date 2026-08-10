import { useCallback } from "react";
import { Form, Link, useLoaderData, useNavigate } from "react-router";
import { getAddress, isAddress } from "viem";

import type { Route } from "./+types/reputation";
import {
  AddressPill,
  ChainError,
  EmptyState,
  StateChip,
  TxButton,
  usePolling,
} from "~/components/chain-ui";
import { reputationRegistryAbi } from "~/lib/abi/escrow-v1";
import { CHAIN_POLL_INTERVAL_MS, getServerChainConfig } from "~/lib/chains";
import { readReputation } from "~/lib/chain-data";
import { useWallet } from "~/lib/wallet";

export const meta: Route.MetaFunction = () => [
  { title: "Reputation · vAPI on Arc" },
  {
    name: "description",
    content: "Search settlement reputation and attest resolved escrows on Arc Testnet.",
  },
];

export async function loader({ request }: Route.LoaderArgs) {
  const config = getServerChainConfig();
  const value = new URL(request.url).searchParams.get("address")?.trim() ?? "";
  const subject = value && isAddress(value) ? getAddress(value) : undefined;
  return {
    config,
    value,
    invalid: Boolean(value && !subject),
    snapshot: await readReputation(config, subject),
  };
}

const RESOLUTIONS: Record<number, string> = {
  1: "Released",
  2: "Refunded",
  3: "Split",
};

export default function Reputation() {
  const { config, value, invalid, snapshot: initial } = useLoaderData<typeof loader>();
  const wallet = useWallet();
  const navigate = useNavigate();
  const subject = initial.subject;
  const load = useCallback(
    () => readReputation(config, subject),
    [config, subject],
  );
  const [snapshot, setSnapshot] = usePolling(
    initial,
    load,
    config.mock ? 0 : CHAIN_POLL_INTERVAL_MS,
  );
  const registry = config.contracts.reputationRegistry;

  return (
    <div className="reputation-page">
      <header className="page-intro census-intro">
        <div>
          <h1>Reputation</h1>
          <p className="roman-subtitle">The Census — count only what the chain can prove</p>
          <p className="page-lede">
            A work history that cannot be embellished: every number is counted from
            settled escrows on Arc, and every ledger row links to the transaction
            that proves it.
          </p>
        </div>
      </header>

      <section className="search-band" aria-labelledby="search-heading">
        <div>
          <h2 id="search-heading">Search a wallet</h2>
          <p>Client and vendor outcomes accrue to the same portable address.</p>
        </div>
        <Form method="get" className="wallet-search">
          <label className="sr-only" htmlFor="reputation-address">Wallet address</label>
          <input
            id="reputation-address"
            name="address"
            defaultValue={value}
            placeholder="0x wallet address"
            spellCheck={false}
            aria-invalid={invalid || undefined}
          />
          <button type="submit" className="action-button">Read score</button>
        </Form>
        {wallet.account && (
          <button
            type="button"
            className="connected-search"
            onClick={() => navigate(`/reputation?address=${wallet.account}`)}
          >
            Use connected actor
          </button>
        )}
        {invalid && <p className="field-error">Enter a complete 0x-prefixed EVM address.</p>}
      </section>

      <ChainError message={snapshot.error} />

      {!registry ? (
        <EmptyState title="Registry address pending">
          <p>
            Set <code>VAPI_REPUTATION_REGISTRY</code> when the deployment track
            publishes the Arc address.
          </p>
        </EmptyState>
      ) : !subject ? (
        <EmptyState title="Search the settlement ledger">
          <p>Enter any client or vendor wallet to read its five on-chain counters.</p>
        </EmptyState>
      ) : (
        <>
          <section className="score-section" aria-labelledby="score-heading">
            <div className="score-identity">
              <div>
                <span className="score-label">On-chain score</span>
                <h2 id="score-heading">Wallet record</h2>
              </div>
              <AddressPill address={subject} />
            </div>
            <div className="score-grid">
              {[
                ["Jobs settled", snapshot.score?.settled ?? 0],
                ["Released to vendor", snapshot.score?.released ?? 0],
                ["Refunded to client", snapshot.score?.refunded ?? 0],
                ["Disputed", snapshot.score?.disputed ?? 0],
                ["Splits", snapshot.score?.splits ?? 0],
              ].map(([label, score]) => (
                <div className="score-tile" key={label}>
                  <strong className="mono">{score}</strong>
                  <span>{label}</span>
                </div>
              ))}
            </div>
          </section>

          {snapshot.unattested.length > 0 && (
            <section className="attest-section" aria-labelledby="attest-heading">
              <div className="section-heading">
                <div>
                  <h2 id="attest-heading">Resolved, awaiting attestation</h2>
                  <p>A permissionless crank records both parties’ score counters.</p>
                </div>
              </div>
              <div className="attest-list">
                {snapshot.unattested.map((order) => (
                  <article className="attest-row" key={order.address}>
                    <div>
                      <StateChip state={order.state} />
                      <Link to={`/orders/${order.address}`} className="mono">
                        {order.address.slice(0, 10)}…{order.address.slice(-6)}
                      </Link>
                    </div>
                    <TxButton
                      config={config}
                      disabled={!wallet.account}
                      execute={() =>
                        wallet.writeContract({
                          address: registry,
                          abi: reputationRegistryAbi,
                          functionName: "attest",
                          args: [order.address],
                        })
                      }
                      onConfirmed={async () => setSnapshot(await load())}
                    >
                      Attest settlement
                    </TxButton>
                  </article>
                ))}
              </div>
            </section>
          )}

          <section className="ledger-section" aria-labelledby="ledger-heading">
            <div className="section-heading">
              <div>
                <h2 id="ledger-heading">Attestation ledger</h2>
                <p><code>SettlementAttested</code> events involving this wallet.</p>
              </div>
              <span className="record-count mono">{snapshot.attestations.length} records</span>
            </div>
            {snapshot.attestations.length === 0 ? (
              <EmptyState title="No attestations yet">
                <p>This wallet has no settlement attestations in the deployment range.</p>
              </EmptyState>
            ) : (
              <div className="ledger-table-wrap">
                <table className="ledger-table">
                  <thead>
                    <tr>
                      <th>Settlement</th>
                      <th>Vendor</th>
                      <th>Client</th>
                      <th>Block</th>
                      <th>Proof</th>
                    </tr>
                  </thead>
                  <tbody>
                    {snapshot.attestations.map((entry) => (
                      <tr key={`${entry.transactionHash}-${entry.escrow}`}>
                        <td>
                          <Link to={`/orders/${entry.escrow}`} className="ledger-order">
                            <strong>{RESOLUTIONS[entry.resolution]}</strong>
                            <span className="mono">{entry.escrow.slice(0, 8)}…{entry.escrow.slice(-4)}</span>
                          </Link>
                        </td>
                        <td><AddressPill address={entry.seller} /></td>
                        <td><AddressPill address={entry.buyer} /></td>
                        <td className="mono">#{entry.blockNumber}</td>
                        <td>
                          <a
                            className="text-link"
                            href={`${config.explorerUrl}/tx/${entry.transactionHash}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            ArcScan tx
                          </a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
