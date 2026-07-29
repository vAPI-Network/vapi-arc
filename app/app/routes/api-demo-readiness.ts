import type { Route } from "./+types/api-demo-readiness";
import { isDemoPresenter } from "~/lib/demo-session.server";
import { getDemoReadiness } from "~/lib/demo-service.server";

const PRIVATE_HEADERS = {
  "cache-control": "no-store, private",
  vary: "Cookie",
};

export async function loader({ request }: Route.LoaderArgs) {
  if (!(await isDemoPresenter(request))) {
    return Response.json(
      { error: "Presenter session expired." },
      { status: 401, headers: PRIVATE_HEADERS },
    );
  }

  const result = await getDemoReadiness();
  if (!result.ok) {
    return Response.json(
      { error: result.message },
      { status: result.kind === "not_configured" ? 503 : 502, headers: PRIVATE_HEADERS },
    );
  }

  return Response.json(
    { readiness: result.data },
    { headers: PRIVATE_HEADERS },
  );
}
