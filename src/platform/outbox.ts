import type { Db } from "./types.ts";
import { VersionConflict } from "./types.ts";
import { telegramSendMessage, type FetchLike, type SendOutcome } from "./telegram.ts";
import { privateTestMode } from "./private-test-mode.ts";

export function globalSendEnabled(): boolean {
  return process.env.SEND_ENABLED === "true";
}

export async function createDraft(
  db: Db,
  input: {
    botId: string;
    chatId: string;
    body: string;
    idempotencyKey: string;
    category?: string;
    campaignId?: string | null;
    recipientKey?: string | null;
  },
): Promise<string> {
  const rows = await db.query<{ id: string }>(
    `INSERT INTO outbox (bot_id, chat_id, idempotency_key, state, draft_body, category, campaign_id, recipient_key)
     VALUES ($1, $2, $3, 'draft', $4, $5, $6, $7)
     RETURNING id`,
    [
      input.botId,
      input.chatId,
      input.idempotencyKey,
      input.body,
      input.category ?? null,
      input.campaignId ?? null,
      input.recipientKey ?? null,
    ],
  );
  return rows[0].id;
}

export async function editDraft(
  db: Db,
  id: string,
  body: string,
  expectedVersion: number,
): Promise<number> {
  const rows = await db.query<{ version: number }>(
    `UPDATE outbox SET draft_body = $1, version = version + 1
     WHERE id = $2 AND version = $3 AND state = 'draft'
     RETURNING version`,
    [body, id, expectedVersion],
  );
  if (!rows[0]) throw new VersionConflict("draft edit lost a version race");
  return Number(rows[0].version);
}

export async function approveOutbox(db: Db, id: string, expectedVersion: number): Promise<void> {
  const rows = await db.query<{ id: string }>(
    `UPDATE outbox SET
       state = 'approved',
       version = version + 1,
       body_snapshot = jsonb_build_object('text', draft_body, 'version', version)
     WHERE id = $1 AND version = $2 AND state = 'draft'
     RETURNING id`,
    [id, expectedVersion],
  );
  if (!rows[0]) throw new VersionConflict("approve lost a version race");
  await queueIfSendingOff(db, id);
}

async function queueIfSendingOff(db: Db, id: string): Promise<void> {
  const rows = await db.query<{ send_enabled: boolean }>(
    `SELECT b.send_enabled FROM outbox o JOIN bots b ON b.id = o.bot_id WHERE o.id = $1`,
    [id],
  );
  if (!globalSendEnabled() || !rows[0]?.send_enabled) {
    await db.query(
      `UPDATE outbox SET state = 'queued' WHERE id = $1 AND state = 'approved'`,
      [id],
    );
  } else {
    await db.query(
      `UPDATE outbox SET state = 'queued' WHERE id = $1 AND state = 'approved'`,
      [id],
    );
  }
}

export type ClaimedOutbox = {
  id: string;
  bot_id: string;
  chat_id: string;
  body_snapshot: { text?: string } | null;
  fencing_token: number | string;
  category: string | null;
  campaign_id: string | null;
};

export async function claimOutboxForSend(
  db: Db,
  owner: string,
  now: Date,
  leaseMs = 30_000,
): Promise<ClaimedOutbox | null> {
  if (!globalSendEnabled()) return null;
  const leaseUntil = new Date(now.getTime() + leaseMs).toISOString();
  const privateOnly = privateTestMode();
  const rows = await db.query<ClaimedOutbox>(
    `UPDATE outbox SET
       state = 'sending',
       lease_owner = $1,
       lease_expires_at = $2,
       fencing_token = fencing_token + 1
     WHERE id = (
       SELECT o.id FROM outbox o
       JOIN bots b ON b.id = o.bot_id
       WHERE o.state = 'queued'
         AND b.send_enabled = true
         AND (o.not_before IS NULL OR o.not_before <= $3)
         AND ($4::boolean = false OR (o.campaign_id IS NULL AND (o.category IS NULL OR o.category = 'reply')))
         AND NOT EXISTS (
           SELECT 1 FROM send_pacing p
           WHERE p.bot_id = o.bot_id
             AND p.chat_id IN (o.chat_id, '*')
             AND p.not_before > $3
         )
       ORDER BY o.created_at, o.id
       FOR UPDATE OF o SKIP LOCKED
       LIMIT 1
     )
     RETURNING id, bot_id, chat_id, body_snapshot, fencing_token, category, campaign_id`,
    [owner, leaseUntil, now.toISOString(), privateOnly],
  );
  return rows[0] ?? null;
}

async function pacingUntil(db: Db, botId: string, chatId: string, until: Date): Promise<void> {
  await db.query(
    `INSERT INTO send_pacing (bot_id, chat_id, not_before)
     VALUES ($1, $2, $3)
     ON CONFLICT (bot_id, chat_id)
     DO UPDATE SET not_before = GREATEST(send_pacing.not_before, EXCLUDED.not_before)`,
    [botId, chatId, until.toISOString()],
  );
}

