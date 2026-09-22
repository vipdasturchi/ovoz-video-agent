import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";

function run(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) {
      reject(new Error("ffmpeg-static binarysi topilmadi (platforma qo'llab-quvvatlanmaydi)."));
      return;
    }
    const proc = spawn(ffmpegPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    proc.on("error", (err) => reject(new Error(`ffmpeg ishga tushmadi: ${err.message}`)));
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg xato bilan tugadi (code ${code}):\n${stderr.slice(-2000)}`));
    });
  });
}

const OUTPUT_WIDTH = 1920;
const OUTPUT_HEIGHT = 1080;
const FPS = 25;

/**
 * Turns a single still image into an N-second 1080p video clip with a slow
 * center zoom ("Ken Burns effect" — the same technique documentaries use
 * over photographs). This is how motion is added to AI-generated still
 * images without needing a (paid) real video-generation model.
 */
export async function imageToKenBurnsClip(imagePath: string, outputPath: string, durationSeconds: number): Promise<void> {
  if (!fs.existsSync(imagePath)) throw new Error(`Rasm fayli topilmadi: ${imagePath}`);

  const totalFrames = Math.max(1, Math.round(durationSeconds * FPS));
  // Upscale+crop to a large fixed canvas first (source images can be any
  // resolution/aspect ratio) so zoompan has headroom to zoom into without
  // ever upscaling blurrily beyond what the crop already provides.
  const vf = [
    "scale=3840:2160:force_original_aspect_ratio=increase",
    "crop=3840:2160",
    `zoompan=z='min(zoom+0.0008\\,1.3)':d=${totalFrames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${OUTPUT_WIDTH}x${OUTPUT_HEIGHT}:fps=${FPS}`,
    "format=yuv420p",
  ].join(",");

  await run([
    "-y",
    "-loop",
    "1",
    "-i",
    imagePath,
    "-t",
    String(durationSeconds),
    "-vf",
    vf,
    "-c:v",
    "libx264",
    "-crf",
    "18",
    "-preset",
    "medium",
    "-pix_fmt",
    "yuv420p",
    outputPath,
  ]);

  if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
    throw new Error("Sahna videosi (Ken Burns effekti) yaratilmadi yoki bo'sh chiqdi.");
  }
}

export async function assembleFinalVideo(params: {
  jobDir: string;
  clipPaths: string[];
  narrationWavPath: string;
  outputPath: string;
}): Promise<void> {
  const { jobDir, clipPaths, narrationWavPath, outputPath } = params;

  if (clipPaths.length === 0) throw new Error("Birlashtirish uchun hech qanday video sahna yo'q.");
  for (const p of clipPaths) {
    if (!fs.existsSync(p)) throw new Error(`Sahna fayli topilmadi: ${p}`);
  }
  if (!fs.existsSync(narrationWavPath)) throw new Error(`Ovoz fayli topilmadi: ${narrationWavPath}`);

  const concatListPath = path.join(jobDir, "concat_list.txt");
  const listContent = clipPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n");
  fs.writeFileSync(concatListPath, listContent);

  const concatenatedPath = path.join(jobDir, "concatenated.mp4");
  await run(["-y", "-f", "concat", "-safe", "0", "-i", concatListPath, "-c", "copy", concatenatedPath]);

  // Scene count is rounded UP from the narration length (ceil), so the
  // concatenated video is almost always a few seconds longer than the
  // audio. `-shortest` trims the output to match the narration exactly
  // instead of leaving a silent tail.
  await run([
    "-y",
    "-i",
    concatenatedPath,
    "-i",
    narrationWavPath,
    "-map",
    "0:v",
    "-map",
    "1:a",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-shortest",
    outputPath,
  ]);

  if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
    throw new Error("Yakuniy video yaratilmadi yoki bo'sh chiqdi.");
  }
}

/**
 * Re-encodes at a lower bitrate to shrink the file, used when the assembled
 * video is too large for Telegram's 50MB upload limit. Resolution is kept
 * at 1080p (the user explicitly wants 1080p delivery) — slow-pan content
 * over mostly-static images compresses very well even at a low bitrate, so
 * this should rarely need to trade resolution away at all.
 */
export async function reencodeToFitSize(inputPath: string, outputPath: string, targetBitrateKbps: number): Promise<void> {
  await run([
    "-y",
    "-i",
    inputPath,
    "-c:v",
    "libx264",
    "-b:v",
    `${targetBitrateKbps}k`,
    "-preset",
    "veryfast",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    outputPath,
  ]);

  if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
    throw new Error("Qayta siqilgan video yaratilmadi yoki bo'sh chiqdi.");
  }
}
