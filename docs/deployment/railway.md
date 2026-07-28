# Railway deployment

This remains one pnpm/RRV7 repository. Railway is configured to run three
process types from the same source and one `production` environment:

| Railway service | Process config | Purpose |
| --- | --- | --- |
| `vapi-web` | `pnpm -C app build` | React Router v7 SSR dashboard |
| `vapi-review` | `core/src/review-server.ts` | x402 API, Telegram, Circle payouts |
| `vapi-judge` | `core/src/index.ts` | guarded AI submission watcher |

The deployable Railway graph lives in [`.railway/railway.ts`](../../.railway/railway.ts).
It declares the three service-specific build/start policies, health checks,
single-replica topology, and the two persistent volumes. The Railway SDK is
pinned in the root package so configuration can be previewed and applied with:

```bash
railway config plan
railway config apply
```

Always inspect the plan before applying it. A configured environment should
report that it is already up to date. The files in `deploy/railway-*.json`
remain equivalent dashboard/manual fallbacks; do not combine their
`configFile` setting with the TypeScript Railway graph.

Deploy the same repository snapshot to each service:

```bash
railway up -s vapi-web -e production --detach
railway up -s vapi-review -e production --detach
railway up -s vapi-judge -e production --detach
```

## GitHub Actions delivery

[`ci.yml`](../../.github/workflows/ci.yml) runs on pull requests and every
push to `main`. It typechecks and tests the review/judge core, typechecks and
builds the dashboard, and format-checks/tests the Solidity contracts.

[`deploy.yml`](../../.github/workflows/deploy.yml) is triggered only after
that CI workflow succeeds for a trusted push to `main`. It deploys the exact
tested commit in this order:

1. `vapi-review`, including its public readiness check.
2. `vapi-judge`, whose Railway deployment succeeds only after a complete Arc
   polling pass makes its internal `/health` readiness probe return HTTP 200.
3. `vapi-web`, including its public health check.

The workflow captures the exact Railway deployment ID and waits for its
terminal state. A Railway `SKIPPED` deployment retains the existing service,
which must still pass the relevant health/running check. The judge has no
public domain; Railway probes its internal `/health` route before marking the
deployment successful, and Actions then confirms that exact deployment remains
active. Runtime logs are not copied into the public Actions log; failed
deployments link to Railway for restricted inspection.

GitHub uses a `production` environment restricted to the `main` branch. Its
non-secret variables are:

```text
RAILWAY_PROJECT_ID
RAILWAY_WEB_SERVICE_ID
RAILWAY_REVIEW_SERVICE_ID
RAILWAY_JUDGE_SERVICE_ID
WEB_URL
REVIEW_URL
```

One environment secret must be added manually:

```text
RAILWAY_TOKEN
```

Create a Railway project token scoped to this project's `production`
environment. Do not use an account/workspace API token. Add it without putting
the value in shell history:

```bash
gh secret set RAILWAY_TOKEN \
  --repo vAPI-Network/vapi-arc \
  --env production
```

The command prompts for the value on standard input. Circle, Telegram,
Anthropic, oracle, and wallet credentials stay only in Railway and are never
duplicated into GitHub.

Infrastructure remains a separately reviewed operation: code delivery never
runs `railway config apply`, deletes volumes, or attempts an automatic
cross-service rollback.

## Review service volume

Attach a persistent volume to `vapi-review`, mount it at `/data`, and set:

```text
REVIEW_DATABASE_PATH=/data/review-exchange.sqlite
```

The review service is intentionally a single replica while it uses SQLite.
WAL mode and database transactions provide local concurrency; horizontal
scaling requires moving the same storage interface to a shared Postgres
database. Supabase is therefore not needed for the hackathon deployment.

Attach a separate persistent volume to `vapi-judge`, also mounted at `/data`,
and set:

```text
VAPI_DATA_ROOT=/data
```

That keeps the watcher cursor, deliverables, and canonical AI evidence across
redeploys. The services use separate Railway volumes; the review database does
not need to be shared with the judge.

## Variables

Share the Arc contract/RPC variables across all three services. Give only
`vapi-judge` the oracle and Anthropic secrets. Give only `vapi-review` the
Circle, Gateway, Telegram, and webhook secrets. Share one strong
`REVIEW_INTERNAL_TOKEN` with the judge, review service, and dashboard. Set the
review service's public Railway domain so Telegram registration and public
status/evidence links are correct:

