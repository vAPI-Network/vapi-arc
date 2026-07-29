import { randomUUID } from "node:crypto";

import {
  data,
  Form,
  Link,
  redirect,
  useActionData,
  useFetcher,
  useLocation,
} from "react-router";
import { useEffect, useRef } from "react";

import type { Route } from "./+types/demo";
import {
  DemoActionPanel,
  DemoEventLog,
  DemoReceipts,
  DemoTimeline,
  LockedDemoPreview,
  PresenterControls,
  ReadinessPanel,
  ScenarioDetails,
} from "~/components/demo-ui";
import {
  DEMO_STATE_LABELS,
  isDemoRunTerminal,
  toPublicProofRun,
  type DemoReadiness,
  type DemoRun,
} from "~/lib/demo";
import {
  createDemoPresenterCookie,
  demoSessionConfigured,
  demoUnlockRateLimit,
  destroyDemoPresenterCookie,
  isDemoPresenter,
  isSameOriginMutation,
  verifyDemoAccessCode,
} from "~/lib/demo-session.server";
import {
  archiveDemoRun,
  createDemoRun,
  getDemoReadiness,
  getDemoRun,
  getLatestDemoRun,
  purchaseDemoReview,
  retryDemoRun,
} from "~/lib/demo-service.server";

const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i;

type ActionResponse = {
  ok: false;
  error: string;
};

export const meta: Route.MetaFunction = () => [
  { title: "Live Trust Demo · vAPI Trust Network" },
  {
    name: "description",
    content:
      "Watch an agent escrow USDC, purchase human judgment, pay an auditor, and settle with public proof on Arc.",
  },
];

export async function loader({ request }: Route.LoaderArgs) {
  const authorized = await isDemoPresenter(request);
  const configured = demoSessionConfigured();
  const url = new URL(request.url);
  const requestedRunId = url.searchParams.get("run");

  const [latestResult, latestCompletedResult, requestedRunResult] =
    await Promise.all([
      authorized
        ? getLatestDemoRun()
        : Promise.resolve({ ok: true as const, data: null }),
      getLatestDemoRun(true),
      authorized && requestedRunId && RUN_ID_PATTERN.test(requestedRunId)
        ? getDemoRun(requestedRunId)
        : Promise.resolve(null),
    ]);

  const latest = latestResult.ok ? latestResult.data : null;
  const latestCompleted = latestCompletedResult.ok
    ? latestCompletedResult.data
    : null;
  const run =
    requestedRunResult && requestedRunResult.ok
      ? requestedRunResult.data
      : authorized && latest && !isDemoRunTerminal(latest)
        ? latest
        : null;
  const publicLatest = latestCompleted
    ? toPublicProofRun(latestCompleted)
    : null;

  const serviceError =
    (requestedRunResult && !requestedRunResult.ok
      ? requestedRunResult.message
      : null) ||
    (!latestResult.ok ? latestResult.message : null) ||
    (!latestCompletedResult.ok ? latestCompletedResult.message : null);

  return data(
    {
      authorized,
      configured,
      run,
      publicLatest,
      serviceError,
      createRequestId: randomUUID(),
    },
    {
      headers: {
        "cache-control": "no-store, private",
        vary: "Cookie",
      },
    },
  );
}

function demoRedirect(request: Request, runId?: string): string {
  const current = new URL(request.url);
  const search = new URLSearchParams();
  if (runId) search.set("run", runId);
  if (current.searchParams.get("present") === "1") search.set("present", "1");
  const query = search.toString();
  return query ? `/demo?${query}` : "/demo";
}

function actionError(message: string, status = 400) {
  return data<ActionResponse>(
    { ok: false, error: message },
    { status, headers: { "cache-control": "no-store" } },
  );
}

