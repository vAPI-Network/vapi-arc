import { randomUUID } from "node:crypto";
import { getAddress, type Address, type Hex } from "viem";
import { ReviewDatabase } from "./database.js";
import {
  demoTransactionKeys,
  type DemoRun,
  type DemoRunEvent,
  type DemoRunState,
  type DemoTransactionKey,
  type DemoTransactions,
} from "./types.js";

interface DemoRunRow {
  id: string;
  request_id: string;
  scenario: "human-only";
  scenario_version: "human-review-v1";
  state: DemoRunState;
  current_operation: string | null;
  recovery_state: DemoRunState | null;
  job_id: string | null;
  order_id: string | null;
  title: string;
  description: string;
  acceptance_criteria: string;
  deliverable_content: string;
  deliverable_hash: string;
  client_address: string;
  provider_address: string;
  budget: string;
  review_price: string;
  reward: string;
  expires_at: string;
  chain_start_block: string | null;
  completed_steps_json: string;
  create_job_tx: string | null;
  set_lane_tx: string | null;
  set_budget_tx: string | null;
  approval_tx: string | null;
  fund_tx: string | null;
  submit_tx: string | null;
  escalation_tx: string | null;
  payment_tx: string | null;
  payout_tx: string | null;
  resolution_tx: string | null;
  review_refund_tx: string | null;
  escrow_refund_tx: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  on_chain_verified: number;
  last_error: string | null;
}

interface DemoEventRow {
  id: number;
  run_id: string;
  type: string;
  payload_json: string;
  created_at: string;
}

export interface CreateDemoRunInput {
  runId?: string;
  requestId: string;
  title: string;
  description: string;
  acceptanceCriteria: string;
  deliverableContent: string;
  deliverableHash: Hex;
  clientAddress: Address;
  providerAddress: Address;
  budget: string;
  reviewPrice: string;
  reward: string;
  expiresAt: string;
}

export type DemoRunPatch = Partial<{
  state: DemoRunState;
  currentOperation: string | null;
  recoveryState: DemoRunState | null;
  jobId: string;
  orderId: string;
  chainStartBlock: string;
  completedAt: string | null;
  onChainVerified: boolean;
  lastError: string | null;
}>;

export class DemoRepositoryError extends Error {
  constructor(
    readonly code:
      | "demo_run_not_found"
      | "demo_run_conflict"
      | "demo_rate_limited",
    message: string,
    readonly statusCode: 404 | 409 | 429,
  ) {
    super(message);
  }
}

const transactionColumns: Record<DemoTransactionKey, string> = {
  createJob: "create_job_tx",
  setLane: "set_lane_tx",
  setBudget: "set_budget_tx",
  approval: "approval_tx",
  fund: "fund_tx",
  submit: "submit_tx",
  escalation: "escalation_tx",
  payment: "payment_tx",
  payout: "payout_tx",
  resolution: "resolution_tx",
  reviewRefund: "review_refund_tx",
  escrowRefund: "escrow_refund_tx",
};

function nowIso(): string {
  return new Date().toISOString();
}

function parseJsonArray(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  if (
    !Array.isArray(parsed) ||
    parsed.some((entry) => typeof entry !== "string")
  ) {
    throw new Error("stored demo completed steps are invalid");
  }
  return parsed;
}

function runFromRow(row: DemoRunRow): DemoRun {
  const transactions = Object.fromEntries(
    demoTransactionKeys.map((key) => [
      key,
      row[transactionColumns[key] as keyof DemoRunRow] as string | null,
    ]),
  ) as DemoTransactions;
  return {
    id: row.id,
    requestId: row.request_id,
    scenario: row.scenario,
    scenarioVersion: row.scenario_version,
    state: row.state,
    currentOperation: row.current_operation,
    recoveryState: row.recovery_state,
    jobId: row.job_id,
    orderId: row.order_id,
    title: row.title,
    description: row.description,
    acceptanceCriteria: row.acceptance_criteria,
    deliverableContent: row.deliverable_content,
    deliverableHash: row.deliverable_hash as Hex,
    clientAddress: getAddress(row.client_address),
    providerAddress: getAddress(row.provider_address),
    budget: row.budget,
    reviewPrice: row.review_price,
    reward: row.reward,
    expiresAt: row.expires_at,
    chainStartBlock: row.chain_start_block,
    completedSteps: parseJsonArray(row.completed_steps_json),
    transactions,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    onChainVerified: row.on_chain_verified === 1,
    lastError: row.last_error,
  };
}

