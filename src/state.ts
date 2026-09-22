import fs from "node:fs";
import path from "node:path";
import { config } from "./config.ts";

export interface PendingSelection {
  text: string;
  voiceName?: string;
  style?: string;
}

export interface AgentState {
  lastUpdateId: number;
  pendingByUser: Record<string, PendingSelection>;
}

const STATE_FILE = path.join(config.stateDir, "state.json");

export function loadState(): AgentState {
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return {
      lastUpdateId: parsed.lastUpdateId ?? 0,
      pendingByUser: parsed.pendingByUser ?? {},
    };
  } catch {
    return { lastUpdateId: 0, pendingByUser: {} };
  }
}

export function saveState(state: AgentState): void {
  fs.mkdirSync(config.stateDir, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}
