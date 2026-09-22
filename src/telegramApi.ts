import fs from "node:fs";
import { config } from "./config.ts";

const API_BASE = `https://api.telegram.org/bot${config.telegramBotToken}`;

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

async function call<T>(method: string, body?: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${API_BASE}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json()) as { ok: boolean; result: T; description?: string };
  if (!data.ok) throw new Error(`Telegram API xatosi (${method}): ${data.description ?? res.status}`);
  return data.result;
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

export async function sendVideo(chatId: number | string, filePath: string, caption: string): Promise<void> {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("caption", caption);
  const buffer = fs.readFileSync(filePath);
  form.append("video", new Blob([buffer], { type: "video/mp4" }), "hikoya.mp4");

  const res = await fetch(`${API_BASE}/sendVideo`, { method: "POST", body: form });
  const data = (await res.json()) as { ok: boolean; description?: string };
  if (!data.ok) throw new Error(`Telegram sendVideo xatosi: ${data.description ?? res.status}`);
}
