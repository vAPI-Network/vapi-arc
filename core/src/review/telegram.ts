import type { Address } from "viem";
import type { ReviewServiceConfig } from "./config.js";
import { ReviewDatabase } from "./database.js";
import type {
  ReviewDecision,
  Reviewer,
  ReviewOrder,
} from "./types.js";
import { TelegramVerdictPromptStore } from "./telegram-prompt-store.js";

interface TelegramUser {
  id: number;
}

interface TelegramChat {
  id: number;
}

interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  text?: string;
  reply_to_message?: TelegramMessage;
}

interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  data?: string;
  message?: TelegramMessage;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

export interface TelegramGateway {
  registerWebhook(): Promise<void>;
  dispatch(order: ReviewOrder, reviewers: Reviewer[]): Promise<number>;
  handleUpdate(update: TelegramUpdate): Promise<void>;
}

export interface TelegramWorkflowCallbacks {
  onVerdict(order: ReviewOrder): void | Promise<void>;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function parseVerdictCommand(
  text: string,
):
  | { orderId: string; decision: ReviewDecision; reasoning: string }
  | undefined {
  const match = text.match(
    /^\/verdict(?:@\w+)?\s+([0-9a-f-]{36})\s+(approve|reject)\s+([\s\S]+)$/i,
  );
  if (!match?.[1] || !match[2] || !match[3]) return undefined;
  const reasoning = match[3].trim();
  if (reasoning.length < 10 || reasoning.length > 1_000) return undefined;
  return {
    orderId: match[1],
    decision: match[2].toLowerCase() as ReviewDecision,
    reasoning,
  };
}

export class TelegramBotGateway implements TelegramGateway {
  private readonly baseUrl: string;
  private readonly promptStore: TelegramVerdictPromptStore;

  constructor(
    private readonly token: string,
    private readonly config: ReviewServiceConfig,
    private readonly database: ReviewDatabase,
    private readonly callbacks: TelegramWorkflowCallbacks,
  ) {
    this.baseUrl = `https://api.telegram.org/bot${token}`;
    this.promptStore = new TelegramVerdictPromptStore(database);
  }

  private async call<T>(
    method: string,
    body: Record<string, unknown> | FormData,
  ): Promise<T> {
    const formData = body instanceof FormData;
    const response = await fetch(`${this.baseUrl}/${method}`, {
      method: "POST",
      headers: formData ? undefined : { "content-type": "application/json" },
      body: formData ? body : JSON.stringify(body),
    });
    const decoded = (await response.json()) as TelegramResponse<T>;
    if (!response.ok || !decoded.ok || decoded.result === undefined) {
      throw new Error(
        `Telegram ${method} failed: ${decoded.description ?? response.status}`,
      );
    }
    return decoded.result;
  }

  async registerWebhook(): Promise<void> {
    if (!this.config.telegramWebhookSecret) {
      throw new Error(
        "TELEGRAM_WEBHOOK_SECRET is required to register the Telegram webhook",
      );
    }
    const registered = await this.call<boolean>("setWebhook", {
      url: `${this.config.publicBaseUrl}/v1/telegram/webhook`,
      secret_token: this.config.telegramWebhookSecret,
      allowed_updates: ["message", "callback_query"],
    });
    if (!registered) throw new Error("Telegram did not register the webhook");
  }

