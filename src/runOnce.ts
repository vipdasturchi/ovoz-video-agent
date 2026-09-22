import { config, MAX_TEXT_LENGTH, STYLES, VOICES } from "./config.ts";
import { getUpdates, sendMessage, sendDocument, sendAudio, answerCallbackQuery, type TgUpdate } from "./telegramApi.ts";
import { loadState, pushHistory, setJobStatus, type PendingSelection, type AgentState } from "./state.ts";
import { checkpoint } from "./checkpoint.ts";
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

/** Fire-and-forget send that never throws and always leaves a trace if it fails. */
async function safeSend(chatId: number | string, text: string, buttons?: { text: string; callback_data: string }[][]) {
  try {
    await sendMessage(chatId, text, buttons);
  } catch (err) {
    console.error(`[bot] sendMessage muvaffaqiyatsiz (chat ${chatId}):`, err);
  }
}

async function notifyAdmin(message: string) {
  if (!config.telegramAdminChatId) return;
  try {
    await sendMessage(config.telegramAdminChatId, message);
  } catch (err) {
    console.error("[bot] Adminga xabar yuborib bo'lmadi:", err);
  }
}

function hasCompleteDefaults(state: AgentState, userId: string): boolean {
  const d = state.defaultsByUser[userId];
  return Boolean(d?.voiceName && d?.style);
}

