import { StaleFence, type Db } from "./types.ts";

export type JobRow = {
  id: string;
  kind: string;
  payload: unknown;
  status: string;
  fencing_token: number | string;
  attempts: number;
};

/** Claim one due job. Safe for many workers: SKIP LOCKED + fencing token. */
export async function claimJob(
  db: Db,
  owner: string,
  now: Date,
  leaseMs = 30_000,
): Promise<JobRow | null> {
  const leaseUntil = new Date(now.getTime() + leaseMs).toISOString();
  const rows = await db.query<JobRow>(
    `UPDATE jobs SET
       status = 'leased',
       lease_owner = $1,
       lease_expires_at = $2,
       fencing_token = fencing_token + 1,
       attempts = attempts + 1
     WHERE id = (
       SELECT id FROM jobs
       WHERE status = 'pending' AND run_at <= $3
       ORDER BY run_at, id
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING id, kind, payload, status, fencing_token, attempts`,
    [owner, leaseUntil, now.toISOString()],
  );
  return rows[0] ?? null;
}

export async function completeJob(
  db: Db,
  jobId: string,
  fencingToken: number | string,
): Promise<void> {
  const rows = await db.query<{ id: string }>(
    `UPDATE jobs SET status = 'done', lease_owner = NULL, lease_expires_at = NULL
     WHERE id = $1 AND fencing_token = $2 AND status = 'leased'
     RETURNING id`,
    [jobId, fencingToken],
  );
  if (!rows[0]) throw new StaleFence();
}

export async function recoverExpiredLeases(db: Db, now: Date): Promise<number> {
  const jobs = await db.query<{ id: string }>(
    `UPDATE jobs SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL
     WHERE status = 'leased' AND lease_expires_at < $1
     RETURNING id`,
    [now.toISOString()],
  );
  await db.query(
    `UPDATE outbox SET state = 'unknown', last_error = 'lease expired during send',
            lease_owner = NULL
     WHERE state = 'sending' AND lease_expires_at < $1`,
    [now.toISOString()],
  );
  return jobs.length;
}

export async function failJob(
  db: Db,
  jobId: string,
  fencingToken: number | string,
  reason: string,
): Promise<void> {
  const rows = await db.query<{ id: string }>(
    `UPDATE jobs SET status = 'failed', last_error = $3, lease_owner = NULL, lease_expires_at = NULL
     WHERE id = $1 AND fencing_token = $2 AND status = 'leased'
     RETURNING id`,
    [jobId, fencingToken, reason],
  );
  if (!rows[0]) throw new StaleFence();
}

export async function enqueueJob(
  db: Db,
  kind: string,
  payload: unknown,
  runAt: Date = new Date(),
  tenantId: string | null = null,
): Promise<string> {
  const rows = await db.query<{ id: string }>(
    `INSERT INTO jobs (kind, payload, run_at, tenant_id) VALUES ($1, $2::jsonb, $3, $4) RETURNING id`,
    [kind, JSON.stringify(payload), runAt.toISOString(), tenantId],
  );
  return rows[0].id;
}
