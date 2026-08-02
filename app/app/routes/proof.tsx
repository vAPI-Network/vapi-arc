import { Link } from "react-router";

import type { Route } from "./+types/proof";
import {
  DemoEventLog,
  DemoReceipts,
  DemoTimeline,
  FinalProofCard,
  ScenarioDetails,
} from "~/components/demo-ui";
import { isDemoRunTerminal, toPublicProofRun } from "~/lib/demo";
import { getDemoRun } from "~/lib/demo-service.server";

const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i;

export const meta: Route.MetaFunction = ({ data }) => [
  {
    title: data?.run
      ? `Run record · Job #${data.run.jobId || "—"} · vAPI`
      : "Run record · vAPI",
  },
  {
    name: "description",
    content:
      "Payment, verdict, auditor payout, and escrow transactions on Arc Testnet.",
  },
];

export async function loader({ params }: Route.LoaderArgs) {
  if (!RUN_ID_PATTERN.test(params.runId)) {
    throw new Response("Invalid run id", { status: 400 });
  }
  const result = await getDemoRun(params.runId);
  if (!result.ok) {
    throw new Response(result.message, {
      status: result.kind === "not_found" ? 404 : 502,
    });
  }
  if (!isDemoRunTerminal(result.data)) {
    throw new Response("This run is not published until it is final.", {
      status: 404,
    });
  }
  return { run: toPublicProofRun(result.data) };
}

export default function Proof({ loaderData }: Route.ComponentProps) {
  const { run } = loaderData;
  return (
    <div className="proof-page">
      <header className="proof-hero">
        <div>
          <h1>Human review run</h1>
          <p className="lede">
            A read-only record of the review payment, verdict, auditor payout,
            and escrow settlement on Arc Testnet.
          </p>
        </div>
        <div className="proof-network">
          <span className="network-dot" aria-hidden="true" />
          Arc Testnet record
        </div>
      </header>

      <div className="proof-summary-grid">
        <DemoTimeline run={run} />
        <FinalProofCard run={run} />
      </div>

      <ScenarioDetails run={run} readiness={null} />
      <DemoReceipts run={run} />
      <DemoEventLog run={run} />

      <div className="proof-footer-action">
        <Link to="/review" className="demo-button demo-button-secondary">
          View all reviews
        </Link>
      </div>
    </div>
  );
}
