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
      ? `Trust Proof · Job #${data.run.jobId || "—"} · vAPI`
      : "Trust Proof · vAPI",
  },
  {
    name: "description",
    content:
      "Public evidence for an agent-funded human review and ERC-8183 escrow settlement on Arc.",
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
    throw new Response("This proof is not published until the run is final.", {
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
          <p className="eyebrow">Public trust receipt</p>
          <h1>
            One decision.
            <br />
            <span>Every receipt.</span>
          </h1>
          <p className="lede">
            A sanitized, read-only record of agent payment, human judgment,
            auditor compensation, and escrow settlement on Arc Testnet.
          </p>
        </div>
        <div className="proof-network">
          <span className="network-dot" aria-hidden="true" />
          Verified on Arc Testnet
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
          Explore all human reviews
        </Link>
      </div>
    </div>
  );
}
