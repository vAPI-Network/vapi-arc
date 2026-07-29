import { index, route, type RouteConfig } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("health", "routes/health.ts"),
  route("health/demo", "routes/demo-health.ts"),
  route("openapi.json", "routes/openapi.ts"),
  route("demo", "routes/demo.tsx"),
  route("api/demo-runs/:runId", "routes/api-demo-run.ts"),
  route("proof/:runId", "routes/proof.tsx"),
  route("review", "routes/review.tsx"),
  route("reviewer/:address", "routes/reviewer.tsx"),
  route("provider/:address", "routes/provider.tsx"),
  route("api/reputation/:address", "routes/api-reputation.ts"),
] satisfies RouteConfig;