export async function action({ request }: Route.ActionArgs) {
  if (!isSameOriginMutation(request)) {
    return actionError("The demo rejected a cross-origin request.", 403);
  }

  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "unlock") {
    if (!demoSessionConfigured()) {
      return actionError(
        "Presenter access is not configured on this deployment.",
        503,
      );
    }
    const rateLimit = demoUnlockRateLimit(request);
    if (!rateLimit.allowed) {
      return data<ActionResponse>(
        {
          ok: false,
          error: `Too many attempts. Try again in ${Math.ceil(rateLimit.retryAfterSeconds / 60)} minutes.`,
        },
        {
          status: 429,
          headers: {
            "cache-control": "no-store",
            "retry-after": String(rateLimit.retryAfterSeconds),
          },
        },
      );
    }
    const passcode = formData.get("passcode");
    if (
      typeof passcode !== "string" ||
      passcode.length > 256 ||
      !verifyDemoAccessCode(request, passcode)
    ) {
      return actionError("That presenter passcode is not valid.", 401);
    }
    const cookie = await createDemoPresenterCookie(request);
    if (!cookie) {
      return actionError("Presenter sessions are not configured.", 503);
    }
    return redirect(demoRedirect(request), {
      headers: { "set-cookie": cookie },
    });
  }

  if (intent === "lock") {
    const cookie = await destroyDemoPresenterCookie(request);
    return redirect("/demo", {
      headers: cookie ? { "set-cookie": cookie } : undefined,
    });
  }

  if (!(await isDemoPresenter(request))) {
    return actionError("Your presenter session expired. Unlock the demo again.", 401);
  }

  if (intent === "create") {
    const requestId = formData.get("requestId");
    if (
      typeof requestId !== "string" ||
      !RUN_ID_PATTERN.test(requestId)
    ) {
      return actionError("A valid idempotency key is required.");
    }
    const readiness = await getDemoReadiness();
    if (!readiness.ok) return actionError(readiness.message, 502);
    if (!readiness.data.ready) {
      return actionError(
        "The live rails are not ready. Open the readiness checks for details.",
        409,
      );
    }
    const result = await createDemoRun(requestId);
    if (!result.ok) return actionError(result.message, 502);
    return redirect(demoRedirect(request, result.data.runId));
  }

  const runId = formData.get("runId");
  if (typeof runId !== "string" || !RUN_ID_PATTERN.test(runId)) {
    return actionError("A valid demo run is required.");
  }

  const result =
    intent === "purchase"
      ? await purchaseDemoReview(runId)
      : intent === "retry"
        ? await retryDemoRun(runId)
        : intent === "archive"
          ? await archiveDemoRun(runId)
          : null;
  if (!result) return actionError("That demo action is not supported.");
  if (!result.ok) return actionError(result.message, 502);
  return redirect(demoRedirect(request, runId));
}

function useLiveRun(initialRun: DemoRun | null): {
  run: DemoRun | null;
  pollError: string | null;
} {
  const poller = useFetcher<{ run?: DemoRun; error?: string }>();
  const loadRef = useRef(poller.load);
  useEffect(() => {
    loadRef.current = poller.load;
  }, [poller.load]);
  const polledRun =
    initialRun && poller.data?.run?.id === initialRun.id
      ? poller.data.run
      : null;
  const run = polledRun ?? initialRun;
  const shouldPoll =
    run !== null &&
    !isDemoRunTerminal(run) &&
    run.state !== "failed";
  const runId = initialRun?.id ?? null;

  useEffect(() => {
    if (!runId || !shouldPoll) return;
    const path = `/api/demo-runs/${encodeURIComponent(runId)}`;
    const refresh = () => {
      if (document.visibilityState === "visible") loadRef.current(path);
    };
    const interval = window.setInterval(refresh, 2_000);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") refresh();
    };
    refresh();
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", refresh);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", refresh);
    };
  }, [runId, shouldPoll]);

  return {
    run,
    pollError: poller.data?.error ?? null,
  };
}

function useLiveReadiness(authorized: boolean): {
  readiness: DemoReadiness | null;
  readinessError: string | null;
} {
  const fetcher = useFetcher<{
    readiness?: DemoReadiness;
    error?: string;
  }>();
  const loadRef = useRef(fetcher.load);
  useEffect(() => {
    loadRef.current = fetcher.load;
  }, [fetcher.load]);

  useEffect(() => {
    if (!authorized) return;
    const refresh = () => {
      if (document.visibilityState === "visible") {
        loadRef.current("/api/demo-readiness");
      }
    };
    const interval = window.setInterval(refresh, 30_000);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") refresh();
    };
    refresh();
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", refresh);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", refresh);
    };
  }, [authorized]);

  return {
    readiness: fetcher.data?.readiness ?? null,
    readinessError: fetcher.data?.error ?? null,
  };
}

