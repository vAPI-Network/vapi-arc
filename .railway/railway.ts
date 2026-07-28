import {
  defineRailway,
  preserve,
  project,
  service,
  volume,
} from "railway/iac";

export default defineRailway(() => {
  const reviewData = volume("vapi-review-data", {
    sizeMB: 50_000,
    region: "europe-west4-drams3a",
  });
  const judgeData = volume("vapi-judge-data", {
    sizeMB: 50_000,
    region: "europe-west4-drams3a",
  });

  const web = service("vapi-web", {
    env: {
      PORT: preserve(),
      ARC_RPC_URL: preserve(),
      ROUTER_ADDRESS: preserve(),
      REVIEW_SERVICE_URL: preserve(),
      REVIEW_INTERNAL_TOKEN: preserve(),
    },
    build: {
      builder: "RAILPACK",
      buildCommand: "pnpm install --frozen-lockfile && pnpm -C app build",
      watchPatterns: [
        "/app/**",
        "/adapters/**",
        "/package.json",
        "/pnpm-lock.yaml",
        "/pnpm-workspace.yaml",
        "/tsconfig.base.json",
      ],
    },
    deploy: {
      startCommand:
        "node app/node_modules/@react-router/serve/bin.js app/build/server/index.js",
      healthcheckPath: "/health",
      healthcheckTimeout: 60,
      drainingSeconds: 30,
      restartPolicyMaxRetries: 5,
    },
  });

  const review = service("vapi-review", {
    env: {
      PORT: preserve(),
      ARC_RPC_URL: preserve(),
      AGENTIC_COMMERCE: preserve(),
      ARC_USDC: preserve(),
      ROUTER_ADDRESS: preserve(),
      X402_SELLER_ADDRESS: preserve(),
      X402_NETWORK: preserve(),
      X402_FACILITATOR_URL: preserve(),
      REVIEW_PRICE_USDC: preserve(),
      REVIEWER_REWARD_USDC: preserve(),
      REVIEW_PUBLIC_BASE_URL: preserve(),
      REVIEW_DATABASE_PATH: preserve(),
      REVIEW_INTERNAL_TOKEN: preserve(),
      REVIEW_CLAIM_TTL_SECONDS: preserve(),
      REVIEW_SLA_SECONDS: preserve(),
      REVIEW_MIN_JOB_EXPIRY_SECONDS: preserve(),
      REVIEW_MAX_DISPATCHES: preserve(),
      REVIEW_BACKGROUND_INTERVAL_MS: preserve(),
      REVIEW_LOG_LOOKBACK_BLOCKS: preserve(),
      REVIEW_ALLOW_PARTIAL_CONFIG: preserve(),
      REVIEW_BOOTSTRAP_REVIEWERS_JSON: preserve(),
      TELEGRAM_BOT_TOKEN: preserve(),
      TELEGRAM_WEBHOOK_SECRET: preserve(),
      CIRCLE_API_KEY: preserve(),
      CIRCLE_ENTITY_SECRET: preserve(),
      CIRCLE_WALLET_ID: preserve(),
      CIRCLE_WALLET_ADDRESS: preserve(),
      REVIEW_MIN_TREASURY_USDC: preserve(),
      CIRCLE_TRANSACTION_TIMEOUT_MS: preserve(),
      CIRCLE_MAX_ATTEMPTS: preserve(),
    },
    build: {
      builder: "RAILPACK",
      buildCommand: "pnpm install --frozen-lockfile && pnpm -C core typecheck",
      watchPatterns: [
        "/core/**",
        "/adapters/**",
        "/package.json",
        "/pnpm-lock.yaml",
        "/pnpm-workspace.yaml",
        "/tsconfig.base.json",
      ],
    },
    deploy: {
      startCommand: "node --import tsx core/src/review-server.ts",
      healthcheckPath: "/health",
      healthcheckTimeout: 60,
      drainingSeconds: 30,
      restartPolicyType: "ALWAYS",
    },
    volumeMounts: {
      "/data": reviewData,
    },
  });

  const judge = service("vapi-judge", {
    env: {
      PORT: preserve(),
      JUDGE_PORT: preserve(),
      ARC_RPC_URL: preserve(),
      AGENTIC_COMMERCE: preserve(),
      ROUTER_ADDRESS: preserve(),
      ORACLE_PK: preserve(),
      ANTHROPIC_API_KEY: preserve(),
      JUDGE_MODEL: preserve(),
      AUTO_SETTLE_CAP: preserve(),
      MIN_CONFIDENCE_BP: preserve(),
      VAPI_DATA_ROOT: preserve(),
      REVIEW_SERVICE_INTERNAL_URL: preserve(),
      REVIEW_INTERNAL_TOKEN: preserve(),
      JUDGE_HEALTH_MAX_STALENESS_MS: preserve(),
    },
    build: {
      builder: "RAILPACK",
      buildCommand: "pnpm install --frozen-lockfile && pnpm -C core typecheck",
      watchPatterns: [
        "/core/**",
        "/adapters/**",
        "/package.json",
        "/pnpm-lock.yaml",
        "/pnpm-workspace.yaml",
        "/tsconfig.base.json",
      ],
    },
    deploy: {
      startCommand: "node --import tsx core/src/index.ts",
      healthcheckPath: "/health",
      healthcheckTimeout: 300,
      drainingSeconds: 30,
      restartPolicyType: "ALWAYS",
    },
    volumeMounts: {
      "/data": judgeData,
    },
  });

  return project("vAPI Arc Demo", {
    environments: ["production"],
    resources: [web, review, judge, reviewData, judgeData],
  });
});
