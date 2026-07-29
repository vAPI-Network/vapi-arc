import { useState } from "react";
import { Form, Link, useNavigation } from "react-router";

import {
  DEMO_STATE_LABELS,
  formatDemoTime,
  formatUsdcAmount,
  type DemoReadiness,
  type DemoRun,
  type DemoRunEvent,
} from "~/lib/demo";
import { EXPLORER_BASE, ShortHash } from "./ui";

const TELEGRAM_BOT_URL = "https://t.me/vAPITrustCouncilBot";

const EVENT_LABELS: Record<string, string> = {
  demo_run_created: "Demo run created",
  escrow_preparation_started: "Escrow preparation started",
  escrow_job_created: "Freelance job created",
  human_lane_selected: "HumanOnly lane selected",
  escrow_budget_set: "Escrow budget set",
  escrow_allowance_ready: "USDC allowance ready",
  deliverable_committed: "Deliverable committed",
  judge_escalation_confirmed: "vAPI escalation confirmed",
  human_judgment_required: "Human judgment required",
  review_order_attached: "Human review order attached",
  demo_run_finalized: "Public proof finalized",
  demo_step_failed: "Run needs attention",
  demo_transient_check_failed: "Still checking a live rail",
  run_created: "Demo run created",
  job_created: "Freelance job created",
  lane_set: "HumanOnly lane selected",
  budget_set: "Escrow budget set",
  allowance_approved: "USDC allowance approved",
  escrow_funded: "Escrow funded",
  deliverable_submitted: "Deliverable committed",
  job_escalated: "vAPI requested human judgment",
  x402_challenge_received: "HTTP 402 challenge received",
  x402_authorization_signed: "Gateway authorization signed",
  x402_payment_accepted: "x402 payment accepted",
  review_order_created: "Human review order created",
  review_dispatched: "Telegram offer dispatched",
  review_claimed: "Auditor claimed review",
  verdict_submitted: "Reasoned verdict submitted",
  reviewer_paid: "Auditor payout confirmed",
  escrow_settled: "Escrow settled on Arc",
  evidence_verified: "Evidence hash verified",
  retry_scheduled: "Safe retry scheduled",
  run_failed: "Run needs attention",
  refund_started: "Escrow refund queued",
  escrow_refunded: "Escrow returned to client",
};

const REVIEW_PROGRESS = [
  "paid",
  "dispatched",
  "claimed",
  "verdict_submitted",
  "reviewer_paid",
  "settled",
] as const;

const REVIEW_STATE_RANK: Record<string, number> = {
  paid: 0,
  dispatched: 1,
  claimed: 2,
  verdict_submitted: 3,
  payout_failed: 3,
  reviewer_paid: 4,
  reviewer_paid_settlement_failed: 4,
  settled: 5,
};

type StageState = "complete" | "current" | "waiting" | "error";

function stageIndex(run: DemoRun): number {
  if (run.state === "finalized" || run.state === "archived_refunded") return 4;
  if (run.state === "archived_refund_pending") return 3;
  if (run.state === "review_active") return 2;
  if (
    run.state === "awaiting_purchase" ||
    run.state === "purchasing_review"
  ) {
    return 1;
  }
  if (run.state === "failed") {
    if (run.transactions.payout || run.transactions.resolution) return 3;
    if (run.transactions.payment || run.orderId) return 2;
    if (run.transactions.escalation) return 1;
  }
  return 0;
}

function stepState(
  complete: boolean,
  stage: number,
  currentStage: number,
  failed: boolean,
): StageState {
  if (complete) return "complete";
  if (stage === currentStage) return failed ? "error" : "current";
  return "waiting";
}

function reviewAtLeast(run: DemoRun, state: (typeof REVIEW_PROGRESS)[number]) {
  const current = run.reviewOrder?.state;
  if (!current) return false;
  return (
    (REVIEW_STATE_RANK[current] ?? -1) >=
    (REVIEW_STATE_RANK[state] ?? Number.POSITIVE_INFINITY)
  );
}

function hasEvent(run: DemoRun, ...types: string[]): boolean {
  const wanted = new Set(types);
  return run.events.some((event) => wanted.has(event.type));
}

