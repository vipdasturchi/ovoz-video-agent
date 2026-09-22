import fs from "node:fs";
import { config } from "../config.ts";
import { withRetry } from "../retry.ts";

export class ImageGenerationError extends Error {}

/**
 * Generates one still scene image via Cloudflare Workers AI (FLUX.1 [schnell]),
 * which has a genuinely free daily quota (10,000 "neurons"/day, no billing —
 * unlike every video-generation option and every image API we checked
 * before this one, which all required a paid balance). The image is later
 * turned into a moving clip with a Ken Burns pan/zoom in ffmpeg.
 */
export async function generateSceneImage(prompt: string, destPath: string): Promise<void> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${config.cloudflareAccountId}/ai/run/@cf/black-forest-labs/flux-1-schnell`;

  const base64Image = await withRetry(
    async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60000);
      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.cloudflareApiToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ prompt, steps: 8 }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      const data = (await res.json()) as {
        success: boolean;
        result?: { image?: string };
        errors?: { message: string }[];
      };

      if (!data.success || !data.result?.image) {
        const message = data.errors?.map((e) => e.message).join("; ") ?? `HTTP ${res.status}`;
        throw new ImageGenerationError(`Cloudflare rasm generatsiyasi xatosi: ${message}`);
      }

      return data.result.image;
    },
    { attempts: 3, baseDelayMs: 2000, label: "Cloudflare image generation" }
  );

  fs.writeFileSync(destPath, Buffer.from(base64Image, "base64"));
  if (fs.statSync(destPath).size === 0) {
    throw new ImageGenerationError("Cloudflare bo'sh rasm qaytardi.");
  }
}
