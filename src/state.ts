import fs from "node:fs";
import path from "node:path";
import { config } from "./config.ts";
import { encryptField, decryptField } from "./crypto.ts";

export interface PendingSelection {
  text: string;
  voiceName?: string;
  style?: string;
  awaitingConfirm?: boolean;
}

export interface UserDefaults {
  voiceName?: string;
  style?: string;
}

export interface HistoryEntry {
  id: string;
  snippet: string;
  voiceName: string;
  style: string;
  durationSeconds: number;
  sceneCount: number;
  completedAt: number;
}

export interface LastJobStatus {
  id: string;
  stage: string;
  updatedAt: number;
  done: boolean;
  error?: string;
}

export interface AgentState {
  lastUpdateId: number;
  pendingByUser: Record<string, PendingSelection>;
  defaultsByUser: Record<string, UserDefaults>;
  historyByUser: Record<string, HistoryEntry[]>;
  lastJobByUser: Record<string, LastJobStatus>;
}

const STATE_FILE = path.join(config.stateDir, "state.json");
const MAX_HISTORY = 5;

function emptyState(): AgentState {
  return { lastUpdateId: 0, pendingByUser: {}, defaultsByUser: {}, historyByUser: {}, lastJobByUser: {} };
}

export function loadState(): AgentState {
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    const state: AgentState = {
      lastUpdateId: typeof parsed.lastUpdateId === "number" ? parsed.lastUpdateId : 0,
      pendingByUser: parsed.pendingByUser ?? {},
      defaultsByUser: parsed.defaultsByUser ?? {},
      historyByUser: parsed.historyByUser ?? {},
      lastJobByUser: parsed.lastJobByUser ?? {},
    };

    for (const uid of Object.keys(state.pendingByUser)) {
      const p = state.pendingByUser[uid];
      if (typeof p?.text === "string") p.text = decryptField(p.text);
    }
    for (const uid of Object.keys(state.historyByUser)) {
      for (const entry of state.historyByUser[uid] ?? []) {
        if (typeof entry?.snippet === "string") entry.snippet = decryptField(entry.snippet);
      }
    }

    return state;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("[state] state.json o'qishda xatolik, bo'sh holatdan boshlanmoqda:", err);
    }
    return emptyState();
  }
}

export function saveState(state: AgentState): void {
  fs.mkdirSync(config.stateDir, { recursive: true });

  // Deep-clone + encrypt sensitive fields only in the on-disk copy, so the
  // in-memory `state` object callers hold onto keeps working with plaintext.
  const toWrite: AgentState = JSON.parse(JSON.stringify(state));
  for (const uid of Object.keys(toWrite.pendingByUser)) {
    const p = toWrite.pendingByUser[uid];
    if (typeof p?.text === "string") p.text = encryptField(p.text);
  }
  for (const uid of Object.keys(toWrite.historyByUser)) {
    for (const entry of toWrite.historyByUser[uid] ?? []) {
      if (typeof entry?.snippet === "string") entry.snippet = encryptField(entry.snippet);
    }
  }

  const tmpPath = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(toWrite, null, 2));
  fs.renameSync(tmpPath, STATE_FILE); // atomic swap: never leaves a half-written state.json behind
}

export function pushHistory(state: AgentState, userId: string, entry: HistoryEntry): void {
  const list = state.historyByUser[userId] ?? [];
  list.unshift(entry);
  state.historyByUser[userId] = list.slice(0, MAX_HISTORY);
}

export function setJobStatus(state: AgentState, userId: string, status: LastJobStatus): void {
  state.lastJobByUser[userId] = status;
}
