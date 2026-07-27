import type { Route } from "./+types/api-reputation";
import { getReputationData } from "~/lib/chain.server";

export async function loader({ params }: Route.LoaderArgs) {
  try {
    const reputation = await getReputationData(params.address);
    const { history: _history, ...payload } = reputation;
    return Response.json(payload, {
      headers: {
        "Cache-Control": "public, max-age=15, s-maxage=15",
      },
    });
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
