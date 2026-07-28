import { index, route, type RouteConfig } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("health", "routes/health.ts"),
  route("review", "routes/review.tsx"),
  route("reviewer/:address", "routes/reviewer.tsx"),
  route("provider/:address", "routes/provider.tsx"),
  route("api/reputation/:address", "routes/api-reputation.ts"),
] satisfies RouteConfig;