export default function Demo({ loaderData }: Route.ComponentProps) {
  const actionData = useActionData<ActionResponse>();
  const { run, pollError } = useLiveRun(loaderData.run);
  const { readiness, readinessError } = useLiveReadiness(
    loaderData.authorized,
  );
  const location = useLocation();
  const isPresenter =
    new URLSearchParams(location.search).get("present") === "1";

  if (!loaderData.authorized) {
    return (
      <div className="demo-locked-layout">
        <section className="demo-unlock-card" aria-labelledby="unlock-title">
          <div className="demo-lock-orbit" aria-hidden="true">
            <span>v</span>
          </div>
          <p className="eyebrow">Presenter access</p>
          <h1 id="unlock-title">Run the trust network live.</h1>
          <p>
            Two browser clicks launch real Arc transactions. Enter the show-day
            passcode to protect the funded demo wallets.
          </p>
          {actionData?.error && (
            <div className="notice notice-error" role="alert">
              {actionData.error}
            </div>
          )}
          <Form method="post" className="demo-unlock-form">
            <input type="hidden" name="intent" value="unlock" />
            <label htmlFor="demo-passcode">Presenter passcode</label>
            <div>
              <input
                id="demo-passcode"
                name="passcode"
                type="password"
                autoComplete="current-password"
                required
                disabled={!loaderData.configured}
              />
              <button
                type="submit"
                className="demo-button demo-button-primary"
                disabled={!loaderData.configured}
              >
                Unlock live demo
                <span aria-hidden="true">→</span>
              </button>
            </div>
          </Form>
          {!loaderData.configured && (
            <p className="demo-config-warning">
              Set <span className="mono">DEMO_ACCESS_CODE</span> and{" "}
              <span className="mono">DEMO_SESSION_SECRET</span> on vapi-web.
            </p>
          )}
          <div className="demo-security-note">
            <span aria-hidden="true">⌁</span>
            Private keys never enter this browser. Commands are signed by the
            isolated Railway review service.
          </div>
        </section>
        <LockedDemoPreview run={loaderData.publicLatest} />
      </div>
    );
  }

  return (
    <div className="demo-page">
      {isPresenter && <PresenterControls />}
      <header className="demo-hero">
        <div>
          <p className="eyebrow">Live Arc execution</p>
          <h1>
            Agent work, human judgment,
            <br />
            <span>public proof.</span>
          </h1>
          <p className="lede">
            Watch an agent escrow USDC, purchase an independent review, pay the
            auditor, and settle the freelancer—all without leaving this page.
          </p>
        </div>
        <div className="demo-hero-actions">
          {!isPresenter && (
            <Link to="/demo?present=1" className="demo-present-link">
              Presenter mode <span aria-hidden="true">↗</span>
            </Link>
          )}
          <Form method="post">
            <input type="hidden" name="intent" value="lock" />
            <button type="submit" className="demo-lock-button">
              Lock
            </button>
          </Form>
        </div>
      </header>

      <ReadinessPanel readiness={readiness} error={readinessError} />

      {(actionData?.error ||
        loaderData.serviceError ||
        readinessError ||
        pollError) && (
        <div className="notice notice-error demo-page-notice" role="alert">
          {actionData?.error ||
            pollError ||
            readinessError ||
            loaderData.serviceError}
        </div>
      )}

      <div className="demo-console">
        <div className="demo-console-timeline">
          {run ? (
            <DemoTimeline run={run} />
          ) : (
            <section className="demo-timeline-card demo-timeline-empty">
              <div className="demo-empty-orbit" aria-hidden="true">
                <span />
              </div>
              <p className="eyebrow">Trust path</p>
              <h2>Ready for a new live run</h2>
              <p>
                Create the escrow to reveal every verified step from agent
                payment to public evidence.
              </p>
              <div className="demo-empty-stages" aria-hidden="true">
                <span>Escrow</span>
                <span>Purchase</span>
                <span>Judgment</span>
                <span>Settlement</span>
              </div>
            </section>
          )}
        </div>
        <div className="demo-console-action">
          <DemoActionPanel
            run={run}
            readiness={readiness}
            createRequestId={loaderData.createRequestId}
          />
        </div>
      </div>

      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {run ? DEMO_STATE_LABELS[run.state] : "Ready to begin"}
      </div>

      <ScenarioDetails run={run} readiness={readiness} />
      {run && <DemoReceipts run={run} />}
      {run && <DemoEventLog run={run} />}
    </div>
  );
}
