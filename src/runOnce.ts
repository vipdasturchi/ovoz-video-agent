import { config, MAX_TEXT_LENGTH, STYLES, VOICES } from "./config.ts";
import { getUpdates, sendMessage, sendVideo, sendAudio, answerCallbackQuery } from "./telegramApi.ts";
import {
  loadState,
  saveState,
  pushHistory,
  setJobStatus,
  type PendingSelection,
  type AgentState,
} from "./state.ts";
import { runStoryJob, JobUserFacingError, type StoryJob, type JobArtifact } from "./pipeline/runJob.ts";

function isAllowed(userId: string): boolean {
  if (config.telegramAllowedUserIds.length === 0) return true;
  return config.telegramAllowedUserIds.includes(userId);
}

function voiceButtons(prefix: "voice" | "setdefault_voice") {
  return VOICES.map((v) => [{ text: v, callback_data: `${prefix}:${v}` }]);
}

function styleButtons(prefix: "style" | "setdefault_style") {
  return STYLES.map((s) => [{ text: s.label, callback_data: `${prefix}:${s.id}` }]);
}

function mainMenuButtons() {
  return [
    [{ text: "📊 Holat", callback_data: "menu:status" }],
    [{ text: "🕘 Oxirgi ishlar", callback_data: "menu:history" }],
    [{ text: "⚙️ Standart ovoz/uslub", callback_data: "menu:settings" }],
    [{ text: "❌ Joriy tanlovni bekor qilish", callback_data: "menu:cancel" }],
  ];
}

async function notifyAdmin(message: string) {
  if (!config.telegramAdminChatId) return;
  await sendMessage(config.telegramAdminChatId, message).catch((err) =>
    console.error("[bot] Adminga xabar yuborib bo'lmadi:", err)
  );
}

async function startJob(chatId: number, userId: string, state: AgentState, job: StoryJob) {
  setJobStatus(state, userId, { id: job.id, stage: "Boshlanmoqda...", updatedAt: Date.now(), done: false });
  saveState(state);

  try {
    const result = await runStoryJob(
      job,
      async (msg) => {
        setJobStatus(state, userId, { id: job.id, stage: msg, updatedAt: Date.now(), done: false });
        await sendMessage(chatId, msg).catch(() => {});
      },
      async (artifact: JobArtifact) => {
        try {
          if (artifact.kind === "audio") {
            await sendAudio(chatId, artifact.filePath, artifact.caption, "ovoz.wav");
          } else if (artifact.kind === "scene") {
            await sendVideo(chatId, artifact.filePath, artifact.caption, `sahna-${artifact.index + 1}.mp4`);
          } else {
            await sendVideo(chatId, artifact.filePath, artifact.caption, "hikoya.mp4");
          }
        } catch (err) {
          console.error(`[bot] Artifact yuborilmadi (${artifact.kind}):`, err);
        }
      }
    );

    setJobStatus(state, userId, { id: job.id, stage: "Tayyor", updatedAt: Date.now(), done: true });
    pushHistory(state, userId, {
      id: job.id,
      snippet: job.rawText.slice(0, 60) + (job.rawText.length > 60 ? "…" : ""),
      voiceName: job.voiceName,
      style: job.style,
      durationSeconds: result.durationSeconds,
      sceneCount: result.sceneCount,
      completedAt: Date.now(),
    });
  } catch (err) {
    const friendly =
      err instanceof JobUserFacingError ? err.message : `Kutilmagan xatolik yuz berdi: ${(err as Error).message}`;
    setJobStatus(state, userId, { id: job.id, stage: "Xatolik", updatedAt: Date.now(), done: true, error: friendly });
    await sendMessage(chatId, `Xatolik: ${friendly}`).catch(() => {});
    await notifyAdmin(`Ish muvaffaqiyatsiz tugadi.\nChat: ${chatId}\nJob: ${job.id}\nXato: ${friendly}`);
  }
}