```text
REVIEW_PUBLIC_BASE_URL=https://<review-service-domain>
REVIEW_ALLOW_PARTIAL_CONFIG=false
REVIEW_MIN_TREASURY_USDC=450000
REVIEW_BOOTSTRAP_REVIEWERS_JSON=[{"telegramUserId":"<telegram-user-id>","telegramChatId":"<private-chat-id>","alias":"Security Auditor","payoutAddress":"0x...","skills":["security","contracts"],"active":true}]
```

Configure `vapi-judge` with the same internal bearer token and the review
service's Railway private URL (or its public URL when private networking is not
available):

```text
REVIEW_SERVICE_INTERNAL_URL=http://vapi-review.railway.internal:<review-port>
REVIEW_INTERNAL_TOKEN=<same value as vapi-review>
```

The judge stores and hash-verifies its canonical `AIEvidenceV1` through that
endpoint before broadcasting any AI settlement or escalation. A failed handoff
is retried and fails closed, so auto-settlement evidence is publicly
retrievable and a later paid review can always resolve an on-chain escalation
hash to its genuine evaluator cause even though the two services have separate
volumes.

Use 2–3 entries with distinct Telegram user/chat IDs and Arc payout addresses.
The JSON is validated before the server starts and upserted by Telegram user ID,
so it safely seeds an empty volume and remains idempotent across deploys. The
value is declarative: changing an entry updates that council member on the next
restart, including `active`. The reviewer CLI remains available for later
operator changes, but a fresh production volume should include this seed so
the `/health` council check can pass before Railway routes traffic.

The review service fails startup if any live rail is missing or if the Circle
treasury is below the configured Arc USDC floor. `/health` repeats the cached
treasury check and requires at least one active council member, so Railway will
not route paid traffic to an insolvent or auditor-less worker. Job-specific
client/provider conflicts are checked again before x402.

## Telegram bot and council activation

The complete human-review demo requires one Telegram bot. This is the only
credential that cannot be provisioned by Railway:

1. In Telegram, open `@BotFather`, run `/newbot`, and keep the returned bot
   token private.
2. Each auditor opens the new bot in a private chat and presses **Start**.
   Telegram bots cannot initiate a conversation with a user.
3. Before the webhook is registered, call the Telegram `getUpdates` API once
   to read each auditor's numeric `message.from.id` and `message.chat.id`.
   For a private chat those values are normally the same.
4. Add `TELEGRAM_BOT_TOKEN` and a
   `REVIEW_BOOTSTRAP_REVIEWERS_JSON` array to `vapi-review`. Each reviewer
   needs a unique Telegram user/chat ID and a distinct Arc payout address.
5. Set `REVIEW_ALLOW_PARTIAL_CONFIG=false` and redeploy `vapi-review`.

`TELEGRAM_WEBHOOK_SECRET` should be a separate random value containing only
letters, digits, `_`, or `-`. The service registers
`<REVIEW_PUBLIC_BASE_URL>/v1/telegram/webhook` automatically at startup; do not
manually call `setWebhook`.

The final readiness check is:

```bash
curl --fail https://<review-service-domain>/health
```

It returns HTTP 200 only after the router/resolver, Circle wallet and treasury,
x402 seller, Telegram bot, internal API, and at least one active auditor all
pass validation.

Operational numeric settings also fail fast: ports must be in `1..65535`, all
worker intervals/TTLs/SLAs/attempt counts must be positive, the full set of
claim windows must fit inside the review SLA, and the minimum job-expiry buffer
must cover the review SLA plus both asynchronous Circle transaction windows.

Configure `vapi-web` with:

```text
ROUTER_ADDRESS=0x44A51C365eB3eC703534ebb56394E7015930533D
REVIEW_SERVICE_URL=https://<review-service-domain>
REVIEW_INTERNAL_TOKEN=<same value as vapi-review>
```

Railway supplies `PORT` to all three processes. The review server also accepts
`REVIEW_PORT`, and the judge accepts `JUDGE_PORT`, for local development; in
both cases Railway's `PORT` takes precedence. The judge returns `503` until a
complete Arc poll succeeds and whenever its last successful poll is stale.
`JUDGE_HEALTH_MAX_STALENESS_MS` defaults to five minutes.
