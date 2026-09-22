# O'zbek Ovoz — hikoya → video agenti (GitHub Actions)

Telegram botga o'zbekcha hikoya yuboring → agent imlosini tuzatadi, tanlagan
ovozingizda o'qib beradi, hikoyaga mos fon videosini Google Flow orqali
generatsiya qiladi va bittalashtirilgan videoni sizga qaytarib yuboradi.

**Bu versiya butunlay bepul GitHub Actions'da ishlaydi** — hech qanday server
sotib olish shart emas. Sabab: oddiy (PHP hosting kabi) shared hostingda
Chromium brauzerini ishga tushirib bo'lmadi (kerakli tizim kutubxonalari
o'rnatilmagan, va ularni o'rnatish uchun root huquqi yo'q). GitHub Actions'ning
ochiq (public) repolar uchun bepul, to'liq huquqli (root) va Chromium allaqachon
mos runner'lari bu muammoni butunlay chetlab o'tadi.

## Qanday ishlaydi

```
Har 5 daqiqada (GitHub Actions cron) ishga tushadi:
  -> Telegramdan yangi xabarlarni tekshiradi (Bot API, getUpdates)
  -> hikoya + ovoz + uslub tanlangan bo'lsa:
       imlo tuzatish -> ovoz sintezi -> sahna promptlari
       -> Google Flow'da videolar (Playwright)
       -> ffmpeg: video + ovoz birlashtirish
       -> Telegram orqali videoni yuboradi
  -> holatni (oxirgi xabar raqami) repo'ga qaytarib saqlaydi
  -> ishdan chiqadi (keyingi safar 5 daqiqadan keyin qayta boshlanadi)
```

Bu — sizning boshqa botlaringiz ishlatadigan "cron + tekshirish" uslubi bilan
bir xil g'oya, faqat GitHub Actions'da.

## ⚠️ Muhim ogohlantirishlar

1. **Darhol javob bermaydi.** Xabar yuborgandan keyin botning javobi 5
   daqiqagacha kechikishi mumkin (keyingi cron ishga tushgunicha). Haqiqiy
   real-time bot emas.
2. **Flow avtomatlashtirish beqaror.** Flow'ning rasmiy API'si yo'q — bu
   agent uning veb-interfeysini "bosadi". Flow interfeysi o'zgarsa,
   `src/pipeline/flowAutomation.ts`ni yangilash kerak bo'ladi.
3. **Google akkount xavfi.** GitHub'ning serverlari (datacenter IP) orqali
   Flow'ga kirish Google tomonidan "shubhali" deb belgilanishi va sessiyani
   bekor qilishi mumkin. **Shu sabab Flow uchun alohida Google akkount
   ishlatishni tavsiya qilamiz** — asosiy akkountingiz emas.
4. **Reponi ochiq (public) saqlash kerak** — chunki GitHub Actions faqat
   ochiq repolarda cheksiz bepul. Kod o'zi (bu papkadagi fayllar) hech qanday
   maxfiy narsa saqlamaydi — barcha kalitlar GitHub Secrets orqali alohida
   saqlanadi, kodga yozilmaydi.

## 1. Bitta marta: Flow login sessiyasini olish (shu Mac'da)

```bash
cd ovoz-video-agent
npm install
npm run login:flow
```

Haqiqiy brauzer oynasi ochiladi — Google hisobingizga (afzalan alohida,
shu maqsad uchun ochilgan) qo'lda kiring, Flow'da bitta loyiha oching yoki
yarating, keyin terminalda Enter bosing. Oxirida uzun base64 qator chiqadi —
buni keyinroq GitHub Secret sifatida qo'shasiz.

Flow loyihangiz URL manzilini (brauzer manzil satridan) ham nusxalab qo'ying.

## 2. Telegram bot yaratish

Telegram'da **@BotFather**ga yozing → `/newbot` → nom bering → sizga token
beradi (masalan `123456:AAExxxxx`). Buni saqlab qo'ying.

O'z Telegram ID'ingizni bilish uchun **@userinfobot**ga yozing.

## 3. GitHub'da repo yaratish va kodni yuklash

1. github.com'da yangi **ochiq (Public)** repo yarating (masalan
   `ovoz-video-agent`)
2. Shu papkadagi barcha fayllarni (node_modules'siz) o'sha repoga yuklang
3. Repo **Settings → Secrets and variables → Actions** bo'limiga o'ting:
   - **Secrets** (maxfiy, hech kim ko'rmaydi) qo'shing:
     - `GEMINI_API_KEY`
     - `TELEGRAM_BOT_TOKEN`
     - `FLOW_STORAGE_STATE` (1-qadamdagi uzun base64 qator)
   - **Variables** (oddiy, maxfiy emas) qo'shing:
     - `TELEGRAM_ALLOWED_USER_IDS` — sizning Telegram ID'ingiz
     - `TELEGRAM_ADMIN_CHAT_ID` — xatolik xabarlarini qayerga yuborish (odatda xuddi shu ID)
     - `FLOW_PROJECT_URL` — 1-qadamdagi Flow loyiha manzili

Shu bilan tayyor — **Actions** bo'limida "Ovoz video agent" workflow'i har 5
daqiqada avtomatik ishga tushadi. Birinchi marta qo'lda sinash uchun Actions
bo'limidan "Run workflow" tugmasini bosishingiz mumkin.

## Sessiya eskirsa

Google sessiyalari vaqti-vaqti bilan tugaydi. Agar bot "Flow login xatosi"
haqida xabar bera boshlasa: `npm run login:flow`ni qayta ishga tushiring va
`FLOW_STORAGE_STATE` secretini yangi qiymat bilan yangilang.

## Fayl tuzilishi

```
.github/workflows/agent.yml   har 5 daqiqada ishga tushadigan workflow
src/
  config.ts                   muhit o'zgaruvchilari
  telegramApi.ts               Telegram Bot API (fetch asosida, kutubxonasiz)
  state.ts                     oxirgi xabar raqami + kutilayotgan tanlovlar (repo'da saqlanadi)
  runOnce.ts                    asosiy skript: bir marta tekshirib, kerak bo'lsa video yasaydi
  gemini.ts                     imlo tuzatish, TTS, sahna promptlarini rejalashtirish
  wav.ts                        PCM -> WAV header
  pipeline/
    runJob.ts                   bitta hikoyani boshidan oxirigacha bajaradi
    flowAutomation.ts            Playwright orqali Flow'ni boshqaradi
    assembleVideo.ts             ffmpeg: concat + audio overlay
scripts/
  flow-login.ts                  bir martalik interaktiv Flow/Google login (shu Mac'da)
```
