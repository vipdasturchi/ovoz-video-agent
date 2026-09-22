import fs from "node:fs";
import path from "node:path";
import { config, SCENE_SECONDS } from "../config.ts";
import { enhanceText, planScenes, synthesizeVoice } from "../gemini.ts";
import { buildWavBuffer } from "../wav.ts";
import { runFlowJob, FlowQuotaError, FlowAutomationError, type FlowSceneResult } from "./flowAutomation.ts";
import { assembleFinalVideo } from "./assembleVideo.ts";

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

export async function runStoryJob(
  job: StoryJob,
  onProgress: ProgressCallback,
  onArtifact: ArtifactCallback = () => {}
): Promise<JobResult> {
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
    if (err instanceof FlowAutomationError) {
      throw new JobUserFacingError(`⚠️ Video generatsiyasida texnik xatolik: ${err.message}`);
    }
    throw err;
  }

  await onProgress("🎞️ Video va ovoz birlashtirilmoqda...");
  const finalVideoPath = path.join(jobDir, "final_video.mp4");
  await assembleFinalVideo({
    jobDir,
    clipPaths: sceneResults.map((s) => s.filePath),
    narrationWavPath,
    outputPath: finalVideoPath,
  });

  await onArtifact({
    kind: "final",
    filePath: finalVideoPath,
    caption: `✅ Tayyor! ${sceneResults.length} ta sahna, ${Math.round(voice.durationSeconds)}s.`,
  });

  return {
    finalVideoPath,
    durationSeconds: voice.durationSeconds,
    sceneCount: sceneResults.length,
  };
}
