export type Queryable = {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
};

export type Db = Queryable & {
  exec(sql: string): Promise<void>;
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
};

export type StaffRole =
  | "owner"
  | "admin"
  | "editor"
  | "event_staff"
  | "creator"
  | "teacher"
  | "safeguarding_lead";

export type StaffUser = {
  id: string;
  email: string;
  role: StaffRole;
  disabled_at: string | null;
};

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class VersionConflict extends Error {
  constructor(message = "version conflict") {
    super(message);
    this.name = "VersionConflict";
  }
}

export class StaleFence extends Error {
  constructor() {
    super("stale fencing token");
    this.name = "StaleFence";
  }
}

export class PaymentDisabled extends Error {
  constructor() {
    super("Telegram Stars payments are disabled pending policy review");
    this.name = "PaymentDisabled";
  }
}
