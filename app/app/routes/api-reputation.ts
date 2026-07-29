import type { Route } from "./+types/api-reputation";
import {
  getDashboardChainSnapshot,
  reputationFromSnapshot,
} from "~/lib/review-service.server";

export async function loader({ params }: Route.LoaderArgs) {
  try {
    const snapshot = await getDashboardChainSnapshot();
    if (!snapshot.ok) {
      throw new Error(snapshot.message);
    }
    const reputation = reputationFromSnapshot(params.address, snapshot.data);
    const { history: _history, ...payload } = reputation;
    const stale =
      snapshot.data.status === "stale" ||
      snapshot.data.status === "degraded";
    return Response.json(
      {
        ...payload,
        snapshot: {
          status: snapshot.data.status,
          indexedAt: snapshot.data.indexedAt,
          latestBlock: snapshot.data.latestBlock,
        },
      },
      {
        headers: {
          "Cache-Control": stale
            ? "public, max-age=5, s-maxage=5"
            : "public, max-age=30, s-maxage=30",
          "X-vAPI-Snapshot-Status": snapshot.data.status,
          ...(stale
            ? { Warning: '110 - "Response is from the last verified snapshot"' }
            : {}),
        },
      },
    );
  } catch (error) {
    if (error instanceof Response && error.status === 400) {
      return Response.json(
        {
          error: "Invalid provider address",
          detail: "Use a complete 0x-prefixed Ethereum address.",
        },
        { status: 400 },
      );
    }
    return Response.json(
      {
        error: "Arc Testnet data is temporarily unavailable",
        detail: "Please retry in a moment.",
      },
      { status: 503 },
    );
  }
}