function StageStep({
  label,
  detail,
  state,
  receipt,
}: {
  label: string;
  detail: string;
  state: StageState;
  receipt?: string | null;
}) {
  return (
    <li className={`demo-step demo-step-${state}`}>
      <span className="demo-step-marker" aria-hidden="true">
        {state === "complete" ? "✓" : state === "error" ? "!" : ""}
      </span>
      <span className="demo-step-copy">
        <strong>{label}</strong>
        <small>{detail}</small>
      </span>
      {state === "complete" &&
        receipt &&
        /^0x[0-9a-fA-F]{64}$/.test(receipt) && (
        <a
          href={`${EXPLORER_BASE}/tx/${receipt}`}
          target="_blank"
          rel="noreferrer"
          className="demo-step-receipt"
          aria-label={`Open ${label} transaction in Arcscan`}
        >
          receipt ↗
        </a>
      )}
    </li>
  );
}

export function DemoTimeline({ run }: { run: DemoRun }) {
  const currentStage = stageIndex(run);
  const failed = run.state === "failed";
  const transaction = run.transactions;
  const challengeReceived = hasEvent(run, "x402_challenge_received");
  const authorizationSigned = hasEvent(run, "x402_authorization_signed");
  const hasPayment = Boolean(
    transaction.payment ||
      run.orderId ||
      hasEvent(run, "x402_payment_accepted", "review_order_attached"),
  );
  const reviewer = run.reviewOrder?.reviewer;

  const stages = [
    {
      key: "escrow",
      number: "01",
      title: "Escrow",
      description: "A real $1 freelance job is committed on Arc.",
      steps: [
        {
          label: "Job created",
          detail: run.jobId ? `ERC-8183 job #${run.jobId}` : "Waiting for Arc",
          complete: hasEvent(run, "escrow_job_created"),
          receipt: transaction.createJob,
        },
        {
          label: "HumanOnly selected",
          detail: "Human lane set before submission",
          complete: hasEvent(run, "human_lane_selected"),
          receipt: transaction.setLane,
        },
        {
          label: "Escrow funded",
          detail: `${formatUsdcAmount(run.budget)} USDC locked`,
          complete: hasEvent(run, "escrow_funded"),
          receipt: transaction.fund,
        },
        {
          label: "Deliverable committed",
          detail: run.deliverableHash
            ? "Content hash recorded"
            : "Waiting for provider",
          complete: hasEvent(run, "deliverable_committed"),
          receipt: transaction.submit,
        },
      ],
    },
    {
      key: "purchase",
      number: "02",
      title: "Agent purchase",
      description: "The hiring agent buys independent judgment via x402.",
      steps: [
        {
          label: "Human judgment required",
          detail: "vAPI evaluator escalated the job",
          complete: hasEvent(
            run,
            "judge_escalation_confirmed",
            "human_judgment_required",
          ),
          receipt: transaction.escalation,
        },
        {
          label: "HTTP 402 received",
          detail: `${formatUsdcAmount(run.reviewPrice)} USDC price discovered`,
          complete: challengeReceived || hasPayment,
          receipt: null,
        },
        {
          label: "Gateway authorized",
          detail: "Agent signed a gasless payment",
          complete: authorizationSigned || hasPayment,
          receipt: null,
        },
        {
          label: "Payment accepted",
          detail: run.orderId ? `Order ${run.orderId.slice(0, 8)}…` : "Not paid",
          complete: hasPayment,
          receipt: transaction.payment,
        },
      ],
    },
    {
      key: "judgment",
      number: "03",
      title: "Human judgment",
      description: "An allowlisted auditor claims and reasons in Telegram.",
      steps: [
        {
          label: "Telegram dispatched",
          detail: "Review Council notified",
          complete: reviewAtLeast(run, "dispatched"),
          receipt: null,
        },
        {
          label: "Review claimed",
          detail: reviewer ? `${reviewer.alias} accepted` : "Awaiting auditor",
          complete: reviewAtLeast(run, "claimed"),
          receipt: null,
        },
        {
          label: "Verdict submitted",
          detail: run.reviewOrder?.decision
            ? `${run.reviewOrder.decision === "approve" ? "Approved" : "Rejected"} with a written reason`
            : "Independent decision pending",
          complete: reviewAtLeast(run, "verdict_submitted"),
          receipt: null,
        },
      ],
    },
    {
      key: "settlement",
      number: "04",
      title: "Settlement",
      description: "The auditor is paid, then the escrow follows the verdict.",
      steps: [
        {
          label: "Auditor paid",
          detail: `${formatUsdcAmount(run.reward)} USDC for valid review`,
          complete: Boolean(
            run.reviewOrder?.paidAt &&
              run.reviewOrder.payoutTransactionHash,
          ),
          receipt:
            run.reviewOrder?.paidAt
              ? transaction.payout ||
                run.reviewOrder.payoutTransactionHash
              : null,
        },
        {
          label: "Escrow settled",
          detail:
            run.reviewOrder?.decision === "reject"
              ? "Client refund recorded"
              : "Freelancer payment recorded",
          complete:
            run.onChainVerified ||
            hasEvent(run, "escrow_refund_confirmed"),
          receipt:
            run.onChainVerified
              ? transaction.resolution ||
                run.reviewOrder?.resolutionTransactionHash
              : hasEvent(run, "escrow_refund_confirmed")
                ? transaction.escrowRefund
                : null,
        },
        {
          label: "Evidence verified",
          detail:
            run.reviewOrder?.evidenceVerified === true &&
            run.onChainVerified
              ? "Canonical HumanEvidenceV1"
              : "Waiting for final proof",
          complete:
            run.reviewOrder?.evidenceVerified === true &&
            run.onChainVerified,
          receipt: null,
        },
      ],
    },
  ];

  return (
    <section className="demo-timeline-card" aria-labelledby="trust-path-title">
      <div className="demo-card-heading">
        <div>
          <p className="eyebrow">Live trust path</p>
          <h2 id="trust-path-title">Every step earns its checkmark</h2>
        </div>
        <span className={`demo-run-state demo-run-state-${run.state}`}>
          <span aria-hidden="true" />
          {DEMO_STATE_LABELS[run.state]}
        </span>
      </div>

      <div className="demo-stage-list">
        {stages.map((stage, index) => {
          const state: StageState =
            currentStage > index
              ? "complete"
              : currentStage === index
                ? failed
                  ? "error"
                  : "current"
                : "waiting";
          return (
            <article
              key={stage.key}
              className={`demo-stage demo-stage-${state}`}
            >
              <header className="demo-stage-header">
                <span className="demo-stage-number">{stage.number}</span>
                <div>
                  <h3>{stage.title}</h3>
                  <p>{stage.description}</p>
                </div>
              </header>
              <ol>
                {stage.steps.map((step) => (
                  <StageStep
                    key={step.label}
                    label={step.label}
                    detail={step.detail}
                    state={stepState(
                      step.complete,
                      index,
                      currentStage,
                      failed,
                    )}
                    receipt={step.receipt}
                  />
                ))}
              </ol>
            </article>
          );
        })}
      </div>
    </section>
  );
}

