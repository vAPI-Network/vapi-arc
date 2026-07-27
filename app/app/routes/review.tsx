import type { Route } from "./+types/review";
import {
  NetworkPill,
  SetupBanner,
  ShortHash,
  StatusChip,
  TxLink,
} from "~/components/ui";
import { getReviewData } from "~/lib/chain.server";

export async function loader() {
  return getReviewData();
}

export default function Review({ loaderData }: Route.ComponentProps) {
  const { configured, queue } = loaderData;

  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">Human fallback</p>
          <h1>Review queue</h1>
          <p className="lede">
            Jobs the guarded evaluator refused to settle automatically. Review
            happens before funds move; ERC-8183 settlement is terminal.
          </p>
        </div>
        <NetworkPill />
      </div>

      {!configured && <SetupBanner />}

      <section aria-labelledby="queue-heading">
        <div className="section-bar">
          <h2 id="queue-heading">Awaiting resolution</h2>
          <p>{queue.length} open</p>
        </div>

        {queue.length === 0 ? (
          <div className="empty-state">
            <h2>No jobs awaiting human review</h2>
            <p>
              Escalated jobs remain here until a human verdict is recorded
              on-chain.
            </p>
          </div>
        ) : (
          <div className="cards">
            {queue.map((job) => (
              <article className="review-card" key={job.id}>
                <div className="review-card-top">
                  <div>
                    <p className="eyebrow">Job #{job.id}</p>
                    <h2>{job.description || "No description provided"}</h2>
                  </div>
                  <button type="button" className="button" disabled>
                    connect resolver wallet
                  </button>
                </div>
                <div className="review-meta">
                  <div>
                    <span className="data-label">Status / budget</span>
                    <div className="address-line">
                      <StatusChip status="Escalated" />
                      <span>{job.budgetUsdc} USDC</span>
                    </div>
                  </div>
                  <div>
                    <span className="data-label">Deliverable hash</span>
                    {job.deliverableHash ? (
                      <ShortHash value={job.deliverableHash} />
                    ) : (
                      <span className="muted">Not found in recent logs</span>
                    )}
                  </div>
                  <div>
                    <span className="data-label">Evidence / reason hash</span>
                    <ShortHash value={job.reasonHash} />
                    <div>
                      <TxLink hash={job.escalationTxHash}>
                        escalation tx ↗
                      </TxLink>
                    </div>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
