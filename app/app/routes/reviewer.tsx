import { Link } from "react-router";

import type { Route } from "./+types/reviewer";
import {
  NetworkPill,
  ShortHash,
  StatusChip,
  TxLink,
} from "~/components/ui";
import {
  formatDuration,
  formatReviewTime,
  formatUsdcBaseUnits,
  REVIEW_STATE_LABELS,
} from "~/lib/review-service";
import { getReviewerProfile } from "~/lib/review-service.server";

export async function loader({ params }: Route.LoaderArgs) {
  return getReviewerProfile(params.address);
}

export default function Reviewer({ loaderData }: Route.ComponentProps) {
  if (!loaderData.ok) {
    return (
      <>
        <div className="page-heading">
          <div>
            <p className="eyebrow">Auditor history</p>
            <h1>Reviewer unavailable</h1>
            <p className="lede">{loaderData.message}</p>
          </div>
          <NetworkPill />
        </div>
        <div className="empty-state">
          <h2>No reviewer record to display</h2>
          <p>
            Reviewer profiles are served by the paid human review exchange and
            will return once that service is available.
          </p>
          <Link to="/review" className="button empty-state-action">
            Back to review operations
          </Link>
        </div>
      </>
    );
  }

  const reviewer = loaderData.data;

  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">Auditor history</p>
          <h1>{reviewer.alias}</h1>
          <div className="address-line">
            <ShortHash value={reviewer.address} start={12} end={8} />
            <span
              className={`reviewer-availability ${
                reviewer.active ? "reviewer-active" : ""
              }`}
            >
              {reviewer.active ? "Accepting reviews" : "Council member inactive"}
            </span>
          </div>
          {reviewer.skills.length > 0 && (
            <div className="skill-list" aria-label="Reviewer skills">
              {reviewer.skills.map((skill) => (
                <span className="skill-tag" key={skill}>
                  {skill}
                </span>
              ))}
            </div>
          )}
        </div>
        <NetworkPill />
      </div>

      <section className="stats-grid reviewer-stats" aria-label="Auditor statistics">
        <div className="stat">
          <span className="stat-value">{reviewer.completedReviews}</span>
          <span className="stat-label">Verdicts completed</span>
        </div>
        <div className="stat">
          <span className="stat-value">{reviewer.paidReviews}</span>
          <span className="stat-label">Auditor payouts</span>
        </div>
        <div className="stat">
          <span className="stat-value">{reviewer.onChainSettledReviews}</span>
          <span className="stat-label">On-chain settled</span>
        </div>
        <div className="stat">
          <span className="stat-value">{reviewer.approvals}</span>
          <span className="stat-label">Approvals</span>
        </div>
        <div className="stat">
          <span className="stat-value">{reviewer.rejections}</span>
          <span className="stat-label">Rejections</span>
        </div>
        <div className="stat">
          <span className="stat-value">
            {formatDuration(reviewer.averageResponseSeconds)}
          </span>
          <span className="stat-label">Average response</span>
        </div>
        <div className="stat">
          <span className="stat-value">
            {formatUsdcBaseUnits(reviewer.totalRewards)}
          </span>
          <span className="stat-label">USDC rewards paid</span>
        </div>
      </section>

      <section aria-labelledby="reviews-heading">
        <div className="section-bar">
          <h2 id="reviews-heading">Review history</h2>
          <p>
            Objective receipts only · no unverified accuracy score
          </p>
        </div>

        {reviewer.reviews.length === 0 ? (
          <div className="empty-state">
            <h2>No completed reviews</h2>
            <p>
              Paid reviews claimed by this auditor will appear here with their
              verdict and Arc receipts.
            </p>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Job</th>
                  <th>State</th>
                  <th>Verdict</th>
                  <th>Reward</th>
                  <th>Updated</th>
                  <th>Receipts</th>
                </tr>
              </thead>
              <tbody>
                {reviewer.reviews.map((order) => (
                  <tr key={order.orderId}>
                    <td className="job-id">#{order.jobId}</td>
                    <td>
                      <StatusChip status={REVIEW_STATE_LABELS[order.state]} />
                    </td>
                    <td>
                      {order.decision === "approve"
                        ? "Approve"
                        : order.decision === "reject"
                          ? "Reject"
                          : "Pending"}
                    </td>
                    <td>{formatUsdcBaseUnits(order.reward)} USDC</td>
                    <td>{formatReviewTime(order.updatedAt)} UTC</td>
                    <td>
                      <div className="tx-links">
                        {order.payoutTransactionHash && (
                          <TxLink hash={order.payoutTransactionHash}>
                            payout ↗
                          </TxLink>
                        )}
                        {order.resolutionTransactionHash && (
                          <TxLink hash={order.resolutionTransactionHash}>
                            verdict ↗
                          </TxLink>
                        )}
                        {!order.payoutTransactionHash &&
                          !order.resolutionTransactionHash && (
                            <span className="muted">Pending</span>
                          )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
