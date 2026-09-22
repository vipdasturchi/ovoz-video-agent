import fs from "node:fs";
import { config } from "./config.ts";
import { withRetry } from "./retry.ts";

const API_BASE = `https://api.telegram.org/bot${config.telegramBotToken}`;

// Telegram's Bot API hard-rejects uploads above this size (50 MB) for a
// direct multipart upload. Checking before we send avoids a confusing
// generic HTTP error and lets callers react (re-encode, warn the user).
export const TELEGRAM_UPLOAD_LIMIT_BYTES = 50 * 1024 * 1024;

export class TelegramFileTooLargeError extends Error {
  constructor(public filePath: string, public sizeBytes: number) {
    super(`Fayl juda katta (${(sizeBytes / 1024 / 1024).toFixed(1)} MB), Telegram limiti 50 MB: ${filePath}`);
  }
}

export interface TgUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number };
    from?: { id: number };
    text?: string;
  };
  callback_query?: {
    id: string;
    from: { id: number };
    message?: { chat: { id: number } };
    data?: string;
  };
}

function withTimeout(ms: number): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, cancel: () => clearTimeout(timer) };
}

class NonRetryableTelegramError extends Error {}

async function call<T>(method: string, body?: Record<string, unknown>, timeoutMs = 30000): Promise<T> {
  return withRetry(
    async () => {
      const { signal, cancel } = withTimeout(timeoutMs);
      try {
        const res = await fetch(`${API_BASE}/${method}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: body ? JSON.stringify(body) : undefined,
          signal,
        });
        const data = (await res.json()) as { ok: boolean; result: T; description?: string; error_code?: number };
        if (!data.ok) {
          // 4xx errors (bad request, blocked by user, etc.) won't succeed on retry — fail fast.
          if (data.error_code && data.error_code >= 400 && data.error_code < 500) {
            throw new NonRetryableTelegramError(`Telegram API xatosi (${method}): ${data.description ?? res.status}`);
          }
          throw new Error(`Telegram API xatosi (${method}): ${data.description ?? res.status}`);
        }
        return data.result;
      } finally {
        cancel();
      }
    },
    { attempts: 3, baseDelayMs: 1000, label: `Telegram ${method}`, isRetryable: (err) => !(err instanceof NonRetryableTelegramError) }
  );
}

export async function getUpdates(offset: number): Promise<TgUpdate[]> {
  return call<TgUpdate[]>("getUpdates", { offset, timeout: 0, limit: 50 });
}

export async function sendMessage(
  chatId: number | string,
  text: string,
  buttons?: { text: string; callback_data: string }[][]
): Promise<void> {
  const body: Record<string, unknown> = { chat_id: chatId, text };
  if (buttons) body.reply_markup = { inline_keyboard: buttons };
  await call("sendMessage", body);
}

export async function answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
  await call("answerCallbackQuery", { callback_query_id: callbackQueryId, text });
}

function assertUploadable(filePath: string): number {
  const { size } = fs.statSync(filePath);
  if (size > TELEGRAM_UPLOAD_LIMIT_BYTES) throw new TelegramFileTooLargeError(filePath, size);
  if (size === 0) throw new Error(`Fayl bo'sh (0 bayt), yuborib bo'lmaydi: ${filePath}`);
  return size;
}

async function uploadFile(
  method: "sendVideo" | "sendAudio",
  fieldName: "video" | "audio",
  mimeType: string,
  chatId: number | string,
  filePath: string,
  caption: string,
  fileName: string
): Promise<void> {
  assertUploadable(filePath);

  await withRetry(
    async () => {
      const { signal, cancel } = withTimeout(5 * 60 * 1000); // large uploads over CI's network can be slow
      try {
        const form = new FormData();
        form.append("chat_id", String(chatId));
        form.append("caption", caption);
        const buffer = fs.readFileSync(filePath);
        form.append(fieldName, new Blob([buffer], { type: mimeType }), fileName);

        const res = await fetch(`${API_BASE}/${method}`, { method: "POST", body: form, signal });
        const data = (await res.json()) as { ok: boolean; description?: string; error_code?: number };
        if (!data.ok) {
          if (data.error_code && data.error_code >= 400 && data.error_code < 500) {
            throw new NonRetryableTelegramError(`Telegram ${method} xatosi: ${data.description ?? res.status}`);
          }
          throw new Error(`Telegram ${method} xatosi: ${data.description ?? res.status}`);
        }
      } finally {
        cancel();
      }
    },
    { attempts: 2, baseDelayMs: 2000, label: `Telegram ${method}`, isRetryable: (err) => !(err instanceof NonRetryableTelegramError) }
  );
}

export async function sendVideo(
  chatId: number | string,
  filePath: string,
  caption: string,
  fileName = "video.mp4"
): Promise<void> {
  await uploadFile("sendVideo", "video", "video/mp4", chatId, filePath, caption, fileName);
}

export async function sendAudio(
  chatId: number | string,
  filePath: string,
  caption: string,
  fileName = "audio.wav"
): Promise<void> {
  await uploadFile("sendAudio", "audio", "audio/wav", chatId, filePath, caption, fileName);
}
