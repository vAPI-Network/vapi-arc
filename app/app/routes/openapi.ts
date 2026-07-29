import type { Route } from "./+types/openapi";

export async function loader(_: Route.LoaderArgs) {
  const raw =
    process.env.REVIEW_SERVICE_URL?.trim() ||
    process.env.REVIEW_SERVICE_INTERNAL_URL?.trim();
  if (!raw) {
    return Response.json(
      { error: "Review service is not configured." },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

  try {
    const endpoint = new URL("/openapi.json", raw);
    const response = await fetch(endpoint, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.text();
    return new Response(body, {
      status: response.status,
      headers: {
        "content-type":
          response.headers.get("content-type") ?? "application/json",
        "cache-control": response.ok
          ? "public, max-age=300"
          : "no-store",
      },
    });
  } catch {
    return Response.json(
      { error: "Review service OpenAPI is temporarily unavailable." },
      { status: 502, headers: { "cache-control": "no-store" } },
    );
  }
}
