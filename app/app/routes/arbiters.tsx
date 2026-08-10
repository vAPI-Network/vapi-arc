import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useLoaderData } from "react-router";
import { encodePacked, keccak256, toHex, type Address, type Hex } from "viem";

import type { Route } from "./+types/arbiters";
import {
  AddressPill,
  ChainError,
  Countdown,
  EmptyState,
  HashField,
  TxButton,
  usePolling,
} from "~/components/chain-ui";
import {
  COMMIT_HASH,
  PanelVoteValue,
  disputePanelAbi,
} from "~/lib/abi/escrow-v1";
import { CHAIN_POLL_INTERVAL_MS, getServerChainConfig } from "~/lib/chains";
import { readDisputes, type DisputeSnapshot } from "~/lib/chain-data";
import { useWallet } from "~/lib/wallet";

export const meta: Route.MetaFunction = () => [
  { title: "Dispute queue · vAPI Praetors" },
  {
    name: "description",
    content: "Commit, reveal, and execute three-seat escrow dispute votes on Arc.",
  },
];

export async function loader() {
  const config = getServerChainConfig();
  return { config, snapshot: await readDisputes(config) };
}

type SavedBallot = { vote: number; salt: Hex };

const VOTE_LABELS: Record<number, string> = {
  [PanelVoteValue.RELEASE]: "Release to vendor",
  [PanelVoteValue.REFUND]: "Refund buyer",
  [PanelVoteValue.SPLIT]: "Split settlement",
};

const OUTCOME_LABELS = ["Released to vendor", "Refunded to buyer", "Split settlement"];