function eventFromRow(row: DemoEventRow): DemoRunEvent {
  return {
    id: row.id,
    runId: row.run_id,
    type: row.type,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    createdAt: row.created_at,
  };
}

export class DemoRepository {
  constructor(private readonly database: ReviewDatabase) {
    this.migrate();
  }

  private migrate(): void {
    this.database.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS demo_runs (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE,
        scenario TEXT NOT NULL CHECK (scenario = 'human-only'),
        scenario_version TEXT NOT NULL CHECK (scenario_version = 'human-review-v1'),
        state TEXT NOT NULL CHECK (state IN (
          'queued', 'preparing_escrow', 'awaiting_escalation',
          'awaiting_purchase', 'purchasing_review', 'review_active',
          'finalized', 'failed', 'archived_refund_pending',
          'archived_refunded'
        )),
        current_operation TEXT,
        recovery_state TEXT,
        job_id TEXT UNIQUE,
        order_id TEXT UNIQUE,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        acceptance_criteria TEXT NOT NULL,
        deliverable_content TEXT NOT NULL,
        deliverable_hash TEXT NOT NULL,
        client_address TEXT NOT NULL,
        provider_address TEXT NOT NULL,
        budget TEXT NOT NULL,
        review_price TEXT NOT NULL,
        reward TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        chain_start_block TEXT,
        completed_steps_json TEXT NOT NULL DEFAULT '[]',
        create_job_tx TEXT,
        set_lane_tx TEXT,
        set_budget_tx TEXT,
        approval_tx TEXT,
        fund_tx TEXT,
        submit_tx TEXT,
        escalation_tx TEXT,
        payment_tx TEXT,
        payout_tx TEXT,
        resolution_tx TEXT,
        review_refund_tx TEXT,
        escrow_refund_tx TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        on_chain_verified INTEGER NOT NULL DEFAULT 0
          CHECK (on_chain_verified IN (0, 1)),
        last_error TEXT
      );

      CREATE TABLE IF NOT EXISTS demo_run_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES demo_runs(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS demo_runs_state_idx
        ON demo_runs(state, updated_at);
      CREATE INDEX IF NOT EXISTS demo_runs_created_idx
        ON demo_runs(created_at DESC);
      CREATE INDEX IF NOT EXISTS demo_events_run_idx
        ON demo_run_events(run_id, id);
    `);
    this.ensureColumn("demo_runs", "review_refund_tx", "TEXT");
    this.ensureColumn("demo_runs", "escrow_refund_tx", "TEXT");
    this.ensureColumn(
      "demo_runs",
      "on_chain_verified",
      "INTEGER NOT NULL DEFAULT 0 CHECK (on_chain_verified IN (0, 1))",
    );
  }

  private ensureColumn(
    table: string,
    column: string,
    declaration: string,
  ): void {
    const columns = this.database.sqlite
      .prepare(`PRAGMA table_info(${table})`)
      .all() as Array<{ name: string }>;
    if (columns.some((entry) => entry.name === column)) return;
    this.database.sqlite.exec(
      `ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`,
    );
  }

  private immediate<T>(operation: () => T): T {
    return this.database.sqlite.transaction(operation).immediate();
  }

  createRun(
    input: CreateDemoRunInput,
    maxRunsPerHour: number,
  ): { run: DemoRun; created: boolean } {
    return this.immediate(() => {
      const existing = this.getByRequestId(input.requestId);
      if (existing) return { run: existing, created: false };

      const active = this.database.sqlite
        .prepare(
          `SELECT id FROM demo_runs
            WHERE state IN (
              'queued', 'preparing_escrow', 'awaiting_escalation',
              'awaiting_purchase', 'purchasing_review', 'review_active'
            )
            LIMIT 1`,
        )
        .get() as { id: string } | undefined;
      if (active) {
        throw new DemoRepositoryError(
          "demo_run_conflict",
          `Demo run ${active.id} is already active`,
          409,
        );
      }

      const since = new Date(Date.now() - 60 * 60_000).toISOString();
      const recent = this.database.sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM demo_runs WHERE created_at >= ?",
        )
        .get(since) as { count: number };
      if (recent.count >= maxRunsPerHour) {
        throw new DemoRepositoryError(
          "demo_rate_limited",
          `At most ${maxRunsPerHour} demo runs may be started per hour`,
          429,
        );
      }

      const id = input.runId ?? randomUUID();
      const timestamp = nowIso();
      this.database.sqlite
        .prepare(
          `INSERT INTO demo_runs (
             id, request_id, scenario, scenario_version, state,
             current_operation, title, description, acceptance_criteria,
             deliverable_content, deliverable_hash, client_address,
             provider_address, budget, review_price, reward, expires_at,
             completed_steps_json, created_at, updated_at
           ) VALUES (
             ?, ?, 'human-only', 'human-review-v1', 'queued',
             'initialize', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?
           )`,
        )
        .run(
          id,
          input.requestId,
          input.title,
          input.description,
          input.acceptanceCriteria,
          input.deliverableContent,
          input.deliverableHash,
          input.clientAddress,
          input.providerAddress,
          input.budget,
          input.reviewPrice,
          input.reward,
          input.expiresAt,
          timestamp,
          timestamp,
        );
      this.insertEvent(id, "demo_run_created", {
        scenario: "human-review-v1",
      });
      return { run: this.get(id)!, created: true };
    });
  }

  get(id: string): DemoRun | undefined {
    const row = this.database.sqlite
      .prepare("SELECT * FROM demo_runs WHERE id = ?")
      .get(id) as DemoRunRow | undefined;
    return row ? runFromRow(row) : undefined;
  }

  getByRequestId(requestId: string): DemoRun | undefined {
    const row = this.database.sqlite
      .prepare("SELECT * FROM demo_runs WHERE request_id = ?")
      .get(requestId) as DemoRunRow | undefined;
    return row ? runFromRow(row) : undefined;
  }

  latest(): DemoRun | undefined {
    const row = this.database.sqlite
      .prepare(
        "SELECT * FROM demo_runs ORDER BY created_at DESC, rowid DESC LIMIT 1",
      )
      .get() as DemoRunRow | undefined;
    return row ? runFromRow(row) : undefined;
  }

  latestTerminal(): DemoRun | undefined {
    const row = this.database.sqlite
      .prepare(
        `SELECT * FROM demo_runs
          WHERE state IN ('finalized', 'archived_refunded')
          ORDER BY completed_at DESC, created_at DESC, rowid DESC
          LIMIT 1`,
      )
      .get() as DemoRunRow | undefined;
    return row ? runFromRow(row) : undefined;
  }

  listProcessable(): DemoRun[] {
    const rows = this.database.sqlite
      .prepare(
        `SELECT * FROM demo_runs
          WHERE state IN (
            'queued', 'preparing_escrow', 'awaiting_escalation',
            'purchasing_review', 'review_active', 'archived_refund_pending'
          )
          ORDER BY created_at`,
      )
      .all() as unknown as DemoRunRow[];
    return rows.map(runFromRow);
  }

  listEvents(runId: string): DemoRunEvent[] {
    const rows = this.database.sqlite
      .prepare(
        "SELECT * FROM demo_run_events WHERE run_id = ? ORDER BY id",
      )
      .all(runId) as unknown as DemoEventRow[];
    return rows.map(eventFromRow);
  }

  patch(runId: string, patch: DemoRunPatch): DemoRun {
    const columns: string[] = [];
    const values: unknown[] = [];
    const mapping: Record<keyof DemoRunPatch, string> = {
      state: "state",
      currentOperation: "current_operation",
      recoveryState: "recovery_state",
      jobId: "job_id",
      orderId: "order_id",
      chainStartBlock: "chain_start_block",
      completedAt: "completed_at",
      onChainVerified: "on_chain_verified",
      lastError: "last_error",
    };
    for (const [key, column] of Object.entries(mapping) as Array<
      [keyof DemoRunPatch, string]
    >) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) {
        columns.push(`${column} = ?`);
        values.push(
          key === "onChainVerified"
            ? patch[key]
              ? 1
              : 0
            : patch[key],
        );
      }
    }
    if (columns.length === 0) {
      const existing = this.get(runId);
      if (!existing) {
        throw new DemoRepositoryError(
          "demo_run_not_found",
          "Demo run was not found",
          404,
        );
      }
      return existing;
    }
    columns.push("updated_at = ?");
    values.push(nowIso(), runId);
    const result = this.database.sqlite
      .prepare(`UPDATE demo_runs SET ${columns.join(", ")} WHERE id = ?`)
      .run(...values);
    if (result.changes !== 1) {
      throw new DemoRepositoryError(
        "demo_run_not_found",
        "Demo run was not found",
        404,
      );
    }
    return this.get(runId)!;
  }

  transition(
    runId: string,
    state: DemoRunState,
    currentOperation: string | null,
    eventType: string,
    payload: Record<string, unknown> = {},
  ): DemoRun {
    return this.immediate(() => {
      const run = this.get(runId);
      if (!run) {
        throw new DemoRepositoryError(
          "demo_run_not_found",
          "Demo run was not found",
          404,
        );
      }
      const completedAt =
        state === "finalized" || state === "archived_refunded"
          ? nowIso()
          : null;
      const updated = this.patch(runId, {
        state,
        currentOperation,
        lastError: null,
        ...(completedAt ? { completedAt } : {}),
      });
      this.insertEvent(runId, eventType, payload);
      return updated;
    });
  }

  fail(runId: string, error: unknown): DemoRun {
    return this.immediate(() => {
      const run = this.get(runId);
      if (!run) {
        throw new DemoRepositoryError(
          "demo_run_not_found",
          "Demo run was not found",
          404,
        );
      }
      const message = error instanceof Error ? error.message : String(error);
      const recoveryState =
        run.state === "failed"
          ? (run.recoveryState ?? "preparing_escrow")
          : run.state;
      const updated = this.patch(runId, {
        state: "failed",
        recoveryState,
        lastError: message.slice(0, 1_000),
      });
      this.insertEvent(runId, "demo_step_failed", {
        operation: run.currentOperation,
        message: message.slice(0, 500),
      });
      return updated;
    });
  }

  noteTransientFailure(runId: string, error: unknown): DemoRun {
    return this.immediate(() => {
      const run = this.get(runId);
      if (!run) {
        throw new DemoRepositoryError(
          "demo_run_not_found",
          "Demo run was not found",
          404,
        );
      }
      const message = error instanceof Error ? error.message : String(error);
      const safeMessage = message.slice(0, 1_000);
      const updated = this.patch(runId, { lastError: safeMessage });
      this.insertEvent(runId, "demo_transient_check_failed", {
        operation: run.currentOperation,
        message: safeMessage.slice(0, 500),
      });
      return updated;
    });
  }

  recordTransaction(
    runId: string,
    key: DemoTransactionKey,
    transaction: string,
    eventType = "transaction_submitted",
  ): DemoRun {
    return this.immediate(() => {
      const column = transactionColumns[key];
      const result = this.database.sqlite
        .prepare(
          `UPDATE demo_runs SET ${column} = ?, updated_at = ? WHERE id = ?`,
        )
        .run(transaction, nowIso(), runId);
      if (result.changes !== 1) {
        throw new DemoRepositoryError(
          "demo_run_not_found",
          "Demo run was not found",
          404,
        );
      }
      this.insertEvent(runId, eventType, { operation: key, transaction });
      return this.get(runId)!;
    });
  }

  clearTransaction(
    runId: string,
    key: DemoTransactionKey,
    eventType = "transaction_retry_cleared",
  ): DemoRun {
    return this.immediate(() => {
      const run = this.get(runId);
      if (!run) {
        throw new DemoRepositoryError(
          "demo_run_not_found",
          "Demo run was not found",
          404,
        );
      }
      const transaction = run.transactions[key];
      if (!transaction) return run;
      const column = transactionColumns[key];
      this.database.sqlite
        .prepare(
          `UPDATE demo_runs SET ${column} = NULL, updated_at = ? WHERE id = ?`,
        )
        .run(nowIso(), runId);
      this.insertEvent(runId, eventType, {
        operation: key,
        transaction,
      });
      return this.get(runId)!;
    });
  }

  transactionSubmittedAt(
    runId: string,
    key: DemoTransactionKey,
    transaction: string,
  ): string | null {
    const event = [...this.listEvents(runId)]
      .reverse()
      .find(
        (candidate) =>
          candidate.payload.operation === key &&
          candidate.payload.transaction === transaction,
      );
    return event?.createdAt ?? null;
  }

  completeStep(
    runId: string,
    step: string,
    nextOperation: string | null,
    eventType: string,
    payload: Record<string, unknown> = {},
    patch: DemoRunPatch = {},
  ): DemoRun {
    return this.immediate(() => {
      const run = this.get(runId);
      if (!run) {
        throw new DemoRepositoryError(
          "demo_run_not_found",
          "Demo run was not found",
          404,
        );
      }
      const completedSteps = run.completedSteps.includes(step)
        ? run.completedSteps
        : [...run.completedSteps, step];
      const columns = [
        "completed_steps_json = ?",
        "current_operation = ?",
        "last_error = NULL",
        "updated_at = ?",
      ];
      const values: unknown[] = [
        JSON.stringify(completedSteps),
        nextOperation,
        nowIso(),
      ];
      const extraMapping: Record<keyof DemoRunPatch, string> = {
        state: "state",
        currentOperation: "current_operation",
        recoveryState: "recovery_state",
        jobId: "job_id",
        orderId: "order_id",
        chainStartBlock: "chain_start_block",
        completedAt: "completed_at",
        onChainVerified: "on_chain_verified",
        lastError: "last_error",
      };
      for (const [key, column] of Object.entries(extraMapping) as Array<
        [keyof DemoRunPatch, string]
      >) {
        if (
          key !== "currentOperation" &&
          key !== "lastError" &&
          Object.prototype.hasOwnProperty.call(patch, key)
        ) {
          columns.push(`${column} = ?`);
          values.push(
            key === "onChainVerified"
              ? patch[key]
                ? 1
                : 0
              : patch[key],
          );
        }
      }
      values.push(runId);
      this.database.sqlite
        .prepare(`UPDATE demo_runs SET ${columns.join(", ")} WHERE id = ?`)
        .run(...values);
      this.insertEvent(runId, eventType, payload);
      return this.get(runId)!;
    });
  }

  addEvent(
    runId: string,
    type: string,
    payload: Record<string, unknown> = {},
  ): DemoRunEvent {
    return this.immediate(() => this.insertEvent(runId, type, payload));
  }

  private insertEvent(
    runId: string,
    type: string,
    payload: Record<string, unknown>,
  ): DemoRunEvent {
    const createdAt = nowIso();
    const result = this.database.sqlite
      .prepare(
        `INSERT INTO demo_run_events (run_id, type, payload_json, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(runId, type, JSON.stringify(payload), createdAt);
    return {
      id: Number(result.lastInsertRowid),
      runId,
      type,
      payload,
      createdAt,
    };
  }
}
