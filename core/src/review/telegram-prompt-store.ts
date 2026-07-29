import { randomUUID } from "node:crypto";
import type { ReviewDatabase } from "./database.js";
import type { ReviewDecision } from "./types.js";

export type TelegramVerdictPromptStatus =
  | "active"
  | "consumed"
  | "superseded"
  | "expired";

interface TelegramVerdictPromptRow {
  id: string;
  order_id: string;
  reviewer_id: string;
  telegram_user_id: string;
  telegram_chat_id: string;
  decision: ReviewDecision;
  prompt_message_id: string;
  expires_at: string;
  status: TelegramVerdictPromptStatus;
  created_at: string;
  consumed_at: string | null;
  superseded_at: string | null;
}

export interface TelegramVerdictPrompt {
  id: string;
  orderId: string;
  reviewerId: string;
  telegramUserId: string;
  telegramChatId: string;
  decision: ReviewDecision;
  promptMessageId: string;
  expiresAt: string;
  status: TelegramVerdictPromptStatus;
  createdAt: string;
  consumedAt: string | null;
  supersededAt: string | null;
}

export type TelegramPromptLookup =
  | { status: "active"; prompt: TelegramVerdictPrompt }
  | {
      status: "not_found" | "not_authorized" | "consumed" | "superseded" | "expired";
    };

function fromRow(row: TelegramVerdictPromptRow): TelegramVerdictPrompt {
  return {
    id: row.id,
    orderId: row.order_id,
    reviewerId: row.reviewer_id,
    telegramUserId: row.telegram_user_id,
    telegramChatId: row.telegram_chat_id,
    decision: row.decision,
    promptMessageId: row.prompt_message_id,
    expiresAt: row.expires_at,
    status: row.status,
    createdAt: row.created_at,
    consumedAt: row.consumed_at,
    supersededAt: row.superseded_at,
  };
}

/**
 * Durable correlation between Telegram ForceReply messages and review verdicts.
 *
 * This migration lives beside the Telegram workflow so ReviewDatabase can remain
 * focused on review-domain state while the bot can still recover across process
 * restarts.
 */
export class TelegramVerdictPromptStore {
  constructor(private readonly database: ReviewDatabase) {
    this.migrate();
  }

  private migrate(): void {
    this.database.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS telegram_verdict_prompts (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL REFERENCES review_orders(id) ON DELETE CASCADE,
        reviewer_id TEXT NOT NULL REFERENCES reviewers(id),
        telegram_user_id TEXT NOT NULL,
        telegram_chat_id TEXT NOT NULL,
        decision TEXT NOT NULL CHECK (decision IN ('approve', 'reject')),
        prompt_message_id TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active'
          CHECK (status IN ('active', 'consumed', 'superseded', 'expired')),
        created_at TEXT NOT NULL,
        consumed_at TEXT,
        superseded_at TEXT,
        UNIQUE(telegram_chat_id, prompt_message_id)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS one_active_telegram_verdict_prompt
        ON telegram_verdict_prompts(order_id, reviewer_id)
        WHERE status = 'active';

      CREATE INDEX IF NOT EXISTS telegram_verdict_prompt_reply_lookup
        ON telegram_verdict_prompts(telegram_chat_id, prompt_message_id);
    `);
  }

  create(input: {
    orderId: string;
    reviewerId: string;
    telegramUserId: string;
    telegramChatId: string;
    decision: ReviewDecision;
    promptMessageId: string;
    expiresAt: string;
  }): TelegramVerdictPrompt {
    const createdAt = new Date().toISOString();
    const id = randomUUID();
    const transaction = this.database.sqlite.transaction(() => {
      this.database.sqlite
        .prepare(
          `UPDATE telegram_verdict_prompts
              SET status = 'superseded', superseded_at = ?
            WHERE order_id = ? AND reviewer_id = ? AND status = 'active'`,
        )
        .run(createdAt, input.orderId, input.reviewerId);
      this.database.sqlite
        .prepare(
          `INSERT INTO telegram_verdict_prompts (
             id, order_id, reviewer_id, telegram_user_id, telegram_chat_id,
             decision, prompt_message_id, expires_at, status, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
        )
        .run(
          id,
          input.orderId,
          input.reviewerId,
          input.telegramUserId,
          input.telegramChatId,
          input.decision,
          input.promptMessageId,
          input.expiresAt,
          createdAt,
        );
      return this.get(id)!;
    });
    return transaction.immediate();
  }

  lookupReply(input: {
    reviewerId: string;
    telegramUserId: string;
    telegramChatId: string;
    promptMessageId: string;
  }): TelegramPromptLookup {
    const transaction = this.database.sqlite.transaction(() => {
      const row = this.database.sqlite
        .prepare(
          `SELECT * FROM telegram_verdict_prompts
            WHERE telegram_chat_id = ? AND prompt_message_id = ?`,
        )
        .get(
          input.telegramChatId,
          input.promptMessageId,
        ) as TelegramVerdictPromptRow | undefined;
      if (!row) return { status: "not_found" } as const;
      if (
        row.reviewer_id !== input.reviewerId ||
        row.telegram_user_id !== input.telegramUserId
      ) {
        return { status: "not_authorized" } as const;
      }
      if (row.status !== "active") {
        return { status: row.status } as TelegramPromptLookup;
      }
      if (Date.parse(row.expires_at) <= Date.now()) {
        this.database.sqlite
          .prepare(
            `UPDATE telegram_verdict_prompts
                SET status = 'expired'
              WHERE id = ? AND status = 'active'`,
          )
          .run(row.id);
        return { status: "expired" } as const;
      }
      return { status: "active", prompt: fromRow(row) } as const;
    });
    return transaction.immediate();
  }

  consume(promptId: string): void {
    const result = this.database.sqlite
      .prepare(
        `UPDATE telegram_verdict_prompts
            SET status = 'consumed', consumed_at = ?
          WHERE id = ? AND status = 'active'`,
      )
      .run(new Date().toISOString(), promptId);
    if (Number(result.changes) !== 1) {
      const existing = this.get(promptId);
      if (existing?.status === "consumed") return;
      throw new Error("Telegram verdict prompt is no longer active");
    }
  }

  supersedeActive(orderId: string, reviewerId: string): void {
    const timestamp = new Date().toISOString();
    this.database.sqlite
      .prepare(
        `UPDATE telegram_verdict_prompts
            SET status = 'superseded', superseded_at = ?
          WHERE order_id = ? AND reviewer_id = ? AND status = 'active'`,
      )
      .run(timestamp, orderId, reviewerId);
  }

  get(id: string): TelegramVerdictPrompt | undefined {
    const row = this.database.sqlite
      .prepare("SELECT * FROM telegram_verdict_prompts WHERE id = ?")
      .get(id) as TelegramVerdictPromptRow | undefined;
    return row ? fromRow(row) : undefined;
  }
}