function randomSalt(): Hex {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

function ballotKey(escrow: Address, arbiter: Address) {
  return `vapi:ballot:${escrow.toLowerCase()}:${arbiter.toLowerCase()}`;
}

function DisputeCard({
  dispute,
  config,
  refresh,
}: {
  dispute: DisputeSnapshot;
  config: ReturnType<typeof getServerChainConfig>;
  refresh(): Promise<void>;
}) {
  const wallet = useWallet();
  const panel = config.contracts.disputePanel!;
  const [vote, setVote] = useState(PanelVoteValue.RELEASE);
  const [saved, setSaved] = useState<SavedBallot>();
  const [storageReady, setStorageReady] = useState(false);
  const now = Math.floor(Date.now() / 1000);
  const inCommit = now < dispute.commitDeadline;
  const inReveal = now >= dispute.commitDeadline && now < dispute.revealDeadline;
  const executable =
    !dispute.executed && (now >= dispute.revealDeadline || dispute.revealed >= 3);

  useEffect(() => {
    setStorageReady(false);
    if (!wallet.account) {
      setSaved(undefined);
      return;
    }
    const raw = localStorage.getItem(ballotKey(dispute.escrow, wallet.account));
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as SavedBallot;
        if (parsed.salt?.startsWith("0x") && VOTE_LABELS[parsed.vote]) {
          setSaved(parsed);
          setVote(parsed.vote as typeof vote);
        }
      } catch {
        localStorage.removeItem(ballotKey(dispute.escrow, wallet.account));
      }
    } else {
      setSaved(undefined);
    }
    setStorageReady(true);
  }, [dispute.escrow, wallet.account]);

  const commitment = useMemo(() => {
    if (!wallet.account || !saved) return undefined;
    return keccak256(
      encodePacked(
        ["address", "address", "uint8", "bytes32"],
        [dispute.escrow, wallet.account, saved.vote, saved.salt],
      ),
    );
  }, [dispute.escrow, saved, wallet.account]);

  function saveBallot() {
    if (!wallet.account) return;
    const next = { vote, salt: randomSalt() } satisfies SavedBallot;
    localStorage.setItem(
      ballotKey(dispute.escrow, wallet.account),
      JSON.stringify(next),
    );
    setSaved(next);
  }

  const write = (functionName: string, args: readonly unknown[]) =>
    wallet.writeContract({
      address: panel,
      abi: disputePanelAbi,
      functionName,
      args,
    });

  return (
    <article className="dispute-record">
      <header className="dispute-header">
        <div>
          <span className="case-phase">
            <span aria-hidden="true" />
            {dispute.executed
              ? "Executed"
              : inCommit
                ? "Commit window"
                : inReveal
                  ? "Reveal window"
                  : "Ready to execute"}
          </span>
          <h2>
            Case <span className="mono">{dispute.escrow.slice(0, 10)}…{dispute.escrow.slice(-6)}</span>
          </h2>
          <div className="case-addresses">
            <AddressPill address={dispute.escrow} label="Escrow" href={`/orders/${dispute.escrow}`} />
            <AddressPill address={dispute.raisedBy} label="Raised by" />
          </div>
        </div>
        {!dispute.executed && (
          <Countdown
            deadline={inCommit ? dispute.commitDeadline : dispute.revealDeadline}
            label={inCommit ? "Commit closes" : "Reveal closes"}
          />
        )}
        {dispute.executed && (
          <div className="outcome-stamp">
            <span>Outcome</span>
            <strong>{OUTCOME_LABELS[dispute.outcome ?? 2]}</strong>
          </div>
        )}
      </header>

      <div className="panel-tally" aria-label="Three-seat panel tally">
        <div className="seat-visual" aria-hidden="true">
          {[0, 1, 2].map((seat) => (
            <span
              key={seat}
              className={seat < dispute.revealed ? "seat-revealed" : seat < dispute.committed ? "seat-committed" : ""}
            >
              {seat + 1}
            </span>
          ))}
        </div>
        <div className="tally-stat">
          <strong className="mono">{dispute.committed}/3</strong>
          <span>Committed</span>
        </div>
        <div className="tally-stat">
          <strong className="mono">{dispute.revealed}/3</strong>
          <span>Revealed</span>
        </div>
        <div className="vote-tally">
          <span>Release <b className="mono">{dispute.releaseVotes}</b></span>
          <span>Refund <b className="mono">{dispute.refundVotes}</b></span>
          <span>Split <b className="mono">{dispute.splitVotes}</b></span>
        </div>
      </div>

      {!dispute.executed && (
        <div className="ballot-area">
          {inCommit && (
            <section className="ballot-form">
              <div className="ballot-copy">
                <h3>Commit a sealed vote</h3>
                <p>
                  Your choice and random salt are hashed locally. Only the
                  commitment reaches Arc during this phase.
                </p>
              </div>
              <label className="field">
                <span>Panel vote</span>
                <select
                  value={vote}
                  onChange={(event) => setVote(Number(event.target.value) as typeof vote)}
                  disabled={!wallet.isArbiter}
                >
                  {Object.entries(VOTE_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="secondary-button"
                disabled={!wallet.isArbiter}
                onClick={saveBallot}
              >
                {saved ? "Regenerate salt & replace local ballot" : "Generate salt & save ballot"}
              </button>
              {saved && commitment && (
                <div className="secret-fields">
                  <HashField value={saved.salt} label="Secret salt · saved in this browser" />
                  <HashField value={commitment} label="Commitment" />
                  <div className="salt-warning" role="alert">
                    <strong>Lost salt = lost vote.</strong>
                    <span>Copy it somewhere safe before committing. Browser storage is not a wallet backup.</span>
                  </div>
                </div>
              )}
              <TxButton
                config={config}
                disabled={!wallet.isArbiter || !storageReady || !commitment}
                execute={() => write("commit", [dispute.escrow, commitment!])}
                onConfirmed={refresh}
              >
                Commit sealed vote
              </TxButton>
            </section>
          )}

          {inReveal && (
            <section className="ballot-form reveal-form">
              <div className="ballot-copy">
                <h3>Reveal your saved vote</h3>
                <p>The contract recomputes the exact packed commitment before accepting it.</p>
              </div>
              {saved ? (
                <>
                  <div className="reveal-summary">
                    <span>Saved choice</span>
                    <strong>{VOTE_LABELS[saved.vote]}</strong>
                  </div>
                  <HashField value={saved.salt} label="Prefilled salt" />
                  <div className="salt-warning" role="alert">
                    <strong>Lost salt = lost vote.</strong>
                    <span>This reveal depends on the exact salt created during commit.</span>
                  </div>
                </>
              ) : (
                <div className="missing-ballot">
                  No local ballot was found for this dispute and connected arbiter.
                </div>
              )}
              <TxButton
                config={config}
                disabled={!wallet.isArbiter || !saved}
                execute={() => write("reveal", [dispute.escrow, saved!.vote, saved!.salt])}
                onConfirmed={refresh}
              >
                Reveal vote
              </TxButton>
            </section>
          )}

          {executable && (
            <section className="execute-bar">
              <div>
                <h3>Panel result is executable</h3>
                <p>{dispute.revealed >= 3 ? "All three seats have revealed." : "The reveal window has elapsed."} Anyone may settle the escrow.</p>
              </div>
              <TxButton
                config={config}
                execute={() => write("execute", [dispute.escrow])}
                onConfirmed={refresh}
              >
                Execute result
              </TxButton>
            </section>
          )}
        </div>
      )}

      <details className="formula-note">
        <summary>Commitment formula</summary>
        <code>{COMMIT_HASH}</code>
      </details>
    </article>
  );
}

export default function Arbiters() {
  const { config, snapshot: initial } = useLoaderData<typeof loader>();
  const wallet = useWallet();
  const load = useCallback(() => readDisputes(config), [config]);
  const [snapshot, setSnapshot] = usePolling(
    initial,
    load,
    config.mock ? 0 : CHAIN_POLL_INTERVAL_MS,
  );
  const panelReady = Boolean(
    config.contracts.disputePanel && config.contracts.arbiterRegistry,
  );

  return (
    <div className="arbiters-page">
      <header className="page-intro">
        <div>
          <h1>Dispute queue</h1>
          <p className="roman-subtitle">The Praetors · sealed votes, public settlement</p>
          <p className="page-lede">
            Three registered arbiters commit in secret, reveal in public, and let
            the panel contract execute the majority outcome.
          </p>
        </div>
        <div className="arbiter-identity">
          <span>Connected capacity</span>
          <strong>{wallet.isArbiter ? "Registered arbiter" : wallet.account ? "Observer" : "Wallet not connected"}</strong>
        </div>
      </header>
      <ChainError message={snapshot.error} />

      <div className="praetor-layout">
        <section className="dispute-queue" aria-labelledby="queue-heading">
          <div className="section-heading">
            <div>
              <h2 id="queue-heading">Open panel cases</h2>
              <p>Derived from panel events; refreshed every 12 seconds.</p>
            </div>
            <span className="record-count mono">{snapshot.disputes.length} cases</span>
          </div>
          {!panelReady ? (
            <EmptyState title="Panel addresses pending">
              <p>
                Set <code>VAPI_DISPUTE_PANEL</code> and <code>VAPI_ARBITER_REGISTRY</code>
                once the Arc deployment completes.
              </p>
            </EmptyState>
          ) : snapshot.disputes.length === 0 ? (
            <EmptyState title="No disputes are waiting">
              <p>There are no <code>DisputeOpened</code> events in the deployment range.</p>
            </EmptyState>
          ) : (
            <div className="dispute-list">
              {snapshot.disputes.map((dispute) => (
                <DisputeCard
                  key={dispute.escrow}
                  dispute={dispute}
                  config={config}
                  refresh={async () => setSnapshot(await load())}
                />
              ))}
            </div>
          )}
        </section>

        <aside className="roadmap-panel">
          <span className="roadmap-label">Roadmap · not live in V0</span>
          <h2>Economic security comes next</h2>
          <p>
            Today, each allowlisted arbiter carries one equal vote. The current
            deployment has no vote rewards or financial penalties.
          </p>
          <ul>
            <li><strong>Stake-weighted power</strong><span>Eligibility and influence backed by locked stake.</span></li>
            <li><strong>Accuracy history</strong><span>Agreement with executed outcomes tracked over time.</span></li>
            <li><strong>Slashing</strong><span>Penalties for provable non-reveal or malicious conduct.</span></li>
            <li><strong>Dispute bonds</strong><span>Economic friction for parties opening weak claims.</span></li>
          </ul>
          <Link to="/reputation" className="text-link">See the live V0 reputation ledger</Link>
        </aside>
      </div>
    </div>
  );
}