export function ReadinessPanel({
  readiness,
}: {
  readiness: DemoReadiness | null;
}) {
  if (!readiness) {
    return (
      <aside className="demo-readiness demo-readiness-error" role="status">
        <strong>Readiness unavailable</strong>
        <span>The demo service could not be checked. Try again shortly.</span>
      </aside>
    );
  }

  return (
    <details
      className={`demo-readiness ${readiness.ready ? "demo-readiness-ready" : "demo-readiness-error"}`}
    >
      <summary>
        <span className="readiness-summary">
          <span className="readiness-orb" aria-hidden="true" />
          <span>
            <strong>
              {readiness.ready
                ? "All systems ready"
                : "Demo needs attention"}
            </strong>
            <small>
              {readiness.checks.filter((check) => check.status === "ready").length}
              /{readiness.checks.length} live checks passing
            </small>
          </span>
        </span>
        <span className="readiness-expand">View checks</span>
      </summary>
      <div className="readiness-checks">
        {readiness.checks.map((check) => (
          <div className="readiness-check" key={check.key}>
            <span
              className={`readiness-check-dot readiness-${check.status}`}
              aria-hidden="true"
            />
            <span>
              <strong>{check.label}</strong>
              <small>{check.message}</small>
            </span>
          </div>
        ))}
        <div className="readiness-live-values" aria-label="Demo rail details">
          <div>
            <span className="data-label">Funded balances</span>
            <dl>
              <div>
                <dt>Escrow wallet</dt>
                <dd>
                  {readiness.balances.clientEscrow
                    ? `${formatUsdcAmount(readiness.balances.clientEscrow)} USDC`
                    : "Unavailable"}
                </dd>
              </div>
              <div>
                <dt>Gateway buyer</dt>
                <dd>
                  {readiness.balances.gatewayAvailable
                    ? `${formatUsdcAmount(readiness.balances.gatewayAvailable)} USDC`
                    : "Unavailable"}
                </dd>
              </div>
              <div>
                <dt>Circle treasury</dt>
                <dd>
                  {readiness.balances.circleTreasury
                    ? `${formatUsdcAmount(readiness.balances.circleTreasury)} USDC`
                    : "Unavailable"}
                </dd>
              </div>
            </dl>
          </div>
          <div>
            <span className="data-label">Isolated actors</span>
            <dl>
              {(
                [
                  ["Client", readiness.addresses.client],
                  ["Provider", readiness.addresses.provider],
                  ["Auditor", readiness.addresses.reviewer],
                  ["Circle resolver", readiness.addresses.resolver],
                ] as const
              ).map(([label, address]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{address ? <ShortHash value={address} /> : "Unavailable"}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      </div>
    </details>
  );
}

function SubmitButton({
  children,
  disabled,
  tone = "primary",
}: {
  children: React.ReactNode;
  disabled?: boolean;
  tone?: "primary" | "secondary" | "quiet";
}) {
  const navigation = useNavigation();
  return (
    <button
      type="submit"
      className={`demo-button demo-button-${tone}`}
      disabled={disabled || navigation.state !== "idle"}
    >
      {navigation.state !== "idle" ? (
        <>
          <span className="demo-spinner" aria-hidden="true" />
          Working on Arc…
        </>
      ) : (
        children
      )}
    </button>
  );
}

export function DemoActionPanel({
  run,
  readiness,
  createRequestId,
}: {
  run: DemoRun | null;
  readiness: DemoReadiness | null;
  createRequestId: string;
}) {
  if (!run) {
    return (
      <aside className="demo-action-card demo-action-card-start">
        <span className="demo-action-index">01 / 02</span>
        <div className="demo-action-symbol" aria-hidden="true">
          ◇
        </div>
        <p className="eyebrow">Start the proof</p>
        <h2>Create & fund a $1 escrow</h2>
        <p>
          A demo client hires a freelancer, locks real testnet USDC, and commits
          the fixed deliverable to Arc.
        </p>
        <Form method="post">
          <input type="hidden" name="intent" value="create" />
          <input type="hidden" name="requestId" value={createRequestId} />
          <SubmitButton disabled={!readiness?.ready}>
            Create & fund $1 escrow
            <span aria-hidden="true">→</span>
          </SubmitButton>
        </Form>
        {!readiness?.ready && (
          <small className="demo-action-note">
            Resolve the readiness checks before starting a paid run.
          </small>
        )}
        <div className="demo-money-flow">
          <span>Client</span>
          <span aria-hidden="true">→</span>
          <strong>1.00 USDC escrow</strong>
          <span aria-hidden="true">→</span>
          <span>Freelancer</span>
        </div>
      </aside>
    );
  }

  if (run.capabilities.canPurchase) {
    return (
      <aside className="demo-action-card demo-action-card-purchase">
        <span className="demo-action-index">02 / 02</span>
        <div className="demo-action-symbol demo-action-symbol-live" aria-hidden="true">
          402
        </div>
        <p className="eyebrow">Human judgment required</p>
        <h2>Agent purchases review</h2>
        <p>
          vAPI declined to auto-settle this HumanOnly job. The agent can now
          purchase an independent auditor through Circle Gateway.
        </p>
        <Form method="post">
          <input type="hidden" name="intent" value="purchase" />
          <input type="hidden" name="runId" value={run.id} />
          <SubmitButton>
            Pay {formatUsdcAmount(run.reviewPrice)} USDC via x402
            <span aria-hidden="true">→</span>
          </SubmitButton>
        </Form>
        <ul className="demo-payment-facts">
          <li>
            <span>Network</span>
            <strong>Arc Testnet</strong>
          </li>
          <li>
            <span>Agent gas</span>
            <strong>$0.00</strong>
          </li>
          <li>
            <span>Auditor earns</span>
            <strong>{formatUsdcAmount(run.reward)} USDC</strong>
          </li>
        </ul>
      </aside>
    );
  }

  if (run.capabilities.canRetry) {
    const settlementRecovery =
      run.reviewOrder?.state === "reviewer_paid_settlement_failed";
    const payoutRecovery = run.reviewOrder?.state === "payout_failed";
    const refundRecovery = run.reviewOrder?.state === "expired";
    return (
      <aside className="demo-action-card demo-action-card-error">
        <span className="demo-action-index">Safe recovery</span>
        <div className="demo-action-symbol" aria-hidden="true">
          !
        </div>
        <p className="eyebrow">
          {settlementRecovery
            ? "Auditor paid · settlement paused"
            : payoutRecovery
              ? "Verdict saved · payout paused"
              : refundRecovery
                ? "Review expired · x402 refund paused"
                : "Action required"}
        </p>
        <h2>
          {settlementRecovery
            ? "Retry escrow settlement only"
            : payoutRecovery
              ? "Retry auditor payout only"
              : refundRecovery
                ? "Retry payer refund only"
                : "The run paused safely"}
        </h2>
        <p>
          {settlementRecovery
            ? "The $0.20 auditor reward is already confirmed. This retry can only execute humanResolve; it cannot pay the auditor twice."
            : payoutRecovery
              ? "The human verdict is durable, but Circle has not confirmed the reward. Escrow settlement stays blocked until payout succeeds."
              : refundRecovery
                ? "No auditor completed the review. This retry rotates only the exhausted Circle refund request; it cannot charge the agent again."
              : run.lastError ||
                "A live dependency did not confirm. Persisted receipts prevent completed payments or writes from repeating."}
        </p>
        <div className="demo-action-row">
          <Form method="post">
            <input type="hidden" name="intent" value="retry" />
            <input type="hidden" name="runId" value={run.id} />
            <SubmitButton>Retry current step</SubmitButton>
          </Form>
          {run.capabilities.canArchive && (
            <Form method="post">
              <input type="hidden" name="intent" value="archive" />
              <input type="hidden" name="runId" value={run.id} />
              <SubmitButton tone="quiet">Archive & refund later</SubmitButton>
            </Form>
          )}
        </div>
      </aside>
    );
  }

  if (run.state === "review_active") {
    const refunding =
      run.reviewOrder?.state === "expired" ||
      run.reviewOrder?.state === "refunded";
    return (
      <aside className="demo-action-card demo-action-card-telegram">
        <span className="demo-action-index">Phone handoff</span>
        <div className="demo-phone" aria-hidden="true">
          <span className="demo-phone-speaker" />
          <span className="demo-phone-buzz">1</span>
          <strong>vAPI Trust Council</strong>
          <small>New paid review available</small>
          <span className="demo-phone-claim">Claim review</span>
        </div>
        <p className="eyebrow">
          {refunding ? "Review SLA expired" : "Check Telegram"}
        </p>
        <h2>
          {refunding
            ? "Returning the x402 payment"
            : "A human is now in the loop"}
        </h2>
        <p>
          {refunding
            ? "No valid verdict arrived within the review SLA. The payer refund is being reconciled without touching the escrow."
            : "Claim the review, choose approve or reject, then reply with a concise reason. The auditor is paid for either valid decision."}
        </p>
        {!refunding && (
          <div className="demo-telegram-entry">
            <a
              href={TELEGRAM_BOT_URL}
              target="_blank"
              rel="noreferrer"
              className="demo-button demo-button-primary"
            >
              Open Trust Council bot
              <span aria-hidden="true">↗</span>
            </a>
            <a
              href={TELEGRAM_BOT_URL}
              target="_blank"
              rel="noreferrer"
              className="demo-telegram-qr"
              aria-label="Open Trust Council bot from the QR code"
            >
              <img
                src="/telegram-trust-council-qr.svg"
                alt="QR code for the vAPI Trust Council Telegram bot"
                width="104"
                height="104"
              />
            </a>
          </div>
        )}
        <div className="demo-waiting">
          <span className="demo-pulse" aria-hidden="true" />
          <span>
            <strong>
              {run.reviewOrder?.reviewer
                ? `${run.reviewOrder.reviewer.alias} claimed the review`
                : "Waiting for an auditor to claim"}
            </strong>
            <small>The timeline updates automatically.</small>
            {!refunding && run.reviewOrder?.claimExpiresAt && (
              <small>
                Claim window:{" "}
                {formatDemoTime(run.reviewOrder.claimExpiresAt)} UTC · dispatch{" "}
                {Math.max(1, run.reviewOrder.dispatchCount)} of 2
              </small>
            )}
          </span>
        </div>
      </aside>
    );
  }

  if (run.state === "finalized") {
    return <FinalProofCard run={run} includeActions />;
  }

  return (
    <aside className="demo-action-card demo-action-card-working">
      <span className="demo-action-index">Live execution</span>
      <div className="demo-orbit" aria-hidden="true">
        <span />
      </div>
      <p className="eyebrow">Arc is confirming</p>
      <h2>{DEMO_STATE_LABELS[run.state]}</h2>
      <p>
        {run.currentOperation
          ? run.currentOperation.replaceAll("_", " ")
          : "The durable worker is reconciling the next real transaction."}
        . You can reload this page without interrupting the run.
      </p>
      <div className="demo-waiting">
        <span className="demo-pulse" aria-hidden="true" />
        <span>
          <strong>Still checking Arc</strong>
          <small>
            {run.lastError
              ? `Last check: ${run.lastError}`
              : "Automatic refresh every two seconds"}
          </small>
        </span>
      </div>
    </aside>
  );
}

export function ScenarioDetails({
  run,
  readiness,
}: {
  run: DemoRun | null;
  readiness: DemoReadiness | null;
}) {
  const budget = run?.budget ?? readiness?.amounts.escrowBudget ?? "1000000";
  const reviewPrice =
    run?.reviewPrice ?? readiness?.amounts.reviewPrice ?? "250000";
  const reward =
    run?.reward ?? readiness?.amounts.reviewerReward ?? "200000";

  return (
    <details className="demo-scenario">
      <summary>
        <span>
          <strong>API contract compliance review</strong>
          <small>Fixed HumanOnly scenario · human-review-v1</small>
        </span>
        <span>Job details</span>
      </summary>
      <div className="demo-scenario-grid">
        <div>
          <span className="data-label">Acceptance criteria</span>
          <p>
            {run?.acceptanceCriteria ||
              "API responses contain status and result; unauthenticated requests return HTTP 401."}
          </p>
        </div>
        <div>
          <span className="data-label">Deliverable</span>
          <p>
            {run?.deliverableContent ||
              "A contract summary describing the required response fields and authentication behavior."}
          </p>
        </div>
        <dl>
          <div>
            <dt>Escrow</dt>
            <dd>{formatUsdcAmount(budget)} USDC</dd>
          </div>
          <div>
            <dt>Review</dt>
            <dd>{formatUsdcAmount(reviewPrice)} USDC</dd>
          </div>
          <div>
            <dt>Auditor reward</dt>
            <dd>{formatUsdcAmount(reward)} USDC</dd>
          </div>
          <div>
            <dt>Lane</dt>
            <dd>HumanOnly</dd>
          </div>
        </dl>
      </div>
    </details>
  );
}

function eventSummary(event: DemoRunEvent): string | null {
  const priority = [
    "message",
    "operation",
    "decision",
    "reviewerAlias",
    "amount",
    "error",
  ];
  for (const key of priority) {
    const value = event.payload[key];
    if (typeof value === "string" || typeof value === "number") {
      return String(value);
    }
  }
  return null;
}

export function DemoEventLog({ run }: { run: DemoRun }) {
  const events = [...run.events].reverse();
  return (
    <details className="demo-event-panel">
      <summary>
        <span>
          <strong>Technical event log</strong>
          <small>{events.length} durable events</small>
        </span>
        <span>Inspect</span>
      </summary>
      {events.length === 0 ? (
        <p className="muted">The first durable event is still being recorded.</p>
      ) : (
        <ol>
          {events.map((event) => {
            const summary = eventSummary(event);
            return (
              <li key={event.id}>
                <span className="event-dot" aria-hidden="true" />
                <span>
                  <strong>
                    {EVENT_LABELS[event.type] ??
                      event.type.replaceAll("_", " ")}
                  </strong>
                  {summary && <small>{summary}</small>}
                </span>
                <time dateTime={event.createdAt}>
                  {formatDemoTime(event.createdAt)} UTC
                </time>
              </li>
            );
          })}
        </ol>
      )}
    </details>
  );
}

function Receipt({
  label,
  value,
}: {
  label: string;
  value: string | null;
}) {
  if (!value) return null;
  const isTransaction = /^0x[0-9a-fA-F]{64}$/.test(value);
  const shortValue =
    value.length > 17 ? `${value.slice(0, 9)}…${value.slice(-7)}` : value;
  return (
    <div className="demo-receipt">
      <span className="data-label">{label}</span>
      {isTransaction ? (
        <a
          href={`${EXPLORER_BASE}/tx/${value}`}
          target="_blank"
          rel="noreferrer"
        >
          <span className="mono">{shortValue}</span>
          <span aria-hidden="true">↗</span>
        </a>
      ) : (
        <ShortHash value={value} />
      )}
    </div>
  );
}

export function DemoReceipts({ run }: { run: DemoRun }) {
  const transaction = run.transactions;
  const receipts = [
    [
      "Job creation",
      hasEvent(run, "escrow_job_created") ? transaction.createJob : null,
    ],
    [
      "Lane selection",
      hasEvent(run, "human_lane_selected") ? transaction.setLane : null,
    ],
    [
      "Budget",
      hasEvent(run, "escrow_budget_set") ? transaction.setBudget : null,
    ],
    [
      "Allowance",
      hasEvent(run, "escrow_allowance_ready") ? transaction.approval : null,
    ],
    [
      "Escrow funding",
      hasEvent(run, "escrow_funded") ? transaction.fund : null,
    ],
    [
      "Submission",
      hasEvent(run, "deliverable_committed") ? transaction.submit : null,
    ],
    [
      "Escalation",
      hasEvent(run, "human_judgment_required")
        ? transaction.escalation
        : null,
    ],
    [
      "Gateway payment",
      hasEvent(run, "x402_payment_accepted", "review_order_attached")
        ? transaction.payment
        : null,
    ],
    [
      "Auditor payout",
      run.reviewOrder?.paidAt
        ? transaction.payout ||
          run.reviewOrder.payoutTransactionHash ||
          null
        : null,
    ],
    [
      "Router settlement",
      run.onChainVerified
        ? transaction.resolution ||
          run.reviewOrder?.resolutionTransactionHash ||
          null
        : null,
    ],
    [
      "x402 payer refund",
      run.reviewOrder?.state === "refunded"
        ? transaction.reviewRefund
        : null,
    ],
    [
      "Escrow refund",
      hasEvent(run, "escrow_refund_confirmed")
        ? transaction.escrowRefund
        : null,
    ],
  ] as const;
  const available = receipts.filter(([, value]) => value);
  if (available.length === 0) return null;

  return (
    <section className="demo-receipts" aria-labelledby="receipts-title">
      <div className="section-bar">
        <h2 id="receipts-title">Live receipts</h2>
        <p>Real references · Arc Testnet</p>
      </div>
      <div className="demo-receipt-grid">
        {available.map(([label, value]) => (
          <Receipt key={label} label={label} value={value} />
        ))}
      </div>
    </section>
  );
}

export function FinalProofCard({
  run,
  includeActions = false,
}: {
  run: DemoRun;
  includeActions?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const order = run.reviewOrder;
  const archived = run.state === "archived_refunded";
  const approved = order?.decision === "approve";
  const auditorPaid = Boolean(
    order?.paidAt && order.payoutTransactionHash,
  );

  async function copyProof() {
    try {
      const url = `${window.location.origin}/proof/${run.id}`;
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <aside className="demo-proof-card">
      <div
        className={`demo-proof-seal ${approved || archived ? "demo-proof-approved" : "demo-proof-rejected"}`}
        aria-hidden="true"
      >
        {approved || archived ? "✓" : "×"}
      </div>
      <p className="eyebrow">Public proof complete</p>
      <h2>
        {archived
          ? "Escrow returned safely"
          : approved
            ? "Freelancer paid"
            : "Client refunded"}
      </h2>
      <p className="demo-proof-reason">
        “
        {archived
          ? order
            ? "The paid review could not complete; its x402 payment and original escrow were recovered safely."
            : "The run was archived before human review and any funded escrow was recovered safely."
          : order?.reasoning ||
            "The auditor’s reason is recorded in the evidence."}
        ”
      </p>
      <div className="demo-proof-facts">
        <div>
          <span>Decision</span>
          <strong>{archived ? "Archived" : approved ? "Approve" : "Reject"}</strong>
        </div>
        <div>
          <span>Auditor</span>
          <strong>{order?.reviewer?.alias || "Trust Council"}</strong>
        </div>
        <div>
          <span>Auditor payout</span>
          <strong>
            {auditorPaid ? `${formatUsdcAmount(run.reward)} USDC` : "No payout"}
          </strong>
        </div>
        <div>
          <span>Escrow outcome</span>
          <strong>
            {hasEvent(run, "escrow_funded")
              ? `${formatUsdcAmount(run.budget)} USDC · ${
                  archived
                    ? "client · recovered"
                    : approved
                      ? "freelancer"
                      : "client"
                }`
              : "Not funded"}
          </strong>
        </div>
        <div>
          <span>x402 payment</span>
          <strong>
            {order
              ? `${formatUsdcAmount(order.reviewPrice)} USDC${
                  run.transactions.reviewRefund ? " · refunded" : ""
                }`
              : "Not purchased"}
          </strong>
        </div>
        <div>
          <span>x402 payer</span>
          <strong>
            {order?.payer ? <ShortHash value={order.payer} /> : "—"}
          </strong>
        </div>
        <div>
          <span>Network</span>
          <strong>
            {order?.network === "eip155:5042002"
              ? "Arc Testnet"
              : order?.network || "Arc Testnet"}
          </strong>
        </div>
        <div>
          <span>Gateway reference</span>
          <strong>
            {order?.gatewayTransaction ? (
              <ShortHash value={order.gatewayTransaction} />
            ) : (
              "—"
            )}
          </strong>
        </div>
        <div>
          <span>Auditor address</span>
          <strong>
            {order?.reviewer?.address ? (
              <ShortHash value={order.reviewer.address} />
            ) : (
              "—"
            )}
          </strong>
        </div>
        <div>
          <span>Review order</span>
          <strong>
            {order?.orderId ? <ShortHash value={order.orderId} /> : "—"}
          </strong>
        </div>
      </div>
      {order?.evidenceHash && (
        <div className="demo-evidence-proof">
          <span>
            <span
              className={
                order.evidenceVerified && run.onChainVerified
                  ? "evidence-status evidence-valid"
                  : "evidence-status evidence-pending"
              }
            >
              {order.evidenceVerified && run.onChainVerified
                ? "HumanEvidenceV1 verified on Arc"
                : "Evidence recorded"}
            </span>
            <ShortHash value={order.evidenceHash} />
          </span>
          {order.evidenceUrl && (
            <a
              href={order.evidenceUrl}
              target="_blank"
              rel="noreferrer"
              className="subtle-link"
            >
              Open evidence ↗
            </a>
          )}
        </div>
      )}
      <div className="demo-action-row">
        <button
          type="button"
          onClick={copyProof}
          className="demo-button demo-button-primary"
        >
          {copied ? "Proof link copied" : "Copy public proof link"}
        </button>
        {includeActions && (
          <Link to="/demo" className="demo-button demo-button-secondary">
            Start another run
          </Link>
        )}
      </div>
      {order?.reviewer?.address && (
        <div className="demo-proof-links">
          <Link
            className="subtle-link demo-reviewer-history"
            to={`/reviewer/${order.reviewer.address}`}
          >
            View {order.reviewer.alias}’s factual review history →
          </Link>
          <Link className="subtle-link" to="/review">
            Open full review operations →
          </Link>
        </div>
      )}
    </aside>
  );
}

export function LockedDemoPreview({ run }: { run: DemoRun | null }) {
  const previewOutcome = run
    ? run.state === "archived_refunded"
      ? "recovered"
      : run.reviewOrder?.decision === "approve"
        ? "approved"
        : run.reviewOrder?.decision === "reject"
          ? "rejected"
          : "completed"
    : null;
  return (
    <section className="demo-locked-preview" aria-labelledby="latest-proof">
      <div>
        <p className="eyebrow">Public evidence</p>
        <h2 id="latest-proof">Latest completed trust run</h2>
        <p>
          The controls are private. The outcome, auditor payout, and Arc
          receipts remain public.
        </p>
      </div>
      {run ? (
        <div className="demo-preview-result">
          <span
            className={`demo-preview-icon ${previewOutcome === "rejected" ? "demo-preview-rejected" : "demo-preview-approved"}`}
            aria-hidden="true"
          >
            {previewOutcome === "rejected" ? "×" : "✓"}
          </span>
          <span>
            <strong>
              Job #{run.jobId || "—"} ·{" "}
              {previewOutcome}
            </strong>
            <small>{formatDemoTime(run.completedAt || run.updatedAt)} UTC</small>
          </span>
          <Link to={`/proof/${run.id}`} className="demo-button demo-button-secondary">
            View proof
          </Link>
        </div>
      ) : (
        <p className="muted">No completed UI demo has been published yet.</p>
      )}
    </section>
  );
}

export function PresenterControls() {
  const [fullscreen, setFullscreen] = useState(false);

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
        setFullscreen(false);
      } else {
        await document.documentElement.requestFullscreen();
        setFullscreen(true);
      }
    } catch {
      setFullscreen(Boolean(document.fullscreenElement));
    }
  }

  return (
    <div className="presenter-controls">
      <Link to="/demo" className="presenter-control">
        Exit presenter mode
      </Link>
      <button
        type="button"
        className="presenter-control"
        onClick={toggleFullscreen}
      >
        {fullscreen ? "Exit fullscreen" : "Enter fullscreen"}
      </button>
    </div>
  );
}
