import { Form, useNavigation } from "react-router";
import type { Route } from "./+types/review";
import {
  NetworkPill,
  SetupBanner,
  ShortHash,
  StatusChip,
  TxLink,
} from "~/components/ui";
import {
  getReviewData,
  hasHumanResolver,
  submitHumanVerdict,
} from "~/lib/chain.server";

export async function loader() {
  const data = await getReviewData();
  return { ...data, resolverConfigured: hasHumanResolver() };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const jobId = String(form.get("jobId") ?? "");
  const decision = String(form.get("decision") ?? "");
  if (decision !== "approve" && decision !== "reject") {
    return { ok: false as const, error: "Unknown decision." };
  }
  try {
    const txHash = await submitHumanVerdict({
      jobId,
      approve: decision === "approve",
      note: `human verdict via review UI: ${decision} job ${jobId}`,
    });
    return { ok: true as const, jobId, decision, txHash };
  } catch (error) {
    return {
      ok: false as const,
      error: error instanceof Error ? error.message : "Resolution failed.",
    };
  }
}

export default function Review({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { configured, queue, resolverConfigured } = loaderData;
  const navigation = useNavigation();
  const resolving = navigation.state === "submitting";

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

      {actionData && actionData.ok && (
        <div className="notice notice-success" role="status">
          Job #{actionData.jobId}{" "}
          {actionData.decision === "approve" ? "approved" : "rejected"} on-chain.{" "}
          <TxLink hash={actionData.txHash}>resolution tx ↗</TxLink>
        </div>
      )}
      {actionData && !actionData.ok && (
        <div className="notice notice-error" role="alert">
          {actionData.error}
        </div>
      )}

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
                  {resolverConfigured ? (
                    <Form method="post" className="resolve-actions">
                      <input type="hidden" name="jobId" value={job.id} />
                      <button
                        type="submit"
                        name="decision"
                        value="approve"
                        className="button"
                        disabled={resolving}
                      >
                        {resolving ? "resolving…" : "approve & pay"}
                      </button>
                      <button
                        type="submit"
                        name="decision"
                        value="reject"
                        className="button button-danger"
                        disabled={resolving}
                      >
                        {resolving ? "resolving…" : "reject & refund"}
                      </button>
                    </Form>
                  ) : (
                    <button type="button" className="button" disabled>
                      resolver wallet not configured
                    </button>
                  )}
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
