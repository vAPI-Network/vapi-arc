import type { Route } from "./+types/provider";
import {
  NetworkPill,
  SetupBanner,
  ShortHash,
  StatusChip,
  TxLink,
} from "~/components/ui";
import { getReputationData, hasConfiguredRouter } from "~/lib/chain.server";

export async function loader({ params }: Route.LoaderArgs) {
  const reputation = await getReputationData(params.address);
  return {
    configured: hasConfiguredRouter(),
    reputation,
  };
}

export default function Provider({ loaderData }: Route.ComponentProps) {
  const { configured, reputation } = loaderData;
  const reliability =
    reputation.reliability === null
      ? "unrated"
      : `${(reputation.reliability * 100).toFixed(0)}%`;

  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">Provider history</p>
          <h1>Evaluation record</h1>
          <div className="address-line">
            <ShortHash value={reputation.address} start={12} end={8} />
            <a
              className="subtle-link"
              href={`/api/reputation/${reputation.address}`}
            >
              JSON API ↗
            </a>
          </div>
        </div>
        <NetworkPill />
      </div>

      {!configured && <SetupBanner />}

      <section className="stats-grid" aria-label="Provider statistics">
        <div className="stat">
          <span className="stat-value">{reputation.completed}</span>
          <span className="stat-label">Completed</span>
        </div>
        <div className="stat">
          <span className="stat-value">{reputation.rejected}</span>
          <span className="stat-label">Rejected</span>
        </div>
        <div className="stat">
          <span className="stat-value">{reputation.n}</span>
          <span className="stat-label">Total evaluations</span>
        </div>
        <div className="stat">
          <span className="stat-value">{reputation.volumeUsdc}</span>
          <span className="stat-label">USDC volume</span>
        </div>
        <div className="stat reliability">
          <span className="stat-value">{reliability}</span>
          <span className="stat-label">
            Experimental reliability · n={reputation.n}
          </span>
          <span className="reliability-note">
            Experimental — small sample
          </span>
        </div>
      </section>

      <section aria-labelledby="history-heading">
        <div className="section-bar">
          <h2 id="history-heading">Settled jobs</h2>
          <p>Completed and rejected by vAPI Trust</p>
        </div>
        {reputation.history.length === 0 ? (
          <div className="empty-state">
            <h2>No evaluation history</h2>
            <p>
              This provider has no recently settled jobs assigned to the
              configured EvaluationRouter.
            </p>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Job</th>
                  <th>Outcome</th>
                  <th>Budget</th>
                  <th>Provenance</th>
                  <th>Transaction</th>
                </tr>
              </thead>
              <tbody>
                {reputation.history.map((job) => (
                  <tr key={job.id}>
                    <td className="job-id">#{job.id}</td>
                    <td>
                      <StatusChip status={job.status} />
                    </td>
                    <td>{job.budgetUsdc} USDC</td>
                    <td>
                      {job.provenance ?? "On-chain"}
                      {job.confidenceBP !== null && (
                        <span className="muted">
                          {" "}
                          · {(job.confidenceBP / 100).toFixed(2)}%
                        </span>
                      )}
                    </td>
                    <td>
                      {job.statusTxHash && (
                        <TxLink hash={job.statusTxHash}>arcscan ↗</TxLink>
                      )}
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
