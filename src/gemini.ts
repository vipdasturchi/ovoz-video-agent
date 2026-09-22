import { GoogleGenAI } from "@google/genai";
import { config, STYLE_INSTRUCTIONS, VOICE_MAP } from "./config.ts";
import { withRetry } from "./retry.ts";

const ai = new GoogleGenAI({ apiKey: config.geminiApiKey });

export async function enhanceText(text: string): Promise<string> {
  const prompt = [
    "Siz o'zbek tili imlo va uslub muharrirsiz.",
    "Quyidagi matndagi o' va g' harflarini, tinish belgilarini va grammatik qo'shimchalarni to'g'irlang, matnni ravon va chiroyli qiling.",
    "Faqat to'g'irlangan matnni qaytaring — hech qanday izoh, tushuntirish, tirnoq belgisi yoki qo'shimcha so'z yozmang.",
    "",
    `Matn: ${text}`,
  ].join("\n");

  const response = await withRetry(
    () => ai.models.generateContent({ model: "gemini-3.5-flash", contents: [{ parts: [{ text: prompt }] }] }),
    { label: "Gemini enhanceText" }
  );

  const result = response.text?.trim();
  // An empty/missing response is silently falling back to the original text is
  // worse than it sounds here — it means unfixed spelling gets narrated. Only
  // fall back if the model genuinely gave us nothing usable; log so it's visible.
  if (!result) {
    console.error("[gemini] enhanceText bo'sh natija qaytardi, asl matn ishlatiladi.");
    return text;
  }
  return result;
}

export interface SynthesizedVoice {
  pcmBytes: Buffer;
  sampleRate: number;
  channels: number;
  bitDepth: number;
  durationSeconds: number;
}

export async function synthesizeVoice(
  text: string,
  voiceName: string,
  style: string,
  speed: number
): Promise<SynthesizedVoice> {
  const resolvedSystemVoice = VOICE_MAP[voiceName] ?? "Zephyr";
  const styleInstruction = STYLE_INSTRUCTIONS[style] ?? STYLE_INSTRUCTIONS.natural;
  const prompt = `Quyidagi matnni ${styleInstruction} ravishda o'qib ber: ${text}`;

  const response = await withRetry(
    () =>
      ai.models.generateContent({
        model: "gemini-3.1-flash-tts-preview",
        contents: [{ parts: [{ text: prompt }] }],
        config: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: resolvedSystemVoice },
            },
          },
        },
      }),
    { label: "Gemini synthesizeVoice" }
  );

  const part = response.candidates?.[0]?.content?.parts?.[0];
  const audioBase64 = part?.inlineData?.data;
  if (!audioBase64) throw new Error("Model audio ma'lumotini qaytarmadi (TTS).");

  const pcmBytes = Buffer.from(audioBase64, "base64");
  if (pcmBytes.length === 0) throw new Error("Model bo'sh audio qaytardi (TTS).");

  const sampleRate = 24000;
  const channels = 1;
  const bitDepth = 16;
  const durationSeconds = pcmBytes.length / (sampleRate * channels * (bitDepth / 8));

  return { pcmBytes, sampleRate, channels, bitDepth, durationSeconds };
}

export interface ScenePlan {
  prompts: string[];
}

/**
 * Reads the (already-corrected) Uzbek story and returns an ordered list of
 * English still-image prompts — one per 8s scene — covering the narrative
 * from start to finish and sized to the narration's duration. Each image
 * later becomes a video clip via a Ken Burns pan/zoom (see assembleVideo.ts)
 * rather than true AI video generation, so prompts describe a single static
 * frame, not camera movement or action-in-progress.
 */
export async function planScenes(storyText: string, durationSeconds: number, sceneSeconds: number): Promise<ScenePlan> {
  const sceneCount = Math.max(1, Math.ceil(durationSeconds / sceneSeconds));

  const prompt = [
    "You are an illustrator breaking an Uzbek short story into a storyboard of still images for an AI text-to-image model.",
    `The narrated audio is about ${Math.round(durationSeconds)} seconds long. Produce exactly ${sceneCount} scenes, each representing about ${sceneSeconds} seconds of the story, in chronological order.`,
    "For each scene write ONE English image-generation prompt describing a single static frame: subject, setting, composition, lighting/mood. Cinematic, photorealistic, film grain, 16:9 wide shot. Do NOT describe motion, camera movement, or multiple moments — one still frame only. Always end every prompt with: 'no text, no subtitles, no watermark, no UI.'",
    "Do not include any dialogue or spoken words in the prompts — these are silent background visuals only.",
    `Respond with ONLY a raw JSON array of exactly ${sceneCount} strings (no markdown fences, no explanation), one string per scene, in the exact order they should play.`,
    "",
    "Story (Uzbek):",
    storyText,
  ].join("\n");

  const response = await withRetry(
    () => ai.models.generateContent({ model: "gemini-3.5-flash", contents: [{ parts: [{ text: prompt }] }] }),
    { label: "Gemini planScenes" }
  );

  const raw = response.text?.trim() ?? "[]";
  const jsonMatch = raw.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error("Sahna promptlarini generatsiya qilishda xatolik: model JSON qaytarmadi.");

  let prompts: unknown;
  try {
    prompts = JSON.parse(jsonMatch[0]);
  } catch {
    throw new Error("Sahna promptlarini generatsiya qilishda xatolik: model noto'g'ri JSON qaytardi.");
  }

  if (!Array.isArray(prompts) || prompts.length === 0 || !prompts.every((p) => typeof p === "string" && p.trim())) {
    throw new Error("Sahna promptlarini generatsiya qilishda xatolik: bo'sh yoki noto'g'ri formatdagi natija.");
  }

  // The model is asked for exactly `sceneCount` but LLM output length isn't
  // guaranteed — clamp so downstream (video/audio duration matching) stays sane
  // instead of silently drifting scene count away from what was planned for.
  const clamped = prompts.slice(0, sceneCount);
  while (clamped.length < sceneCount) clamped.push(clamped[clamped.length - 1] ?? "A calm cinematic establishing shot, photorealistic, no text, no subtitles, no watermark, no UI.");

  return { prompts: clamped };
}
