import { execFileSync } from "node:child_process";
import { saveState, type AgentState } from "./state.ts";

/**
 * A single story job can legitimately run for a while (many scenes, each
 * needing an image generation call + ffmpeg encode). If the whole process gets
 * killed mid-job — CI timeout, runner OOM, a crash — anything that only
 * lives in memory (or only in the workflow's end-of-run "commit state" step)
 * is lost, and Telegram's lastUpdateId would never advance, which is exactly
 * the "bot re-sends the same old messages forever" bug this whole file
 * exists to prevent. So we persist+commit+push state.json to git ourselves,
 * from inside the script, right after anything durability-relevant changes —
 * not just once at the very end.
 *
 * Best-effort and never throws: a failed checkpoint should not abort the
 * job. Worst case, the end-of-workflow YAML "Commit updated state" step
 * (kept as a safety net, and run with `if: always()`) picks up the slack.
 */
function git(args: string[]): { ok: boolean; output: string } {
  try {
    const output = execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, output };
  } catch (err) {
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
    return { ok: false, output: String(e.stderr ?? e.stdout ?? e.message ?? err) };
  }
}

let gitIdentityConfigured = false;
function ensureGitIdentity() {
  if (gitIdentityConfigured) return;
  git(["config", "user.name", "ovoz-video-agent"]);
  git(["config", "user.email", "actions@users.noreply.github.com"]);
  gitIdentityConfigured = true;
}

export function checkpoint(state: AgentState, label: string): void {
  try {
    saveState(state);
  } catch (err) {
    console.error("[checkpoint] state.json ga yozib bo'lmadi:", err);
    return;
  }

  // Only attempt git operations inside CI (a real git repo with a remote configured);
  // local/manual runs (e.g. testing) shouldn't try to commit anything.
  if (!process.env.GITHUB_ACTIONS) return;

  ensureGitIdentity();

  const add = git(["add", "state/state.json"]);
  if (!add.ok) {
    console.error("[checkpoint] git add muvaffaqiyatsiz:", add.output);
    return;
  }

  const diff = git(["diff", "--cached", "--quiet"]);
  if (diff.ok) return; // nothing changed since the last checkpoint

  const commit = git(["commit", "-m", `chore: checkpoint (${label}) [skip ci]`]);
  if (!commit.ok) {
    console.error("[checkpoint] git commit muvaffaqiyatsiz:", commit.output);
    return;
  }

  // The remote may have moved (e.g. an earlier checkpoint in a run that
  // overlapped due to a race) — rebase onto it before pushing, best-effort.
  git(["pull", "--rebase", "--autostash"]);

  const push = git(["push"]);
  if (!push.ok) {
    console.error("[checkpoint] git push muvaffaqiyatsiz (keyingi checkpoint yoki workflow yakunidagi qadam qayta urinadi):", push.output);
  }
}
