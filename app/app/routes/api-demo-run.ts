import type { Route } from "./+types/api-demo-run";
import { isDemoPresenter } from "~/lib/demo-session.server";
import { getDemoRun } from "~/lib/demo-service.server";

const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i;

export async function loader({ request, params }: Route.LoaderArgs) {
  if (!(await isDemoPresenter(request))) {
    return Response.json(
      { error: "Presenter session expired." },
      {
        status: 401,
        headers: {
          "cache-control": "no-store",
          vary: "Cookie",
        },
      },
    );
  }

  if (!RUN_ID_PATTERN.test(params.runId)) {
    return Response.json(
      { error: "Invalid demo run id." },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }

  const result = await getDemoRun(params.runId);
  if (!result.ok) {
    return Response.json(
      { error: result.message },
      {
        status: result.kind === "not_found" ? 404 : 502,
        headers: { "cache-control": "no-store" },
      },
    );
  }

  return Response.json(
    { run: result.data },
    {
      headers: {
        "cache-control": "no-store, private",
        vary: "Cookie",
      },
    },
  );
}
