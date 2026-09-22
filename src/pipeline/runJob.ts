import fs from "node:fs";
import path from "node:path";
import { config, SCENE_SECONDS } from "../config.ts";
import { enhanceText, planScenes, synthesizeVoice } from "../gemini.ts";
import { buildWavBuffer } from "../wav.ts";
import { runFlowJob, FlowQuotaError, FlowAutomationError, FlowSessionExpiredError, type FlowSceneResult } from "./flowAutomation.ts";
import { assembleFinalVideo, reencodeToFitSize } from "./assembleVideo.ts";
import { TELEGRAM_UPLOAD_LIMIT_BYTES } from "../telegramApi.ts";

export interface StoryJob {
  id: string;
  userId: string;
  rawText: string;
  voiceName: string;
  style: string;
  speed: number;
}

export interface JobResult {
  finalVideoPath: string;
  durationSeconds: number;
  sceneCount: number;
}

export type ProgressCallback = (message: string) => void | Promise<void>;

export type JobArtifact =
  | { kind: "audio"; filePath: string; caption: string }
  | { kind: "scene"; filePath: string; caption: string; index: number; total: number }
  | { kind: "final"; filePath: string; caption: string };

export type ArtifactCallback = (artifact: JobArtifact) => void | Promise<void>;

/** Errors of this shape are safe to forward verbatim to the requesting user. */
export class JobUserFacingError extends Error {}

const MIN_TEXT_LENGTH = 10;

export async function runStoryJob(
  job: StoryJob,
  onProgress: ProgressCallback,
  onArtifact: ArtifactCallback = () => {}
): Promise<JobResult> {
  if (job.rawText.trim().length < MIN_TEXT_LENGTH) {
    throw new JobUserFacingError("Matn juda qisqa. Iltimos, to'liq hikoya matnini yuboring.");
  }

  const jobDir = path.join(config.dataDir, job.id);
  fs.mkdirSync(jobDir, { recursive: true });

  await onProgress("✍️ Imlo tekshirilmoqda...");
  let correctedText: string;
  try {
    correctedText = await enhanceText(job.rawText);
  } catch (err) {
    throw new JobUserFacingError(`Imlo tekshirishda xatolik yuz berdi: ${(err as Error).message}`);
  }

  await onProgress("🎙️ Ovoz sintez qilinmoqda...");
  let voice;
  try {
    voice = await synthesizeVoice(correctedText, job.voiceName, job.style, job.speed);
  } catch (err) {
    throw new JobUserFacingError(`Ovoz sintez qilishda xatolik yuz berdi: ${(err as Error).message}`);
  }

  const narrationWavPath = path.join(jobDir, "narration.wav");
  fs.writeFileSync(narrationWavPath, buildWavBuffer(voice.pcmBytes, voice.sampleRate, voice.channels, voice.bitDepth));

  await onArtifact({
    kind: "audio",
    filePath: narrationWavPath,
    caption: `🎙️ Ovoz tayyor (${Math.round(voice.durationSeconds)}s, ${job.voiceName})`,
  });

  await onProgress(
    `🎬 Sahnalar rejalashtirilmoqda (~${Math.round(voice.durationSeconds)}s audio uchun)...`
  );
  let scenePlan;
  try {
    scenePlan = await planScenes(correctedText, voice.durationSeconds, SCENE_SECONDS);
  } catch (err) {
    throw new JobUserFacingError(`Sahnalarni rejalashtirishda xatolik: ${(err as Error).message}`);
  }

  const totalScenes = scenePlan.prompts.length;
  await onProgress(
    `📹 ${totalScenes} ta video sahna Flow'da generatsiya qilinmoqda. Bu bir necha daqiqa davom etishi mumkin...`
  );
  let sceneResults;
  try {
    sceneResults = await runFlowJob({
      jobDir,
      prompts: scenePlan.prompts,
      onSceneReady: async (scene: FlowSceneResult) => {
        await onArtifact({
          kind: "scene",
          filePath: scene.filePath,
          caption: `🎬 Sahna ${scene.index + 1}/${totalScenes}`,
          index: scene.index,
          total: totalScenes,
        });
      },
    });
  } catch (err) {
    if (err instanceof FlowQuotaError) {
      throw new JobUserFacingError(
        `⚠️ Flow'da limit/kvota tugadi. Iltimos, birozdan so'ng qayta urinib ko'ring yoki Flow hisobingizni tekshiring.\n\nTafsilot: ${err.message}`
      );
    }
    if (err instanceof FlowSessionExpiredError) {
      throw new JobUserFacingError(
        `⚠️ Video generatsiya xizmatiga ulanishda muammo (sessiya tugagan bo'lishi mumkin). Admin bilan bog'laning.\n\nTafsilot: ${err.message}`
      );
    }
    if (err instanceof FlowAutomationError) {
      throw new JobUserFacingError(`⚠️ Video generatsiyasida texnik xatolik: ${err.message}`);
    }
    // Anything else (Playwright timeouts, browser crashes, etc.) — don't leak
    // a raw stack trace to the end user, but keep the original message for
    // the admin notification that wraps this at the call site.
    throw new JobUserFacingError(`⚠️ Video generatsiyasida kutilmagan texnik xatolik yuz berdi: ${(err as Error).message}`);
  }

  await onProgress("🎞️ Video va ovoz birlashtirilmoqda...");
  const finalVideoPath = path.join(jobDir, "final_video.mp4");
  try {
    await assembleFinalVideo({
      jobDir,
      clipPaths: sceneResults.map((s) => s.filePath),
      narrationWavPath,
      outputPath: finalVideoPath,
    });
  } catch (err) {
    throw new JobUserFacingError(`Video va ovozni birlashtirishda xatolik: ${(err as Error).message}`);
  }

  const deliverablePath = await ensureUnderUploadLimit(jobDir, finalVideoPath, onProgress);

  await onArtifact({
    kind: "final",
    filePath: deliverablePath,
    caption: `✅ Tayyor! ${sceneResults.length} ta sahna, ${Math.round(voice.durationSeconds)}s.`,
  });

  return {
    finalVideoPath: deliverablePath,
    durationSeconds: voice.durationSeconds,
    sceneCount: sceneResults.length,
  };
}

/** Telegram bot uploads cap at 50MB; a multi-minute 1080p video can exceed that. Re-encode down once before giving up. */
async function ensureUnderUploadLimit(jobDir: string, videoPath: string, onProgress: ProgressCallback): Promise<string> {
  const size = fs.statSync(videoPath).size;
  if (size <= TELEGRAM_UPLOAD_LIMIT_BYTES) return videoPath;

  await onProgress("📦 Video Telegram limitidan katta, siqilmoqda...");
  const compressedPath = path.join(jobDir, "final_video_compressed.mp4");
  try {
    await reencodeToFitSize(videoPath, compressedPath, 1500);
  } catch (err) {
    throw new JobUserFacingError(`Video Telegram uchun juda katta va uni siqib bo'lmadi: ${(err as Error).message}`);
  }

  const compressedSize = fs.statSync(compressedPath).size;
  if (compressedSize > TELEGRAM_UPLOAD_LIMIT_BYTES) {
    throw new JobUserFacingError(
      `Video siqilgandan keyin ham Telegram limitidan (50MB) katta (${(compressedSize / 1024 / 1024).toFixed(1)}MB). Qisqaroq hikoya yuborib ko'ring.`
    );
  }
  return compressedPath;
}
