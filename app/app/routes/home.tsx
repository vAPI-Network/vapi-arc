import { Link } from "react-router";

import type { Route } from "./+types/home";
import {
  NetworkPill,
  SetupBanner,
  ShortHash,
  StatusChip,
  TxLink,
} from "~/components/ui";
import { getDashboardChainSnapshot } from "~/lib/review-service.server";

export async function loader() {
  const result = await getDashboardChainSnapshot();
  if (!result.ok) {
    return {
      configured: true,
      rows: [],
      snapshot: null,
      serviceError: result.message,
    };
  }
  return {
    configured: result.data.configured,
    rows: result.data.feed,
    snapshot: result.data,
    serviceError: null,
  };
}

export default function Home({ loaderData }: Route.ComponentProps) {
  const { configured, rows, snapshot, serviceError } = loaderData;
  const snapshotProblem =
    serviceError ??
    (snapshot?.status === "stale" || snapshot?.status === "degraded"
      ? snapshot.lastError || "The last Arc refresh did not complete."
      : null);
  const indexWarming = snapshot?.status === "syncing";
  const snapshotHasData = Boolean(snapshot?.indexedAt);

  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Job evaluations</h1>
          <p className="lede">
            ERC-8183 job outcomes and transaction receipts from Arc Testnet.
            Jobs settle automatically or go to human review.
          </p>
        </div>
        <NetworkPill />
      </div>

      {!configured && <SetupBanner />}

      {(snapshotProblem || indexWarming) && (
        <aside className="service-banner" role="status">
          <span className="service-indicator" aria-hidden="true" />
          <div>
            <strong>
              {indexWarming
                ? "Indexing Arc transactions"
                : snapshotHasData
                  ? "Showing saved Arc data"
                  : "Arc index unavailable"}
            </strong>
            <p>
              {indexWarming
                ? "Jobs will appear when the first index completes."
                : `${snapshotProblem} The indexer will retry automatically.`}
            </p>
          </div>
        </aside>
      )}

      <section aria-labelledby="jobs-heading">
        <div className="section-bar">
          <h2 id="jobs-heading">Jobs</h2>
          <p>
            {snapshot?.latestBlock
              ? `Verified through Arc block ${snapshot.latestBlock}`
              : "No indexed block yet"}
          </p>
        </div>

        {rows.length === 0 ? (
          <div className="empty-state">
            <h2>
              {indexWarming
                ? "Indexing Arc transactions"
                : serviceError || !snapshotHasData
                  ? "Jobs temporarily unavailable"
                  : "No evaluated jobs yet"}
            </h2>
            <p>
              {indexWarming
                ? "Jobs will appear when the first index completes."
                : "Submitted jobs assigned to the EvaluationRouter will appear here after evaluation."}
            </p>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Job</th>
                  <th>Status</th>
                  <th>Budget</th>
                  <th>Provider</th>
                  <th>Decision source</th>
                  <th>Arcscan</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((job) => (
                  <tr key={job.id}>
                    <td className="job-id">#{job.id}</td>
                    <td>
                      <StatusChip status={job.status} />
                    </td>
                    <td>{job.budgetUsdc} USDC</td>
                    <td>
                      <div className="address-line">
                        <ShortHash value={job.provider} />
                        <Link
                          to={`/provider/${job.provider}`}
                          className="subtle-link"
                          aria-label={`View evaluation history for ${job.provider}`}
                        >
                          View history
                        </Link>
                      </div>
                    </td>
                    <td>
                      <div className="provenance">
                        <strong>
                          {job.provenance === "human"
                            ? "Human review"
                            : job.provenance ?? "Awaiting verdict"}
                        </strong>
                        {job.confidenceBP !== null && (
                          <small>
                            {(job.confidenceBP / 100).toFixed(2)}% confidence
                          </small>
                        )}
                        {job.lane === "human" && (
                          <small>Selected by client</small>
                        )}
                      </div>
                    </td>
                    <td>
                      <div className="tx-links">
                        {job.statusTxHash && (
                          <TxLink hash={job.statusTxHash}>Job ↗</TxLink>
                        )}
                        {job.verdictTxHash &&
                          job.verdictTxHash !== job.statusTxHash && (
                            <TxLink hash={job.verdictTxHash}>Verdict ↗</TxLink>
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
