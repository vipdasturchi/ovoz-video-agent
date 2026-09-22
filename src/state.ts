import fs from "node:fs";
import path from "node:path";
import { config } from "./config.ts";

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

export function loadState(): AgentState {
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return {
      lastUpdateId: parsed.lastUpdateId ?? 0,
      pendingByUser: parsed.pendingByUser ?? {},
      defaultsByUser: parsed.defaultsByUser ?? {},
      historyByUser: parsed.historyByUser ?? {},
      lastJobByUser: parsed.lastJobByUser ?? {},
    };
  } catch {
    return { lastUpdateId: 0, pendingByUser: {}, defaultsByUser: {}, historyByUser: {}, lastJobByUser: {} };
  }
}

export function saveState(state: AgentState): void {
  fs.mkdirSync(config.stateDir, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

export function pushHistory(state: AgentState, userId: string, entry: HistoryEntry): void {
  const list = state.historyByUser[userId] ?? [];
  list.unshift(entry);
  state.historyByUser[userId] = list.slice(0, MAX_HISTORY);
}

export function setJobStatus(state: AgentState, userId: string, status: LastJobStatus): void {
  state.lastJobByUser[userId] = status;
}
