import { GoogleGenAI } from "@google/genai";
import { config, STYLE_INSTRUCTIONS, VOICE_MAP } from "./config.ts";

const ai = new GoogleGenAI({ apiKey: config.geminiApiKey });

export async function enhanceText(text: string): Promise<string> {
  const prompt = [
    "Siz o'zbek tili imlo va uslub muharrirsiz.",
    "Quyidagi matndagi o' va g' harflarini, tinish belgilarini va grammatik qo'shimchalarni to'g'irlang, matnni ravon va chiroyli qiling.",
    "Faqat to'g'irlangan matnni qaytaring — hech qanday izoh, tushuntirish, tirnoq belgisi yoki qo'shimcha so'z yozmang.",
    "",
    `Matn: ${text}`,
  ].join("\n");

  const response = await ai.models.generateContent({
    model: "gemini-3.5-flash",
    contents: [{ parts: [{ text: prompt }] }],
  });

  return response.text?.trim() || text;
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

  const response = await ai.models.generateContent({
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
  });

  const part = response.candidates?.[0]?.content?.parts?.[0];
  const audioBase64 = part?.inlineData?.data;
  if (!audioBase64) throw new Error("Model audio ma'lumotini qaytarmadi (TTS).");

  const pcmBytes = Buffer.from(audioBase64, "base64");
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
 * English, Flow-ready cinematic video prompts — one per 8s scene — covering
 * the narrative from start to finish and sized to the narration's duration.
 */
export async function planScenes(storyText: string, durationSeconds: number, sceneSeconds: number): Promise<ScenePlan> {
  const sceneCount = Math.max(1, Math.ceil(durationSeconds / sceneSeconds));

  const prompt = [
    "You are a film director breaking an Uzbek short story into a storyboard for an AI text-to-video model (Google Veo).",
    `The narrated audio is about ${Math.round(durationSeconds)} seconds long. Produce exactly ${sceneCount} scenes, each covering ${sceneSeconds} seconds, in chronological story order.`,
    "For each scene write ONE English video-generation prompt: describe the shot (camera framing, subject, action), lighting/mood, and camera movement. Cinematic, photorealistic, film grain. Always end every prompt with: 'no text, no subtitles, no UI.'",
    "Do not include any dialogue or spoken words in the prompts — these are silent background visuals only.",
    "Respond with ONLY a raw JSON array of strings (no markdown fences, no explanation), one string per scene, in the exact order they should play.",
    "",
    "Story (Uzbek):",
    storyText,
  ].join("\n");

  const response = await ai.models.generateContent({
    model: "gemini-3.5-flash",
    contents: [{ parts: [{ text: prompt }] }],
  });

  const raw = response.text?.trim() ?? "[]";
  const jsonMatch = raw.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error("Sahna promptlarini generatsiya qilishda xatolik: model JSON qaytarmadi.");

  const prompts = JSON.parse(jsonMatch[0]) as string[];
  if (!Array.isArray(prompts) || prompts.length === 0) {
    throw new Error("Sahna promptlarini generatsiya qilishda xatolik: bo'sh natija.");
  }

  return { prompts };
}
