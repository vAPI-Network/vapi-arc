import { Link } from "react-router";

import type { Route } from "./+types/review";
import {
  NetworkPill,
  SetupBanner,
  ShortHash,
  StatusChip,
  TxLink,
} from "~/components/ui";
import { getReviewData, type ReviewRecord } from "~/lib/chain.server";
import {
  formatReviewTime,
  formatUsdcBaseUnits,
  isTerminalReviewState,
  REVIEW_STATE_LABELS,
  type ReviewOrder,
  type ReviewOrderEvent,
} from "~/lib/review-service";
import { getInternalReviewOrders } from "~/lib/review-service.server";

export async function loader() {
  const [chainResult, reviewService] = await Promise.all([
    getReviewData()
      .then((data) => ({ data, error: null }))
      .catch(() => ({
        data: { configured: true, queue: [] as ReviewRecord[] },
        error: "Arc Testnet RPC is temporarily unavailable.",
      })),
    getInternalReviewOrders(),
  ]);
  return {
    ...chainResult.data,
    chainError: chainResult.error,
    reviewService,
  };
}

const PIPELINE_STEPS = [
  { state: "paid", label: "Payment accepted" },
  { state: "dispatched", label: "Telegram dispatch" },
  { state: "claimed", label: "Auditor claimed" },
  { state: "verdict_submitted", label: "Verdict submitted" },
  { state: "reviewer_paid", label: "Auditor paid" },
  { state: "settled", label: "Escrow settled" },
] as const;

const STEP_EVENTS: Record<(typeof PIPELINE_STEPS)[number]["state"], string> = {
  paid: "payment_accepted",
  dispatched: "review_dispatched",
  claimed: "review_claimed",
  verdict_submitted: "verdict_submitted",
  reviewer_paid: "reviewer_paid",
  settled: "escrow_settled",
};

function timestampForStep(
  order: ReviewOrder,
  step: (typeof PIPELINE_STEPS)[number]["state"],
): string | null {
  const recorded = order.events.find(
    (event) => event.type === STEP_EVENTS[step],
  );
  if (recorded) return recorded.createdAt;
  // Retain timestamps for historical orders created before the event feed.
  if (step === "paid") return order.createdAt;
  if (step === "claimed") return order.claimedAt;
  if (step === "verdict_submitted") return order.verdictAt;
  if (step === "reviewer_paid") return order.paidAt;
  if (step === "settled") {
    return order.state === "settled" ? order.settledAt : null;
  }
  return null;
}

const EVENT_LABELS: Record<string, string> = {
  payment_accepted: "x402 payment accepted",
  review_dispatched: "Telegram offer dispatched",
  telegram_dispatch_failed: "Telegram dispatch failed",
  review_claimed: "Auditor claimed review",
  verdict_submitted: "Reasoned verdict submitted",
  reviewer_paid: "Auditor payout confirmed",
  payout_failed: "Auditor payout needs retry",
  escrow_settled: "Escrow settled on Arc",
  settlement_failed: "Escrow settlement needs retry",
  review_expired: "Review SLA expired",
  review_redispatched: "Review automatically redispatched",
  review_refunded: "x402 payer refunded",
  circle_webhook_received: "Circle transaction update received",
  circle_request_started: "Circle request durably journaled",
  circle_retry_scheduled: "Circle transaction retry scheduled",
  circle_attempts_exhausted: "Circle retries exhausted",
  circle_operator_resume: "Operator resumed Circle processing",
  review_worker_wake_failed: "Background wake failed",
  fulfillment_permanently_failed:
    "Escrow fulfillment became permanently unavailable",
};

function eventSummary(event: ReviewOrderEvent): string | null {
  const fields = [
    ["decision", event.payload.decision],
    ["reason", event.payload.reason],
    ["operation", event.payload.operation],
    ["state", event.payload.terminalState],
    ["code", event.payload.code],
    ["auditor", event.payload.reviewerAlias],
    ["amount", event.payload.amount],
    ["error", event.payload.error],
  ] as const;
  const parts = fields
    .flatMap(([label, value]) =>
      typeof value === "string" || typeof value === "number"
        ? [`${label}: ${String(value)}`]
        : [],
    )
    .slice(0, 2);
  return parts.length > 0 ? parts.join(" · ") : null;
}

function externalUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function TransactionReference({
  hash,
  children,
}: {
  hash: string | null;
  children: React.ReactNode;
}) {
  if (!hash) return <span className="muted">Pending</span>;
  if (/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    return <TxLink hash={hash}>{children}</TxLink>;
  }
  return <ShortHash value={hash} />;
}

