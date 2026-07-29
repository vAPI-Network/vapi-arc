import { demoSessionConfigured } from "~/lib/demo-session.server";
import { getDemoReadiness } from "~/lib/demo-service.server";

export async function loader() {
  const session = demoSessionConfigured();
  const readiness = await getDemoReadiness();
  const review = readiness.ok && readiness.data.ready;
  const ready = session && review;

  return Response.json(
    {
      status: ready ? "ok" : "degraded",
      service: "vapi-live-trust-demo",
      checks: {
        presenterSession: session,
        reviewOrchestrator: review,
      },
    },
    {
      status: ready ? 200 : 503,
      headers: { "cache-control": "no-store" },
    },
  );
}
