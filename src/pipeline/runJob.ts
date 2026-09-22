import fs from "node:fs";
import path from "node:path";
import { config, SCENE_SECONDS } from "../config.ts";
import { enhanceText, planScenes, synthesizeVoice } from "../gemini.ts";
import { buildWavBuffer } from "../wav.ts";
import { generateSceneImage, ImageGenerationError } from "./imageGeneration.ts";
import { assembleFinalVideo, imageToKenBurnsClip, reencodeToFitSize } from "./assembleVideo.ts";
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

  await onProgress(`🎬 Sahnalar rejalashtirilmoqda (~${Math.round(voice.durationSeconds)}s audio uchun)...`);
  let scenePlan;
  try {
    scenePlan = await planScenes(correctedText, voice.durationSeconds, SCENE_SECONDS);
  } catch (err) {
    throw new JobUserFacingError(`Sahnalarni rejalashtirishda xatolik: ${(err as Error).message}`);
  }

  const totalScenes = scenePlan.prompts.length;
  await onProgress(`🖼️ ${totalScenes} ta sahna rasmi va videosi tayyorlanmoqda...`);

  const clipPaths: string[] = [];
  for (let i = 0; i < totalScenes; i++) {
    const prompt = scenePlan.prompts[i];
    const imagePath = path.join(jobDir, `scene-${String(i + 1).padStart(2, "0")}.jpg`);
    const clipPath = path.join(jobDir, `scene-${String(i + 1).padStart(2, "0")}.mp4`);

    try {
      await generateSceneImage(prompt, imagePath);
      await imageToKenBurnsClip(imagePath, clipPath, SCENE_SECONDS);
    } catch (err) {
      const detail = err instanceof ImageGenerationError ? err.message : (err as Error).message;
      throw new JobUserFacingError(`⚠️ ${i + 1}-sahnani tayyorlashda xatolik yuz berdi: ${detail}`);
    }

    clipPaths.push(clipPath);
    await onArtifact({
      kind: "scene",
      filePath: clipPath,
      caption: `🎬 Sahna ${i + 1}/${totalScenes}`,
      index: i,
      total: totalScenes,
    });
  }

  await onProgress("🎞️ Video va ovoz birlashtirilmoqda...");
  const finalVideoPath = path.join(jobDir, "final_video.mp4");
  try {
    await assembleFinalVideo({
      jobDir,
      clipPaths,
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
    caption: `✅ Tayyor! ${clipPaths.length} ta sahna, ${Math.round(voice.durationSeconds)}s.`,
  });

  return {
    finalVideoPath: deliverablePath,
    durationSeconds: voice.durationSeconds,
    sceneCount: clipPaths.length,
  };
}

/** Telegram bot uploads cap at 50MB. Re-encode down once before giving up (resolution stays 1080p — see assembleVideo.ts). */
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