async function startJob(chatId: number, userId: string, state: AgentState, job: StoryJob) {
  setJobStatus(state, userId, { id: job.id, stage: "Boshlanmoqda...", updatedAt: Date.now(), done: false });

  try {
    const result = await runStoryJob(
      job,
      async (msg) => {
        setJobStatus(state, userId, { id: job.id, stage: msg, updatedAt: Date.now(), done: false });
        checkpoint(state, `job ${job.id} progress`);
        await safeSend(chatId, msg);
      },
      async (artifact: JobArtifact) => {
        try {
          if (artifact.kind === "audio") {
            await sendAudio(chatId, artifact.filePath, artifact.caption, "ovoz.wav");
          } else if (artifact.kind === "scene") {
            // sendDocument (not sendVideo) so Telegram delivers the 1080p file as-is, uncompressed.
            await sendDocument(chatId, artifact.filePath, artifact.caption, `sahna-${artifact.index + 1}.mp4`);
          } else {
            await sendDocument(chatId, artifact.filePath, artifact.caption, "hikoya.mp4");
          }
        } catch (err) {
          console.error(`[bot] Artifact yuborilmadi (${artifact.kind}, job ${job.id}):`, err);
          await safeSend(chatId, `⚠️ "${artifact.caption}" ni yuborishda xatolik yuz berdi, davom etamiz...`);
          await notifyAdmin(`Artifact yuborilmadi (${artifact.kind}, job ${job.id}, chat ${chatId}): ${(err as Error).message}`);
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
    await safeSend(chatId, `Xatolik: ${friendly}`);
    await notifyAdmin(`Ish muvaffaqiyatsiz tugadi.\nChat: ${chatId}\nJob: ${job.id}\nXato: ${friendly}`);
  } finally {
    checkpoint(state, `job ${job.id} finished`);
  }
}

async function handleUpdate(update: TgUpdate, state: AgentState) {
  if (update.message) {
    const chatId = update.message.chat.id;
    const userId = String(update.message.from?.id ?? chatId);
    const text = update.message.text?.trim();
    if (!text) return;

    if (!isAllowed(userId)) {
      await safeSend(chatId, "Kechirasiz, sizda bu botdan foydalanish huquqi yo'q.");
      return;
    }

    if (text === "/start" || text === "/menu") {
      await safeSend(
        chatId,
        "Salom! Menga o'zbekcha hikoya matnini yuboring — men uni imlo bo'yicha tuzatib, ovozga aylantirib, hikoyaga mos fon videosi bilan birlashtirib beraman.\n\nQuyidagi menyudan ham foydalanishingiz mumkin:",
        mainMenuButtons()
      );
      return;
    }

    if (text.length > MAX_TEXT_LENGTH) {
      await safeSend(chatId, `Matn juda uzun (${text.length} belgi). Iltimos, ${MAX_TEXT_LENGTH} belgidan kam matn yuboring.`);
      return;
    }

    state.pendingByUser[userId] = { text };

    if (hasCompleteDefaults(state, userId)) {
      const defaults = state.defaultsByUser[userId];
      const styleLabel = STYLES.find((s) => s.id === defaults.style)?.label ?? defaults.style;
      await safeSend(chatId, `Standart sozlamalar: ${defaults.voiceName}, ${styleLabel}.`, [
        [{ text: "✅ Shu bilan boshlash", callback_data: "confirm:go" }],
        [{ text: "🔄 Boshqa ovoz/uslub tanlash", callback_data: "confirm:custom" }],
      ]);
    } else {
      await safeSend(chatId, "Qaysi ovozda o'qilsin?", voiceButtons("voice"));
    }
    return;
  }

  if (update.callback_query) {
    const cq = update.callback_query;
    const chatId = cq.message?.chat.id;
    const userId = String(cq.from.id);
    const data = cq.data ?? "";
    if (!chatId || !isAllowed(userId)) {
      await answerCallbackQuery(cq.id).catch((err) => console.error("[bot] answerCallbackQuery muvaffaqiyatsiz:", err));
      return;
    }

    const ack = () => answerCallbackQuery(cq.id).catch((err) => console.error("[bot] answerCallbackQuery muvaffaqiyatsiz:", err));
    const pending: PendingSelection | undefined = state.pendingByUser[userId];

    // --- Main menu ---
    if (data === "menu:status") {
      await ack();
      const job = state.lastJobByUser[userId];
      if (!job) {
        await safeSend(chatId, "Hali hech qanday ish bo'lmagan.");
      } else {
        const when = new Date(job.updatedAt).toLocaleString("uz-UZ");
        const statusLine = job.done ? (job.error ? `❌ Xatolik: ${job.error}` : "✅ Tayyor") : `⏳ ${job.stage}`;
        await safeSend(
          chatId,
          `So'nggi ish (${when}):\n${statusLine}\n\nEslatma: bot har 5 daqiqada bir tekshiradi, shuning uchun holat kechikib yangilanishi mumkin.`
        );
      }
      return;
    }

    if (data === "menu:history") {
      await ack();
      const list = state.historyByUser[userId] ?? [];
      if (list.length === 0) {
        await safeSend(chatId, "Hali ovozlar/videolar yaratilmagan.");
      } else {
        const lines = list.map((h, i) => {
          const when = new Date(h.completedAt).toLocaleString("uz-UZ");
          return `${i + 1}. "${h.snippet}" — ${h.voiceName}, ${Math.round(h.durationSeconds)}s, ${h.sceneCount} sahna (${when})`;
        });
        await safeSend(chatId, `Oxirgi ${list.length} ta ish:\n\n${lines.join("\n")}`);
      }
      return;
    }

    if (data === "menu:settings") {
      await ack();
      await safeSend(chatId, "Standart ovozni tanlang:", voiceButtons("setdefault_voice"));
      return;
    }

    if (data === "menu:cancel") {
      await ack();
      delete state.pendingByUser[userId];
      await safeSend(chatId, "Joriy tanlov bekor qilindi.");
      return;
    }

    // --- Default settings flow ---
    if (data.startsWith("setdefault_voice:")) {
      await ack();
      const voiceName = data.slice("setdefault_voice:".length);
      if (!(VOICES as readonly string[]).includes(voiceName)) return;
      state.defaultsByUser[userId] = { ...state.defaultsByUser[userId], voiceName };
      await safeSend(chatId, `Standart ovoz: ${voiceName}. Endi standart uslubni tanlang:`, styleButtons("setdefault_style"));
      return;
    }

    if (data.startsWith("setdefault_style:")) {
      await ack();
      const styleId = data.slice("setdefault_style:".length);
      const styleDef = STYLES.find((s) => s.id === styleId);
      if (!styleDef) return;
      state.defaultsByUser[userId] = { ...state.defaultsByUser[userId], style: styleId };
      await safeSend(
        chatId,
        `Standart sozlamalar saqlandi: ${state.defaultsByUser[userId].voiceName}, ${styleDef.label}.\nEndi shunchaki hikoya matnini yuborsangiz, shu sozlamalar taklif qilinadi.`
      );
      return;
    }

    // --- Confirm defaults for a pending story ---
    if (data === "confirm:go") {
      if (!pending) {
        await ack();
        await safeSend(chatId, "Avval hikoya matnini yuboring.");
        return;
      }
      if (!hasCompleteDefaults(state, userId)) {
        await ack();
        await safeSend(chatId, "Standart sozlamalar to'liq emas. Qaysi ovozda o'qilsin?", voiceButtons("voice"));
        return;
      }
      await ack();
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
      await safeSend(chatId, "Qabul qilindi, tayyorlashni boshladim...");
      await startJob(chatId, userId, state, job);
      return;
    }

    if (data === "confirm:custom") {
      if (!pending) {
        await ack();
        await safeSend(chatId, "Avval hikoya matnini yuboring.");
        return;
      }
      await ack();
      await safeSend(chatId, "Qaysi ovozda o'qilsin?", voiceButtons("voice"));
      return;
    }

    // --- Normal per-story voice/style selection ---
    if (data.startsWith("voice:")) {
      if (!pending) {
        await ack();
        await safeSend(chatId, "Avval hikoya matnini yuboring.");
        return;
      }
      const voiceName = data.slice("voice:".length);
      if (!(VOICES as readonly string[]).includes(voiceName)) {
        await ack();
        return;
      }
      pending.voiceName = voiceName;
      await ack();
      await safeSend(chatId, `Ovoz: ${pending.voiceName}. Endi uslubni tanlang:`, styleButtons("style"));
      return;
    }

    if (data.startsWith("style:")) {
      if (!pending?.voiceName) {
        await ack();
        await safeSend(chatId, "Avval ovozni tanlang.");
        return;
      }
      const styleId = data.slice("style:".length);
      const styleDef = STYLES.find((s) => s.id === styleId);
      if (!styleDef) {
        await ack();
        return;
      }
      pending.style = styleId;
      await ack();

      const job: StoryJob = {
        id: `${userId}-${Date.now()}`,
        userId,
        rawText: pending.text,
        voiceName: pending.voiceName,
        style: pending.style,
        speed: 1.0,
      };
      delete state.pendingByUser[userId];

      await safeSend(chatId, "Qabul qilindi, tayyorlashni boshladim...");
      await startJob(chatId, userId, state, job);
      return;
    }

    // Unknown callback_data (e.g. from a stale/old inline keyboard) — ack so Telegram stops showing a spinner, do nothing else.
    await ack();
  }
}

let liveState: AgentState | null = null;

function installSignalHandlers() {
  const handleSignal = (signal: string) => {
    console.error(`[bot] ${signal} qabul qilindi — chiqishdan oldin oxirgi holatni saqlashga urinilmoqda...`);
    if (liveState) checkpoint(liveState, `${signal} - majburiy to'xtash`);
    process.exit(1);
  };
  process.on("SIGTERM", () => handleSignal("SIGTERM"));
  process.on("SIGINT", () => handleSignal("SIGINT"));
  process.on("uncaughtException", (err) => {
    console.error("[bot] uncaughtException:", err);
    if (liveState) checkpoint(liveState, "uncaughtException");
  });
  process.on("unhandledRejection", (reason) => {
    console.error("[bot] unhandledRejection:", reason);
  });
}

async function main() {
  installSignalHandlers();

  const state = loadState();
  liveState = state;

  let updates: TgUpdate[];
  try {
    updates = await getUpdates(state.lastUpdateId + 1);
  } catch (err) {
    console.error("[bot] getUpdates muvaffaqiyatsiz:", err);
    await notifyAdmin(`Yangilanishlarni olishda xatolik (getUpdates): ${(err as Error).message}`);
    return; // nothing was fetched — no state changed, nothing to checkpoint
  }

  for (const update of updates) {
    // Advance + persist the offset BEFORE handling, so a slow/crashing
    // handler (a story job can legitimately run for a long time) can never
    // cause Telegram to re-deliver this update on the next run.
    state.lastUpdateId = Math.max(state.lastUpdateId, update.update_id);
    checkpoint(state, `update ${update.update_id} received`);

    try {
      await handleUpdate(update, state);
    } catch (err) {
      console.error(`[bot] update_id=${update.update_id} ni qayta ishlashda xatolik:`, err);
      await notifyAdmin(
        `⚠️ Bitta xabarni qayta ishlashda kutilmagan xatolik (update_id=${update.update_id}): ${(err as Error).message}`
      );
    }

    checkpoint(state, `update ${update.update_id} handled`);
  }
}

main()
  .catch(async (err) => {
    console.error("[fatal]", err);
    await notifyAdmin(`Agent ishga tushishda xatolik: ${(err as Error).message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    if (liveState) checkpoint(liveState, "run finished");
  });