  async dispatch(order: ReviewOrder, reviewers: Reviewer[]): Promise<number> {
    if (!order.escalationCause) {
      throw new Error("review order is missing verified escalation provenance");
    }
    const expiresAt = new Date(
      Date.now() + this.config.claimTtlSeconds * 1_000,
    ).toISOString();
    let sent = 0;
    for (const reviewer of reviewers) {
      try {
        if (Buffer.byteLength(order.deliverableContent, "utf8") > 2_000) {
          await this.sendDeliverableFile(order, reviewer);
        }
        const message = [
          "<b>Paid vAPI human review</b>",
          `Job <code>${escapeHtml(order.jobId)}</code>`,
          `Reward: <b>${formatUsdc(order.reward)} USDC</b>`,
          `Budget: ${formatUsdc(order.jobBudget)} USDC`,
          `Deadline: ${escapeHtml(new Date(Number(order.jobExpiredAt) * 1_000).toISOString())}`,
          `Escalation: ${escapeHtml(order.escalationCause)}`,
          "",
          `<b>Acceptance criteria</b>\n${escapeHtml(truncate(order.jobDescription, 1_200))}`,
          "",
          `<b>Deliverable preview</b>\n<pre>${escapeHtml(truncate(order.deliverableContent, 2_000))}</pre>`,
          "",
          `Claim expires: ${escapeHtml(expiresAt)}`,
          `${this.config.publicBaseUrl}/v1/review-orders/${order.id}`,
        ].join("\n");
        const result = await this.call<TelegramMessage>("sendMessage", {
          chat_id: reviewer.telegramChatId,
          text: message,
          parse_mode: "HTML",
          disable_web_page_preview: true,
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "Claim review",
                  callback_data: `claim:${order.id}`,
                },
              ],
            ],
          },
        });
        this.database.recordDispatch(
          order.id,
          reviewer.id,
          String(result.message_id),
          expiresAt,
        );
        sent += 1;
      } catch (error) {
        this.database.addEvent(order.id, "telegram_dispatch_failed", {
          reviewerId: reviewer.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return sent;
  }

  private async sendDeliverableFile(
    order: ReviewOrder,
    reviewer: Reviewer,
  ): Promise<void> {
    const form = new FormData();
    form.set("chat_id", reviewer.telegramChatId);
    form.set(
      "document",
      new Blob([order.deliverableContent], { type: "text/plain" }),
      `vapi-job-${order.jobId}.txt`,
    );
    form.set("caption", `Full deliverable for job ${order.jobId}`);
    await this.call<TelegramMessage>("sendDocument", form);
  }

  async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (update.callback_query) {
      await this.handleCallback(update.callback_query);
      return;
    }
    const message = update.message;
    if (!message?.from || !message.text) return;
    const command = parseVerdictCommand(message.text);
    if (command) {
      await this.handleLegacyVerdict(message, command);
      return;
    }
    if (message.text.startsWith("/verdict")) {
      await this.sendText(
        String(message.chat.id),
        "Usage: /verdict <order-id> approve|reject <reason of 10–1000 characters>",
      );
      return;
    }
    if (message.reply_to_message) {
      await this.handleReasonReply(message);
    }
  }

  private async getMessageReviewer(
    message: TelegramMessage,
  ): Promise<Reviewer | undefined> {
    if (!message.from) return undefined;
    const reviewer = this.database.getReviewerByTelegramUserId(
      String(message.from.id),
    );
    if (!reviewer?.active) {
      await this.sendText(
        String(message.chat.id),
        "This Telegram account is not an active vAPI reviewer.",
      );
      return undefined;
    }
    if (String(message.chat.id) !== reviewer.telegramChatId) {
      await this.sendText(
        String(message.chat.id),
        "Review actions must be completed in your registered vAPI reviewer chat.",
      );
      return undefined;
    }
    return reviewer;
  }

  private async handleLegacyVerdict(
    message: TelegramMessage,
    command: {
      orderId: string;
      decision: ReviewDecision;
      reasoning: string;
    },
  ): Promise<void> {
    const reviewer = await this.getMessageReviewer(message);
    if (!reviewer) return;
    await this.submitVerdictAndNotify(
      reviewer,
      command.orderId,
      command.decision,
      command.reasoning,
    );
  }

  private async handleReasonReply(message: TelegramMessage): Promise<void> {
    const reviewer = await this.getMessageReviewer(message);
    if (!reviewer || !message.from || !message.reply_to_message) return;
    const lookup = this.promptStore.lookupReply({
      reviewerId: reviewer.id,
      telegramUserId: String(message.from.id),
      telegramChatId: String(message.chat.id),
      promptMessageId: String(message.reply_to_message.message_id),
    });
    if (lookup.status !== "active") {
      const explanation: Record<
        Exclude<typeof lookup.status, "active">,
        string
      > = {
        not_found:
          "That message is not an active vAPI verdict prompt. Choose Approve or Reject again.",
        not_authorized:
          "That verdict prompt belongs to a different reviewer.",
        consumed: "That verdict prompt has already been used.",
        superseded:
          "A newer verdict prompt replaced that one. Reply to the latest bot message.",
        expired:
          "That verdict prompt expired. The review can no longer accept this reply.",
      };
      await this.sendText(
        reviewer.telegramChatId,
        explanation[lookup.status],
      );
      return;
    }
    const reasoning = message.text?.trim() ?? "";
    if (reasoning.length < 10 || reasoning.length > 1_000) {
      await this.sendText(
        reviewer.telegramChatId,
        "Please reply to the same prompt with a reason of 10–1000 characters.",
      );
      return;
    }
    const order = this.database.getOrder(lookup.prompt.orderId);
    if (
      !order ||
      order.state !== "claimed" ||
      order.reviewerId !== reviewer.id
    ) {
      await this.sendText(
        reviewer.telegramChatId,
        "This review is no longer awaiting your verdict.",
      );
      return;
    }
    await this.submitVerdictAndNotify(
      reviewer,
      order.id,
      lookup.prompt.decision,
      reasoning,
      lookup.prompt.id,
    );
  }

  private async submitVerdictAndNotify(
    reviewer: Reviewer,
    orderId: string,
    decision: ReviewDecision,
    reasoning: string,
    promptId?: string,
  ): Promise<void> {
    try {
      const order = this.database.submitVerdict(
        orderId,
        reviewer.id,
        decision,
        reasoning,
        this.config.reviewSlaSeconds,
      );
      try {
        if (promptId) {
          this.promptStore.consume(promptId);
        } else {
          this.promptStore.supersedeActive(order.id, reviewer.id);
        }
      } catch (error) {
        this.database.addEvent(order.id, "telegram_prompt_finalize_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      await this.sendText(
        reviewer.telegramChatId,
        `Verdict recorded for job ${order.jobId}. Payout and Arc settlement are now processing.`,
      );
      try {
        void Promise.resolve(this.callbacks.onVerdict(order)).catch((error) => {
          this.database.addEvent(order.id, "review_worker_wake_failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      } catch (error) {
        this.database.addEvent(order.id, "review_worker_wake_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } catch (error) {
      await this.sendText(
        reviewer.telegramChatId,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async handleCallback(query: TelegramCallbackQuery): Promise<void> {
    const [action, orderId] = query.data?.split(":") ?? [];
    if (!orderId || !["claim", "approve", "reject"].includes(action ?? "")) {
      await this.answerCallback(query.id, "Unknown review action");
      return;
    }
    const reviewer = this.database.getReviewerByTelegramUserId(
      String(query.from.id),
    );
    if (!reviewer?.active) {
      await this.answerCallback(query.id, "You are not an active reviewer");
      return;
    }
    try {
      if (
        !query.message ||
        String(query.message.chat.id) !== reviewer.telegramChatId
      ) {
        throw new Error(
          "Use this action in your registered vAPI reviewer chat",
        );
      }
      const order = this.database.getOrder(orderId);
      if (!order) throw new Error("review order not found");
      if (action === "approve" || action === "reject") {
        if (order.state !== "claimed" || order.reviewerId !== reviewer.id) {
          throw new Error("Only the assigned reviewer can decide this order");
        }
        const deadline = this.reviewDeadline(order);
        const decision = action as ReviewDecision;
        const promptMessage = await this.sendReasonPrompt(
          reviewer,
          order,
          decision,
        );
        this.promptStore.create({
          orderId: order.id,
          reviewerId: reviewer.id,
          telegramUserId: reviewer.telegramUserId,
          telegramChatId: reviewer.telegramChatId,
          decision,
          promptMessageId: String(promptMessage.message_id),
          expiresAt: deadline,
        });
        this.database.addEvent(order.id, "telegram_reason_prompted", {
          reviewerId: reviewer.id,
          decision,
          promptMessageId: String(promptMessage.message_id),
          expiresAt: deadline,
        });
        await this.answerCallback(
          query.id,
          `${action === "approve" ? "Approve" : "Reject"} selected`,
        );
        return;
      }
      const assignment = this.database.getAssignment(order.id, reviewer.id);
      if (
        !assignment ||
        assignment.telegramMessageId !== String(query.message.message_id)
      ) {
        throw new Error("This review offer is no longer active");
      }
      if (
        sameAddress(reviewer.payoutAddress, order.jobClient) ||
        sameAddress(reviewer.payoutAddress, order.jobProvider)
      ) {
        throw new Error("client/provider conflicts cannot claim this review");
      }
      const claimed = this.database.claimOrder(
        orderId,
        reviewer.id,
        this.config.reviewSlaSeconds,
        this.config.circleWalletAddress
          ? [this.config.circleWalletAddress]
          : [],
      );
      await this.answerCallback(query.id, "Review claimed");
      await this.sendDecisionPrompt(reviewer.telegramChatId, claimed);
    } catch (error) {
      await this.answerCallback(
        query.id,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async answerCallback(id: string, text: string): Promise<void> {
    await this.call<boolean>("answerCallbackQuery", {
      callback_query_id: id,
      text: truncate(text, 180),
      show_alert: false,
    });
  }

  private async sendText(chatId: string, text: string): Promise<void> {
    await this.call<TelegramMessage>("sendMessage", {
      chat_id: chatId,
      text,
    });
  }

  private async sendDecisionPrompt(
    chatId: string,
    order: ReviewOrder,
  ): Promise<void> {
    await this.call<TelegramMessage>("sendMessage", {
      chat_id: chatId,
      text: `You claimed job ${order.jobId}. Choose a decision, then provide the required written reason.`,
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "Approve",
              callback_data: `approve:${order.id}`,
            },
            {
              text: "Reject",
              callback_data: `reject:${order.id}`,
            },
          ],
        ],
      },
    });
  }

  private reviewDeadline(order: ReviewOrder): string {
    const createdAt = Date.parse(order.createdAt);
    const expiresAt = createdAt + this.config.reviewSlaSeconds * 1_000;
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      throw new Error("review SLA has elapsed");
    }
    return new Date(expiresAt).toISOString();
  }

  private sendReasonPrompt(
    reviewer: Reviewer,
    order: ReviewOrder,
    decision: ReviewDecision,
  ): Promise<TelegramMessage> {
    return this.call<TelegramMessage>("sendMessage", {
      chat_id: reviewer.telegramChatId,
      text: [
        `${decision === "approve" ? "Approve" : "Reject"} selected for job ${order.jobId}.`,
        "Reply to this message with your written reason only (10–1000 characters).",
      ].join("\n"),
      reply_markup: {
        force_reply: true,
        selective: true,
        input_field_placeholder: "Explain your verdict…",
      },
    });
  }
}

function sameAddress(a: Address, b: Address): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function formatUsdc(units: string): string {
  const value = BigInt(units);
  const whole = value / 1_000_000n;
  const fraction = (value % 1_000_000n)
    .toString()
    .padStart(6, "0")
    .replace(/0+$/, "");
  return `${whole.toString()}${fraction ? `.${fraction}` : ""}`;
}

export function createTelegramGateway(
  config: ReviewServiceConfig,
  database: ReviewDatabase,
  callbacks: TelegramWorkflowCallbacks,
): TelegramGateway | undefined {
  if (!config.telegramBotToken) return undefined;
  return new TelegramBotGateway(
    config.telegramBotToken,
    config,
    database,
    callbacks,
  );
}

export function isTelegramUpdate(value: unknown): value is TelegramUpdate {
  return (
    typeof value === "object" &&
    value !== null &&
    Number.isSafeInteger((value as { update_id?: unknown }).update_id)
  );
}
