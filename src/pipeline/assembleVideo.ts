import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";

function run(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath as string, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    proc.on("error", reject);
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

  const concatListPath = path.join(jobDir, "concat_list.txt");
  const listContent = clipPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n");
  fs.writeFileSync(concatListPath, listContent);

  const concatenatedPath = path.join(jobDir, "concatenated.mp4");
  await run(["-y", "-f", "concat", "-safe", "0", "-i", concatListPath, "-c", "copy", concatenatedPath]);

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
    outputPath,
  ]);
}