function ReviewTimeline({ order }: { order: ReviewOrder }) {
  return (
    <ol className="review-timeline" aria-label="Review order timeline">
      {PIPELINE_STEPS.map((step) => {
        const timestamp = timestampForStep(order, step.state);
        const complete = timestamp !== null;
        const current =
          order.state === step.state ||
          (step.state === "reviewer_paid" &&
            order.state === "reviewer_paid_settlement_failed") ||
          (step.state === "verdict_submitted" &&
            order.state === "payout_failed");

        return (
          <li
            className={[
              "timeline-step",
              complete ? "timeline-complete" : "",
              current ? "timeline-current" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            key={step.state}
          >
            <span className="timeline-marker" aria-hidden="true" />
            <span className="timeline-copy">
              <strong>{step.label}</strong>
              {timestamp && <small>{formatReviewTime(timestamp)} UTC</small>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function ReviewEventLog({ events }: { events: ReviewOrderEvent[] }) {
  if (events.length === 0) {
    return (
      <p className="muted review-event-empty">
        No durable service events were recorded for this historical order.
      </p>
    );
  }
  return (
    <ol className="review-event-log" aria-label="Durable review activity">
      {events.map((event) => {
        const summary = eventSummary(event);
        return (
          <li key={event.id}>
            <span className="event-dot" aria-hidden="true" />
            <span>
              <strong>
                {EVENT_LABELS[event.type] ?? event.type.replaceAll("_", " ")}
              </strong>
              {summary && <small>{summary}</small>}
            </span>
            <time dateTime={event.createdAt}>
              {formatReviewTime(event.createdAt)} UTC
            </time>
          </li>
        );
      })}
    </ol>
  );
}

function ReviewOrderCard({
  order,
  job,
}: {
  order: ReviewOrder;
  job: ReviewRecord | undefined;
}) {
  const evidenceUrl = externalUrl(order.evidenceUrl);
  const exceptional =
    order.state === "expired" ||
    order.state === "refunded" ||
    order.state === "payout_failed" ||
    order.state === "reviewer_paid_settlement_failed";

  return (
    <article className="review-card">
      <div className="review-card-top">
        <div>
          <p className="eyebrow">Job #{order.jobId}</p>
          <h2>
            {job?.description ||
              order.jobDescription ||
              `Review order ${order.orderId}`}
          </h2>
          <p className="order-caption">
            Paid by <ShortHash value={order.payer} /> ·{" "}
            {formatUsdcBaseUnits(order.reviewPrice)} USDC
          </p>
        </div>
        <StatusChip status={REVIEW_STATE_LABELS[order.state]} />
      </div>

      <ReviewTimeline order={order} />

      {exceptional && (
        <div className="order-exception" role="status">
          <strong>{REVIEW_STATE_LABELS[order.state]}</strong>
          <span>Last updated {formatReviewTime(order.updatedAt)} UTC</span>
        </div>
      )}

      {order.lastError && (
        <div className="notice notice-error order-error" role="status">
          <strong>Action required:</strong> {order.lastError}
        </div>
      )}

      {(order.settlementAbortCode || order.settlementAbortedAt) && (
        <div className="notice order-error" role="status">
          <strong>Router settlement skipped:</strong>{" "}
          {order.settlementAbortCode && `${order.settlementAbortCode}. `}
          {order.settlementAbortedAt &&
            `Recorded ${formatReviewTime(order.settlementAbortedAt)} UTC. `}
          Any completed auditor payout or x402 payer refund remains visible in
          the receipts and durable activity below.
        </div>
      )}

      <div className="review-detail-grid">
        <div>
          <span className="data-label">Auditor</span>
          {order.reviewer ? (
            <>
              <Link
                to={`/reviewer/${order.reviewer.address}`}
                className="reviewer-link"
              >
                {order.reviewer.alias}
              </Link>
              <div>
                <ShortHash value={order.reviewer.address} />
              </div>
              <small className="muted">
                {formatUsdcBaseUnits(order.reward)} USDC reward
              </small>
            </>
          ) : (
            <span className="muted">Awaiting claim</span>
          )}
        </div>
        <div>
          <span className="data-label">Verdict</span>
          {order.decision ? (
            <>
              <strong className="decision">
                {order.decision === "approve"
                  ? "Approve freelancer"
                  : "Reject freelancer (refund on settlement)"}
              </strong>
              {order.reasoning && (
                <p className="review-reason">{order.reasoning}</p>
              )}
            </>
          ) : (
            <span className="muted">Pending</span>
          )}
        </div>
        <div>
          <span className="data-label">Payment receipt</span>
          <TransactionReference hash={order.gatewayTransaction}>
            Gateway payment ↗
          </TransactionReference>
          <small className="meta-line muted">{order.network}</small>
        </div>
        <div>
          <span className="data-label">On-chain receipts</span>
          <div className="tx-links tx-links-wrapped">
            {order.payoutTransactionHash && (
              <TransactionReference hash={order.payoutTransactionHash}>
                payout ↗
              </TransactionReference>
            )}
            {order.resolutionTransactionHash && (
              <TransactionReference hash={order.resolutionTransactionHash}>
                verdict ↗
              </TransactionReference>
            )}
            {order.refundTransactionHash && (
              <TransactionReference hash={order.refundTransactionHash}>
                refund ↗
              </TransactionReference>
            )}
            {!order.payoutTransactionHash &&
              !order.resolutionTransactionHash &&
              !order.refundTransactionHash && (
                <span className="muted">Pending</span>
              )}
          </div>
        </div>
        <div>
          <span className="data-label">Evidence</span>
          {order.evidenceHash ? (
            <>
              <ShortHash value={order.evidenceHash} />
              <div>
                <span
                  className={
                    order.evidenceVerified === true
                      ? "evidence-status evidence-valid"
                      : order.evidenceVerified === false
                        ? "evidence-status evidence-invalid"
                        : "evidence-status evidence-pending"
                  }
                >
                  {order.evidenceVerified === true
                    ? "Canonical hash verified"
                    : order.evidenceVerified === false
                      ? "Evidence hash mismatch"
                      : "Verification unavailable"}
                </span>
              </div>
              {evidenceUrl && (
                <div>
                  <a
                    className="subtle-link"
                    href={evidenceUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    verify canonical record ↗
                  </a>
                </div>
              )}
            </>
          ) : (
            <span className="muted">Generated after payout</span>
          )}
        </div>
        <div>
          <span className="data-label">Escalation</span>
          {order.escalationCause && (
            <strong className="escalation-cause">
              {order.escalationCause}
            </strong>
          )}
          <ShortHash value={order.escalationReasonHash} />
          {order.escalationReasonCode && (
            <small className="meta-line muted">
              {order.escalationReasonCode}
            </small>
          )}
          {job && (
            <div>
              <TxLink hash={job.escalationTxHash}>escalation tx ↗</TxLink>
            </div>
          )}
        </div>
      </div>

      <details className="review-activity">
        <summary>Durable activity ({order.events.length})</summary>
        <ReviewEventLog events={order.events} />
      </details>
    </article>
  );
}

function UnsponsoredJob({
  job,
  sponsorshipKnown,
}: {
  job: ReviewRecord;
  sponsorshipKnown: boolean;
}) {
  return (
    <article className="review-card review-card-unsponsored">
      <div className="review-card-top">
        <div>
          <p className="eyebrow">Job #{job.id}</p>
          <h2>{job.description || "No description provided"}</h2>
        </div>
        <StatusChip
          status={
            sponsorshipKnown ? "Awaiting sponsorship" : "Sponsorship unknown"
          }
        />
      </div>
      <div className="review-meta">
        <div>
          <span className="data-label">Escrow / budget</span>
          <div className="address-line">
            <StatusChip status="Escalated" />
            <span>{job.budgetUsdc} USDC</span>
          </div>
          <small className="muted">
            {job.clientRequested
              ? "Human review lane selected by client"
              : "Escalated by the guarded evaluator"}
          </small>
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
          <span className="data-label">Reason / receipt</span>
          <ShortHash value={job.reasonHash} />
          <div>
            <TxLink hash={job.escalationTxHash}>escalation tx ↗</TxLink>
          </div>
        </div>
      </div>
    </article>
  );
}

export default function Review({ loaderData }: Route.ComponentProps) {
  const { configured, queue, chainError, reviewService } = loaderData;
  const orders = reviewService.ok ? reviewService.data : [];
  const queueByJob = new Map(queue.map((job) => [job.id, job]));
  const orderedJobIds = new Set(orders.map((order) => order.jobId));
  const unsponsored = queue.filter((job) => !orderedJobIds.has(job.id));
  const activeOrders = orders.filter(
    (order) => !isTerminalReviewState(order.state),
  ).length;
  const settledOrders = orders.filter(
    (order) => order.state === "settled",
  ).length;
  const claimedOrders = orders.filter(
    (order) => order.reviewer !== null,
  ).length;
  const rewardBaseUnits = orders.reduce(
    (sum, order) =>
      order.paidAt && /^\d+$/.test(order.reward)
        ? sum + BigInt(order.reward)
        : sum,
    0n,
  );

  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">Paid human review exchange</p>
          <h1>Review operations</h1>
          <p className="lede">
            Agents sponsor escalated work through x402. An allowlisted auditor
            reviews it in Telegram and receives USDC. When the Arc escrow
            remains resolvable, the router anchors the verdict before funds
            move; permanent terminal races preserve any completed payout and
            refund receipts without submitting a router verdict.
          </p>
        </div>
        <NetworkPill />
      </div>

      {!configured && <SetupBanner />}

      {chainError && (
        <aside className="service-banner" role="status">
          <span className="service-indicator" aria-hidden="true" />
          <div>
            <strong>On-chain queue temporarily unavailable</strong>
            <p>
              {chainError} Paid review operations from the service remain
              visible below.
            </p>
          </div>
        </aside>
      )}

      {!reviewService.ok && (
        <aside className="service-banner" role="status">
          <span className="service-indicator" aria-hidden="true" />
          <div>
            <strong>Review service unavailable</strong>
            <p>
              {reviewService.message} The public on-chain escalation queue
              remains available below.
            </p>
          </div>
        </aside>
      )}

      <section
        className="stats-grid review-stats"
        aria-label="Review statistics"
      >
        <div className="stat">
          <span className="stat-value">
            {reviewService.ok ? orders.length : "—"}
          </span>
          <span className="stat-label">Sponsored reviews</span>
        </div>
        <div className="stat">
          <span className="stat-value">
            {reviewService.ok ? activeOrders : "—"}
          </span>
          <span className="stat-label">Active orders</span>
        </div>
        <div className="stat">
          <span className="stat-value">
            {reviewService.ok ? claimedOrders : "—"}
          </span>
          <span className="stat-label">Auditor claims</span>
        </div>
        <div className="stat">
          <span className="stat-value">
            {reviewService.ok ? settledOrders : "—"}
          </span>
          <span className="stat-label">Settled escrows</span>
        </div>
        <div className="stat">
          <span className="stat-value">
            {reviewService.ok
              ? formatUsdcBaseUnits(rewardBaseUnits.toString())
              : "—"}
          </span>
          <span className="stat-label">USDC rewards paid</span>
        </div>
      </section>

      <section aria-labelledby="pipeline-heading">
        <div className="section-bar">
          <h2 id="pipeline-heading">Review pipeline</h2>
          <p>
            {reviewService.ok
              ? `${orders.length} paid order${orders.length === 1 ? "" : "s"}`
              : "Service status unavailable"}
          </p>
        </div>

        {orders.length === 0 ? (
          <div className="empty-state">
            <h2>
              {reviewService.ok
                ? "No sponsored review orders"
                : "Order feed unavailable"}
            </h2>
            <p>
              {reviewService.ok
                ? "Once an agent pays the x402 review endpoint, its auditor, evidence, payout, and escrow receipts will appear here."
                : "The operations feed could not be loaded. Public Arc escalations remain visible below without assuming whether they have been sponsored."}
            </p>
          </div>
        ) : (
          <div className="cards">
            {orders.map((order) => (
              <ReviewOrderCard
                key={order.orderId}
                order={order}
                job={queueByJob.get(order.jobId)}
              />
            ))}
          </div>
        )}
      </section>

      <section className="review-section" aria-labelledby="sponsorship-heading">
        <div className="section-bar">
          <h2 id="sponsorship-heading">
            {reviewService.ok
              ? "Awaiting sponsorship"
              : "On-chain escalation queue"}
          </h2>
          <p>
            {unsponsored.length} unresolved on-chain escalation
            {unsponsored.length === 1 ? "" : "s"}
          </p>
        </div>
        {unsponsored.length === 0 ? (
          <div className="empty-state empty-state-compact">
            <h2>No unpaid escalations</h2>
            <p>
              Every open escalation is either sponsored or there are currently
              no jobs awaiting human review.
            </p>
          </div>
        ) : (
          <div className="cards">
            {unsponsored.map((job) => (
              <UnsponsoredJob
                job={job}
                key={job.id}
                sponsorshipKnown={reviewService.ok}
              />
            ))}
          </div>
        )}
      </section>
    </>
  );
}
