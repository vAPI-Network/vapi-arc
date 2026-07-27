import { Link } from "react-router";

import type { Route } from "./+types/home";
import {
  NetworkPill,
  SetupBanner,
  ShortHash,
  StatusChip,
  TxLink,
} from "~/components/ui";
import { getFeedData } from "~/lib/chain.server";

export async function loader() {
  return getFeedData();
}

export default function Home({ loaderData }: Route.ComponentProps) {
  const { configured, rows } = loaderData;

  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">Verdict feed</p>
          <h1>Evaluation, with receipts.</h1>
          <p className="lede">
            Live ERC-8183 job outcomes, grounded in public on-chain evidence.
            AI settles narrow work; uncertainty routes to a human.
          </p>
        </div>
        <NetworkPill />
      </div>

      {!configured && <SetupBanner />}

      <section aria-labelledby="jobs-heading">
        <div className="section-bar">
          <h2 id="jobs-heading">Job board</h2>
          <p>Recent 50,000 blocks · refreshes every 15 seconds</p>
        </div>

        {rows.length === 0 ? (
          <div className="empty-state">
            <h2>No evaluated jobs yet</h2>
            <p>
              Submitted jobs assigned to the EvaluationRouter will appear here
              with their final verdict provenance.
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
