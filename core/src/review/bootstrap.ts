import type { ReviewerBootstrapConfig } from "./config.js";
import { ReviewDatabase } from "./database.js";
import type { Reviewer } from "./types.js";

export function applyReviewerBootstrap(
  database: ReviewDatabase,
  reviewers: readonly ReviewerBootstrapConfig[],
): Reviewer[] {
  return reviewers.map((reviewer) =>
    database.upsertReviewer({
      telegramUserId: reviewer.telegramUserId,
      telegramChatId: reviewer.telegramChatId,
      alias: reviewer.alias,
      payoutAddress: reviewer.payoutAddress,
      skills: reviewer.skills,
      active: reviewer.active,
    }),
  );
}
