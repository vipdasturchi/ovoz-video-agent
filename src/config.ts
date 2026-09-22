import "dotenv/config";
import path from "node:path";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Muhit o'zgaruvchisi topilmadi: ${name}`);
  return value;
}

export const config = {
  geminiApiKey: required("GEMINI_API_KEY"),

  telegramBotToken: required("TELEGRAM_BOT_TOKEN"),
  telegramAllowedUserIds: (process.env.TELEGRAM_ALLOWED_USER_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  telegramAdminChatId: process.env.TELEGRAM_ADMIN_CHAT_ID?.trim() || null,

  flowStorageState: required("FLOW_STORAGE_STATE"), // base64-encoded JSON, from a GitHub secret
  flowProjectUrl: required("FLOW_PROJECT_URL"),

  dataDir: path.resolve(process.env.DATA_DIR ?? "./data/jobs"),
  stateDir: path.resolve(process.env.STATE_DIR ?? "./state"),
};

export const VOICE_MAP: Record<string, string> = {
  Dilnoza: "Zephyr",
  Madina: "Kore",
  Sardor: "Puck",
  Jasur: "Charon",
  Farrux: "Fenrir",
};

export const VOICES = ["Dilnoza", "Madina", "Sardor", "Jasur", "Farrux"] as const;
export type VoiceName = (typeof VOICES)[number];

export const STYLES = [
  { id: "natural", label: "Tabiiy / Oddiy" },
  { id: "cheerful", label: "Xushchaqchaq" },
  { id: "calm", label: "Sokin va muloyim" },
  { id: "serious", label: "Jiddiy / Rasmiy" },
  { id: "dramatic", label: "Hayajonli / Dramatik" },
] as const;

export const STYLE_INSTRUCTIONS: Record<string, string> = {
  natural: "tabiiy va oddiy ohangda",
  cheerful: "xushchaqchaq va quvnoq ohangda",
  calm: "sokin va muloyim ohangda",
  serious: "jiddiy va rasmiy ohangda",
  dramatic: "hayajonli va dramatik ohangda",
};

export const MAX_TEXT_LENGTH = 4000;
export const SCENE_SECONDS = 8;
export const SAMPLE_RATE = 24000;
