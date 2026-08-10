import { index, route, type RouteConfig } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("orders/:address", "routes/order.tsx"),
  route("arbiters", "routes/arbiters.tsx"),
  route("reputation", "routes/reputation.tsx"),
  route("health", "routes/health.ts"),
] satisfies RouteConfig;
