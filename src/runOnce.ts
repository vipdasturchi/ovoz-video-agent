import { config, MAX_TEXT_LENGTH, STYLES, VOICES } from "./config.ts";
import { getUpdates, sendMessage, sendVideo, answerCallbackQuery } from "./telegramApi.ts";
import { loadState, saveState, type PendingSelection } from "./state.ts";
import { runStoryJob, JobUserFacingError, type StoryJob } from "./pipeline/runJob.ts";

function isAllowed(userId: string): boolean {
  if (config.telegramAllowedUserIds.length === 0) return true;
  return config.telegramAllowedUserIds.includes(userId);
}

function voiceButtons() {
  return VOICES.map((v) => [{ text: v, callback_data: `voice:${v}` }]);
}

function styleButtons() {
  return STYLES.map((s) => [{ text: s.label, callback_data: `style:${s.id}` }]);
}

async function notifyAdmin(message: string) {
  if (!config.telegramAdminChatId) return;
  await sendMessage(config.telegramAdminChatId, message).catch((err) =>
    console.error("[bot] Adminga xabar yuborib bo'lmadi:", err)
  );
}

async function runJobAndDeliver(chatId: number, job: StoryJob) {
  try {
    const result = await runStoryJob(job, async (msg) => {
      await sendMessage(chatId, msg).catch(() => {});
    });
    await sendVideo(chatId, result.finalVideoPath, `Tayyor! ${result.sceneCount} ta sahna, ${Math.round(result.durationSeconds)}s.`);
  } catch (err) {
    const friendly =
      err instanceof JobUserFacingError ? err.message : `Kutilmagan xatolik yuz berdi: ${(err as Error).message}`;
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

      if (text === "/start") {
        await sendMessage(
          chatId,
          "Salom! Menga o'zbekcha hikoya matnini yuboring — men uni imlo bo'yicha tuzatib, ovozga aylantirib, hikoyaga mos fon videosi bilan birlashtirib beraman."
        );
        continue;
      }

      if (text.length > MAX_TEXT_LENGTH) {
        await sendMessage(chatId, `Matn juda uzun (${text.length} belgi). Iltimos, ${MAX_TEXT_LENGTH} belgidan kam matn yuboring.`);
        continue;
      }

      state.pendingByUser[userId] = { text };
      await sendMessage(chatId, "Qaysi ovozda o'qilsin?", voiceButtons());
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

      if (data.startsWith("voice:")) {
        if (!pending) {
          await answerCallbackQuery(cq.id, "Avval hikoya matnini yuboring.");
          continue;
        }
        pending.voiceName = data.slice("voice:".length);
        await answerCallbackQuery(cq.id);
        await sendMessage(chatId, `Ovoz: ${pending.voiceName}. Endi uslubni tanlang:`, styleButtons());
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
        await runJobAndDeliver(chatId, job);
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
