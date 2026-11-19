import { z } from "zod";

const telegramBody = z.object({
  ok: z.boolean(),
  description: z.string().optional(),
  error_code: z.number().optional(),
  parameters: z.object({ retry_after: z.number().optional() }).optional(),
  result: z.object({ message_id: z.number() }).optional(),
});

export type SendOutcome =
  | { kind: "sent"; messageId: number }
  | { kind: "retry"; retryAfterSec: number }
  | { kind: "forbidden"; description: string }
  | { kind: "rejected"; description: string }
  | { kind: "unknown"; reason: string };

export type FetchLike = (url: string, init: RequestInit) => Promise<{
  status: number;
  text: () => Promise<string>;
}>;

/**
 * Classify a Telegram sendMessage HTTP result.
 * 429 honours the full retry_after. 5xx and network failures are unknown
 * (ambiguous acceptance) and must not be retried automatically.
 * 403 is a definitive stop; the description is kept verbatim.
 */
export function classifyTelegramResponse(status: number, raw: string): SendOutcome {
  let parsed: z.infer<typeof telegramBody> | null = null;
  try {
    parsed = telegramBody.parse(JSON.parse(raw));
  } catch {
    if (status >= 500 || status === 0) return { kind: "unknown", reason: "unparseable upstream body" };
    return { kind: "unknown", reason: "response schema mismatch" };
  }
  if (status === 429 || parsed.error_code === 429) {
    const retry = parsed.parameters?.retry_after;
    if (typeof retry !== "number" || retry < 0) {
      return { kind: "unknown", reason: "429 without retry_after" };
    }
    return { kind: "retry", retryAfterSec: retry };
  }
  if (status === 403 || parsed.error_code === 403) {
    return { kind: "forbidden", description: parsed.description ?? "403" };
  }
  if (status >= 500) return { kind: "unknown", reason: `http ${status}` };
  if (!parsed.ok) {
    return { kind: "rejected", description: parsed.description ?? `http ${status}` };
  }
  if (!parsed.result) return { kind: "unknown", reason: "ok without result" };
  return { kind: "sent", messageId: parsed.result.message_id };
}

export function telegramApiForbiddenInDryRun(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.DRY_RUN === "1";
}

export function telegramApiBase(
  env: Record<string, string | undefined> = process.env,
): string {
  const raw = env.TELEGRAM_API_BASE?.trim();
  if (raw) return raw.replace(/\/$/, "");
  return "https://api.telegram.org";
}

/** Build https://<api>/bot<token>/<method> without treating a colon in the token as a URL scheme. */
export function telegramBotMethodUrl(apiBase: string, token: string, method: string): URL {
  const base = apiBase.endsWith("/") ? apiBase : `${apiBase}/`;
  return new URL(`/bot${token}/${method}`, base);
}

export async function telegramSendMessage(opts: {
  fetchImpl: FetchLike;
  token: string;
  chatId: string;
  text: string;
  apiBase?: string;
}): Promise<SendOutcome> {
  if (telegramApiForbiddenInDryRun()) {
    return { kind: "sent", messageId: 0 };
  }
  let response: { status: number; text: () => Promise<string> };
  try {
    const apiBase = opts.apiBase ?? telegramApiBase();
    response = await opts.fetchImpl(telegramBotMethodUrl(apiBase, opts.token, "sendMessage").toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: opts.chatId, text: opts.text }),
    });
  } catch (err) {
    return { kind: "unknown", reason: err instanceof Error ? err.name : "network" };
  }
  let raw = "";
  try {
    raw = await response.text();
  } catch {
    return { kind: "unknown", reason: "body read failed" };
  }
  return classifyTelegramResponse(response.status, raw);
}
