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
          <p className="eyebrow">Verdict feed</p>
          <h1>Evaluation with receipts</h1>
          <p className="lede">
            Live ERC-8183 job outcomes with public on-chain evidence.
            AI settles narrow work; uncertainty routes to a human.
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
                ? "Arc evidence index is warming up"
                : snapshotHasData
                  ? "Showing the last verified Arc snapshot"
                  : "Arc evidence index is unavailable"}
            </strong>
            <p>
              {indexWarming
                ? "The page is ready now; verified jobs will appear when the background indexer completes its first pass."
                : `${snapshotProblem} Navigation remains available while the background indexer retries.`}
            </p>
          </div>
        </aside>
      )}

      <section aria-labelledby="jobs-heading">
        <div className="section-bar">
          <h2 id="jobs-heading">Job board</h2>
          <p>
            {snapshot?.latestBlock
              ? `Verified through Arc block ${snapshot.latestBlock}`
              : "Durable Arc evidence snapshot"}
          </p>
        </div>

        {rows.length === 0 ? (
          <div className="empty-state">
            <h2>
              {indexWarming
                ? "Indexing Arc receipts"
                : serviceError || !snapshotHasData
                  ? "Feed temporarily unavailable"
                  : "No evaluated jobs yet"}
            </h2>
            <p>
              {indexWarming
                ? "This first pass runs in the review worker and never blocks page navigation."
                : "Submitted jobs assigned to the EvaluationRouter will appear here with their final verdict provenance."}
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
                  <th>Verdict provenance</th>
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
                          history
                        </Link>
                      </div>
                    </td>
                    <td>
                      <div className="provenance">
                        <strong>{job.provenance ?? "Awaiting verdict"}</strong>
                        {job.confidenceBP !== null && (
                          <small>
                            {(job.confidenceBP / 100).toFixed(2)}% confidence
                          </small>
                        )}
                        {job.lane === "human" && (
                          <small>human review lane (client-chosen)</small>
                        )}
                      </div>
                    </td>
                    <td>
                      <div className="tx-links">
                        {job.statusTxHash && (
                          <TxLink hash={job.statusTxHash}>job ↗</TxLink>
                        )}
                        {job.verdictTxHash &&
                          job.verdictTxHash !== job.statusTxHash && (
                            <TxLink hash={job.verdictTxHash}>verdict ↗</TxLink>
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
