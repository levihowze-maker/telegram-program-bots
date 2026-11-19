const SENSITIVE_KEY = /token|secret|password|authorization|database_url|cookie|csrf/i;
const TOKEN_SHAPE = /\d{6,}:[A-Za-z0-9_-]{20,}/g;

export function redact(value: unknown): unknown {
  if (typeof value === "string") return value.replace(TOKEN_SHAPE, "[redacted-token]");
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY.test(key) ? "[redacted]" : redact(inner);
    }
    return out;
  }
  return value;
}

function logLine(level: "info" | "error", msg: string, fields: Record<string, unknown> = {}): string {
  return JSON.stringify({
    level,
    msg: redact(msg),
    ...((redact(fields) as Record<string, unknown>) ?? {}),
    t: new Date().toISOString(),
  });
}

export function logInfo(msg: string, fields: Record<string, unknown> = {}): void {
  console.log(logLine("info", msg, fields));
}

export function logError(msg: string, fields: Record<string, unknown> = {}): void {
  console.error(logLine("error", msg, fields));
}