async function main() {
  const state = loadState();
  const updates = await getUpdates(state.lastUpdateId + 1);

  for (const update of updates) {
    state.lastUpdateId = Math.max(state.lastUpdateId, update.update_id);

    if (update.message) {
      const chatId = update.message.chat.id;
      const userId = String(update.message.from?.id ?? chatId);
      const text = update.message.text?.trim();
      if (!text) continue;

      if (!isAllowed(userId)) {
        await sendMessage(chatId, "Kechirasiz, sizda bu botdan foydalanish huquqi yo'q.");
        continue;
      }

      if (text === "/start" || text === "/menu") {
        await sendMessage(
          chatId,
          "Salom! Menga o'zbekcha hikoya matnini yuboring — men uni imlo bo'yicha tuzatib, ovozga aylantirib, hikoyaga mos fon videosi bilan birlashtirib beraman.\n\nQuyidagi menyudan ham foydalanishingiz mumkin:",
          mainMenuButtons()
        );
        continue;
      }

      if (text.length > MAX_TEXT_LENGTH) {
        await sendMessage(chatId, `Matn juda uzun (${text.length} belgi). Iltimos, ${MAX_TEXT_LENGTH} belgidan kam matn yuboring.`);
        continue;
      }

      state.pendingByUser[userId] = { text };
      const defaults = state.defaultsByUser[userId];

      if (defaults?.voiceName && defaults?.style) {
        const styleLabel = STYLES.find((s) => s.id === defaults.style)?.label ?? defaults.style;
        state.pendingByUser[userId].awaitingConfirm = true;
        await sendMessage(chatId, `Standart sozlamalar: ${defaults.voiceName}, ${styleLabel}.`, [
          [{ text: "✅ Shu bilan boshlash", callback_data: "confirm:go" }],
          [{ text: "🔄 Boshqa ovoz/uslub tanlash", callback_data: "confirm:custom" }],
        ]);
      } else {
        await sendMessage(chatId, "Qaysi ovozda o'qilsin?", voiceButtons("voice"));
      }
      continue;
    }

    if (update.callback_query) {
      const cq = update.callback_query;
      const chatId = cq.message?.chat.id;
      const userId = String(cq.from.id);
      const data = cq.data ?? "";
      if (!chatId || !isAllowed(userId)) {
        await answerCallbackQuery(cq.id).catch(() => {});
        continue;
      }

      const pending: PendingSelection | undefined = state.pendingByUser[userId];

      // --- Main menu ---
      if (data === "menu:status") {
        await answerCallbackQuery(cq.id);
        const job = state.lastJobByUser[userId];
        if (!job) {
          await sendMessage(chatId, "Hali hech qanday ish bo'lmagan.");
        } else {
          const when = new Date(job.updatedAt).toLocaleString("uz-UZ");
          const statusLine = job.done ? (job.error ? `❌ Xatolik: ${job.error}` : "✅ Tayyor") : `⏳ ${job.stage}`;
          await sendMessage(chatId, `So'nggi ish (${when}):\n${statusLine}\n\nEslatma: bot har 5 daqiqada bir tekshiradi, shuning uchun holat kechikib yangilanishi mumkin.`);
        }
        continue;
      }

      if (data === "menu:history") {
        await answerCallbackQuery(cq.id);
        const list = state.historyByUser[userId] ?? [];
        if (list.length === 0) {
          await sendMessage(chatId, "Hali ovozlar/videolar yaratilmagan.");
        } else {
          const lines = list.map((h, i) => {
            const when = new Date(h.completedAt).toLocaleString("uz-UZ");
            return `${i + 1}. "${h.snippet}" — ${h.voiceName}, ${Math.round(h.durationSeconds)}s, ${h.sceneCount} sahna (${when})`;
          });
          await sendMessage(chatId, `Oxirgi ${list.length} ta ish:\n\n${lines.join("\n")}`);
        }
        continue;
      }

      if (data === "menu:settings") {
        await answerCallbackQuery(cq.id);
        await sendMessage(chatId, "Standart ovozni tanlang:", voiceButtons("setdefault_voice"));
        continue;
      }

      if (data === "menu:cancel") {
        await answerCallbackQuery(cq.id);
        delete state.pendingByUser[userId];
        await sendMessage(chatId, "Joriy tanlov bekor qilindi.");
        continue;
      }

      // --- Default settings flow ---
      if (data.startsWith("setdefault_voice:")) {
        await answerCallbackQuery(cq.id);
        const voiceName = data.slice("setdefault_voice:".length);
        state.defaultsByUser[userId] = { ...state.defaultsByUser[userId], voiceName };
        await sendMessage(chatId, `Standart ovoz: ${voiceName}. Endi standart uslubni tanlang:`, styleButtons("setdefault_style"));
        continue;
      }

      if (data.startsWith("setdefault_style:")) {
        await answerCallbackQuery(cq.id);
        const styleId = data.slice("setdefault_style:".length);
        state.defaultsByUser[userId] = { ...state.defaultsByUser[userId], style: styleId };
        const d = state.defaultsByUser[userId];
        await sendMessage(chatId, `Standart sozlamalar saqlandi: ${d.voiceName}, ${STYLES.find((s) => s.id === styleId)?.label}.\nEndi shunchaki hikoya matnini yuborsangiz, shu sozlamalar taklif qilinadi.`);
        continue;
      }

      // --- Confirm defaults for a pending story ---
      if (data === "confirm:go") {
        if (!pending || !state.defaultsByUser[userId]) {
          await answerCallbackQuery(cq.id, "Avval hikoya matnini yuboring.");
          continue;
        }
        await answerCallbackQuery(cq.id);
        const defaults = state.defaultsByUser[userId];
        const job: StoryJob = {
          id: `${userId}-${Date.now()}`,
          userId,
          rawText: pending.text,
          voiceName: defaults.voiceName!,
          style: defaults.style!,
          speed: 1.0,
        };
        delete state.pendingByUser[userId];
        await sendMessage(chatId, "Qabul qilindi, tayyorlashni boshladim...");
        await startJob(chatId, userId, state, job);
        continue;
      }

      if (data === "confirm:custom") {
        if (!pending) {
          await answerCallbackQuery(cq.id, "Avval hikoya matnini yuboring.");
          continue;
        }
        await answerCallbackQuery(cq.id);
        pending.awaitingConfirm = false;
        await sendMessage(chatId, "Qaysi ovozda o'qilsin?", voiceButtons("voice"));
        continue;
      }

      // --- Normal per-story voice/style selection ---
      if (data.startsWith("voice:")) {
        if (!pending) {
          await answerCallbackQuery(cq.id, "Avval hikoya matnini yuboring.");
          continue;
        }
        pending.voiceName = data.slice("voice:".length);
        await answerCallbackQuery(cq.id);
        await sendMessage(chatId, `Ovoz: ${pending.voiceName}. Endi uslubni tanlang:`, styleButtons("style"));
        continue;
      }

      if (data.startsWith("style:")) {
        if (!pending?.voiceName) {
          await answerCallbackQuery(cq.id, "Avval ovozni tanlang.");
          continue;
        }
        pending.style = data.slice("style:".length);
        await answerCallbackQuery(cq.id);

        const job: StoryJob = {
          id: `${userId}-${Date.now()}`,
          userId,
          rawText: pending.text,
          voiceName: pending.voiceName,
          style: pending.style,
          speed: 1.0,
        };
        delete state.pendingByUser[userId];

        await sendMessage(chatId, "Qabul qilindi, tayyorlashni boshladim...");
        await startJob(chatId, userId, state, job);
        continue;
      }
    }
  }

  saveState(state);
}

main().catch(async (err) => {
  console.error("[fatal]", err);
  await notifyAdmin(`Agent ishga tushishda xatolik: ${(err as Error).message}`).catch(() => {});
  process.exit(1);
});