export async function applySendOutcome(
  db: Db,
  row: ClaimedOutbox,
  outcome: SendOutcome,
  now: Date,
): Promise<void> {
  if (outcome.kind === "sent") {
    await db.query(
      `UPDATE outbox SET state = 'sent', telegram_message_id = $2, lease_owner = NULL
       WHERE id = $1 AND state = 'sending' AND fencing_token = $3`,
      [row.id, outcome.messageId, row.fencing_token],
    );
    return;
  }
  if (outcome.kind === "retry") {
    const until = new Date(now.getTime() + outcome.retryAfterSec * 1000);
    await pacingUntil(db, row.bot_id, row.chat_id, until);
    await pacingUntil(db, row.bot_id, "*", until);
    await db.query(
      `UPDATE outbox SET state = 'queued', not_before = $2, lease_owner = NULL,
              last_error = $3
       WHERE id = $1 AND state = 'sending' AND fencing_token = $4`,
      [row.id, until.toISOString(), `429 retry_after=${outcome.retryAfterSec}`, row.fencing_token],
    );
    return;
  }
  if (outcome.kind === "forbidden") {
    const telegramUserId = Number(row.chat_id);
    if (Number.isFinite(telegramUserId)) {
      await db.query(
        `UPDATE subscribers SET blocked_at = $2, block_reason = $3
         WHERE bot_id = $1 AND telegram_user_id = $4`,
        [row.bot_id, now.toISOString(), outcome.description, telegramUserId],
      );
    }
    await db.query(
      `UPDATE outbox SET state = 'failed', last_error = $2, lease_owner = NULL
       WHERE id = $1 AND state = 'sending' AND fencing_token = $3`,
      [row.id, outcome.description, row.fencing_token],
    );
    return;
  }
  if (outcome.kind === "unknown") {
    await db.query(
      `UPDATE outbox SET state = 'unknown', last_error = $2, lease_owner = NULL
       WHERE id = $1 AND state = 'sending' AND fencing_token = $3`,
      [row.id, outcome.reason, row.fencing_token],
    );
    return;
  }
  await db.query(
    `UPDATE outbox SET state = 'failed', last_error = $2, lease_owner = NULL
     WHERE id = $1 AND state = 'sending' AND fencing_token = $3`,
    [row.id, outcome.description, row.fencing_token],
  );
}

export async function reconcileOutbox(
  db: Db,
  id: string,
  action: "mark_sent" | "cancel" | "resend_new",
  actorNote: string,
): Promise<{ id: string }> {
  if (action === "mark_sent") {
    const rows = await db.query<{ id: string }>(
      `UPDATE outbox SET state = 'sent', last_error = $2 WHERE id = $1 AND state = 'unknown' RETURNING id`,
      [id, actorNote],
    );
    if (!rows[0]) throw new Error("only unknown rows can be marked sent");
    return rows[0];
  }
  if (action === "cancel") {
    const rows = await db.query<{ id: string }>(
      `UPDATE outbox SET state = 'cancelled', last_error = $2
       WHERE id = $1 AND state IN ('unknown', 'queued', 'draft', 'approved')
       RETURNING id`,
      [id, actorNote],
    );
    if (!rows[0]) throw new Error("cannot cancel this outbox row");
    return rows[0];
  }
  const existing = await db.query<{
    bot_id: string;
    chat_id: string;
    body_snapshot: { text?: string } | null;
    category: string | null;
  }>("SELECT bot_id, chat_id, body_snapshot, category FROM outbox WHERE id = $1 AND state = 'unknown'", [
    id,
  ]);
  if (!existing[0]) throw new Error("resend requires an unknown row");
  await db.query(`UPDATE outbox SET state = 'cancelled', last_error = $2 WHERE id = $1`, [
    id,
    actorNote,
  ]);
  const created = await createDraft(db, {
    botId: existing[0].bot_id,
    chatId: existing[0].chat_id,
    body: existing[0].body_snapshot?.text ?? "",
    idempotencyKey: `${id}:resend:${actorNote}`,
    category: existing[0].category ?? undefined,
  });
  await approveOutbox(db, created, 1);
  return { id: created };
}

export async function pumpOutbox(opts: {
  db: Db;
  owner: string;
  now: Date;
  fetchImpl: FetchLike;
  tokenForBot: (botId: string) => string | undefined;
  apiBase?: string;
}): Promise<SendOutcome | null> {
  const row = await claimOutboxForSend(opts.db, opts.owner, opts.now);
  if (!row) return null;
  if (privateTestMode() && (row.campaign_id || (row.category && row.category !== "reply"))) {
    await opts.db.query(
      `UPDATE outbox SET state = 'queued', lease_owner = NULL WHERE id = $1 AND state = 'sending' AND fencing_token = $2`,
      [row.id, row.fencing_token],
    );
    return null;
  }
  const token = opts.tokenForBot(row.bot_id);
  if (!token && process.env.DRY_RUN !== "1") {
    await applySendOutcome(opts.db, row, { kind: "unknown", reason: "bot token missing" }, opts.now);
    return { kind: "unknown", reason: "bot token missing" };
  }
  const outcome = await telegramSendMessage({
    fetchImpl: opts.fetchImpl,
    token: token ?? "",
    chatId: row.chat_id,
    text: row.body_snapshot?.text ?? "",
    apiBase: opts.apiBase,
  });
  await applySendOutcome(opts.db, row, outcome, opts.now);
  return outcome;
}
