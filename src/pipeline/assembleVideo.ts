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

/** Re-encodes at a lower bitrate/resolution to shrink the file, used when the assembled video is too large for Telegram's 50MB upload limit. */
export async function reencodeToFitSize(inputPath: string, outputPath: string, targetBitrateKbps: number): Promise<void> {
  await run([
    "-y",
    "-i",
    inputPath,
    "-vf",
    "scale=-2:720",
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
