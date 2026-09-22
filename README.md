# O'zbek Ovoz — hikoya → video agenti (GitHub Actions)

Telegram botga o'zbekcha hikoya yuboring → agent imlosini tuzatadi, tanlagan
ovozingizda o'qib beradi, hikoyaga mos sahna rasmlarini yaratib ularga sekin
zoom/pan effekti ("Ken Burns effekti" — hujjatli filmlarda ko'p ishlatiladigan
uslub) beradi, va bittalashtirilgan 1080p videoni sizga fayl sifatida
(siqilmagan holda) qaytarib yuboradi.

**Bu versiya butunlay bepul GitHub Actions'da ishlaydi** — hech qanday server
sotib olish shart emas.

## Qanday ishlaydi

```
Har 5 daqiqada (GitHub Actions cron) ishga tushadi:
  -> Telegramdan yangi xabarlarni tekshiradi (Bot API, getUpdates)
  -> hikoya + ovoz + uslub tanlangan bo'lsa:
       imlo tuzatish -> ovoz sintezi -> sahna promptlari
       -> har bir sahna uchun: rasm (Cloudflare Workers AI, bepul)
          -> ffmpeg bilan sekin zoom/pan effekti -> 8s 1080p video klip
       -> ffmpeg: barcha klip + ovozni birlashtirish
       -> Telegram orqali fayl sifatida (siqilmagan) yuboradi
  -> holatni (oxirgi xabar raqami) repo'ga qaytarib saqlaydi
  -> ishdan chiqadi (keyingi safar 5 daqiqadan keyin qayta boshlanadi)
```

Bu — sizning boshqa botlaringiz ishlatadigan "cron + tekshirish" uslubi bilan
bir xil g'oya, faqat GitHub Actions'da.

**Nega haqiqiy AI video (Veo/Flow) emas, rasm + zoom/pan?** Hech qanday
provayder (Veo, Kling, Runway, Luma, Pika, Flow) haqiqiy AI video
generatsiyasini bepul taklif qilmaydi — buni tekshirib chiqdik. Rasm
generatsiyasi orasida ham aksariyati (shu jumladan Gemini'ning o'zi) bepul
emas — faqat **Cloudflare Workers AI**da haqiqiy bepul kunlik limit bor
(kredit karta shart emas). Shuning uchun: bepul rasm + ffmpeg'ning o'zi
qo'shadigan sekin kamera harakati = butunlay bepul, ishonchli video.

## ⚠️ Muhim ogohlantirishlar

1. **Darhol javob bermaydi.** Xabar yuborgandan keyin botning javobi 5
   daqiqagacha kechikishi mumkin (keyingi cron ishga tushgunicha). Haqiqiy
   real-time bot emas.
2. **Kamera harakati sodda.** Sahnalar haqiqiy AI-video emas — statik rasmga
   ffmpeg orqali sekin zoom beriladi. Flow/Veo'dagidek to'liq harakatli
   sahna emas, lekin tez, ishonchli va bepul.
3. **Cloudflare kunlik limiti.** Bepul tarif kuniga 10,000 "neuron" (taxminan
   150-1000 rasm, hikoyaning uzunligiga qarab) beradi — oddiy foydalanish
   uchun yetarli. Agar shu limitdan oshib ketsangiz, agent aniq xabar beradi
   (keyingi kunga qadar kutish kerak bo'ladi).
4. **Reponi ochiq (public) saqlash kerak** — chunki GitHub Actions faqat
   ochiq repolarda cheksiz bepul. Barcha kalitlar (API kalitlar, Telegram
   token, Cloudflare token) GitHub Secrets orqali alohida saqlanadi, kodga
   yozilmaydi. Foydalanuvchi yuborgan hikoya matni `state/state.json`
   faylida vaqtincha (tanlov kutilayotganda) saqlanadi — bu fayl repo bilan
   birga commit qilinadi, shuning uchun matn shifrlab saqlanadi (bot
   tokenidan olingan kalit bilan, AES-256-GCM) va public repo'ni ko'rgan
   birov uni o'qiy olmaydi.
5. **Video hajmi.** Telegram bot API orqali yuborilgan fayl 50MB dan katta
   bo'lsa, agent avtomatik ravishda videoni (1080p'ni saqlab qolgan holda,
   faqat bitrateni pasaytirib) qayta siqadi; siqilgandan keyin ham katta
   bo'lsa, foydalanuvchiga aniq xabar beradi (jim qolib ketmaydi). Amalda
   rasm+zoom videolari juda yaxshi siqiladi, bu holat kamdan-kam yuzaga keladi.
6. **Fayl sifatida yuboriladi.** Video Telegram'ga "hujjat" (document) sifatida
   yuboriladi, "video" sifatida emas — bu Telegram'ning o'z serverida video
   uchun qo'shimcha siqishning oldini oladi. Ya'ni Telegram ilovasida
   ichkarida ko'rinadigan "player" o'rniga yuklab olinadigan fayl ko'rinadi.

## 1. Cloudflare hisobi va API token (bepul, rasm generatsiyasi uchun)

1. [dash.cloudflare.com](https://dash.cloudflare.com)da bepul hisob oching
   (kredit karta shart emas).
2. Chap menyudan **Workers & Pages → Overview** sahifasiga o'ting — o'ng
   tomonda **Account ID** ko'rinadi, uni nusxalab qo'ying.
3. **My Profile → API Tokens → Create Token** → "Workers AI" uchun mos
   shablon tanlang (yoki custom token: **Account → Workers AI → Read/Edit**
   huquqi bilan) → tokenni yarating va nusxalab qo'ying (faqat bir marta
   to'liq holda ko'rsatiladi).

## 2. Telegram bot yaratish

Telegram'da **@BotFather**ga yozing → `/newbot` → nom bering → sizga token
beradi (masalan `123456:AAExxxxx`). Buni saqlab qo'ying.

O'z Telegram ID'ingizni bilish uchun **@userinfobot**ga yozing.

## 3. Gemini API kaliti

[aistudio.google.com/apikey](https://aistudio.google.com/apikey) orqali
bepul Gemini API kalitini oling (imlo tuzatish, ovoz sintezi, sahna
promptlari uchun ishlatiladi — bularning barchasi bepul tarifda ishlaydi).

## 4. GitHub'da repo yaratish va kodni yuklash

1. github.com'da yangi **ochiq (Public)** repo yarating (masalan
   `ovoz-video-agent`)
2. Shu papkadagi barcha fayllarni (node_modules'siz) o'sha repoga yuklang
3. Repo **Settings → Secrets and variables → Actions** bo'limiga o'ting:
   - **Secrets** (maxfiy, hech kim ko'rmaydi) qo'shing:
     - `GEMINI_API_KEY`
     - `TELEGRAM_BOT_TOKEN`
     - `CLOUDFLARE_API_TOKEN` (1-qadamdagi token)
   - **Variables** (oddiy, maxfiy emas) qo'shing:
     - `TELEGRAM_ALLOWED_USER_IDS` — sizning Telegram ID'ingiz
     - `TELEGRAM_ADMIN_CHAT_ID` — xatolik xabarlarini qayerga yuborish (odatda xuddi shu ID)
     - `CLOUDFLARE_ACCOUNT_ID` (1-qadamdagi Account ID)

Shu bilan tayyor — **Actions** bo'limida "Ovoz video agent" workflow'i har 5
daqiqada avtomatik ishga tushadi. Birinchi marta qo'lda sinash uchun Actions
bo'limidan "Run workflow" tugmasini bosishingiz mumkin.

## Xatoliklarga chidamlilik (qisqacha)

Bu loyiha bir nechta tashqi xizmatlarga (Telegram, Gemini, Cloudflare, ffmpeg)
tayanadi — 100% "hech qachon xato chiqmaydi" degan narsa yo'q (masalan
Cloudflare'ning kunlik bepul limiti haqiqatan ham tugasa, bu haqiqiy tashqi
cheklov). Lekin har bir bosqich shunday qurilgan:

- **Tarmoq xatolari** (Telegram/Gemini/Cloudflare API'ga vaqtinchalik ulanish
  uzilishi) — avtomatik 2-3 marta qayta uriniladi (`src/retry.ts`), keyin
  aniq xabar.
- **Bitta xabarni qayta ishlashda xatolik** — boshqa xabarlarni/ishlarni
  to'xtatmaydi, admin darhol xabardor qilinadi, `lastUpdateId` baribir
  ilgarilaydi (bot cheksiz shu xabarga qaytmaydi).
- **Uzoq davom etadigan ish** — har bir qadamdan keyin holat darhol repo'ga
  saqlanadi (checkpoint), shuning uchun workflow vaqt limiti yoki kutilmagan
  uzilish holatida ham hech narsa yo'qolmaydi.
- **Video juda katta (Telegram 50MB limiti)** — avtomatik qayta siqiladi
  (1080p saqlanadi); siqilgandan keyin ham katta bo'lsa, foydalanuvchiga
  aniq aytiladi.
- **Foydalanuvchiga hech qachon xom (raw) texnik xato/stack trace
  ko'rsatilmaydi** — har doim o'zbekcha, tushunarli xabar.

## Fayl tuzilishi

```
.github/workflows/agent.yml   har 5 daqiqada ishga tushadigan workflow
src/
  config.ts                   muhit o'zgaruvchilari
  telegramApi.ts               Telegram Bot API (fetch, qayta urinish, fayl hajmi tekshiruvi bilan)
  state.ts                     oxirgi xabar raqami + kutilayotgan tanlovlar (repo'da, shifrlangan)
  crypto.ts                    state.json'dagi maxfiy maydonlarni shifrlash/ochish (AES-256-GCM)
  checkpoint.ts                holatni darhol saqlash + git commit/push (uzoq ishlar uchun)
  retry.ts                     umumiy "qayta urinish" yordamchisi (tarmoq xatolari uchun)
  runOnce.ts                    asosiy skript: bir marta tekshirib, kerak bo'lsa video yasaydi
  gemini.ts                     imlo tuzatish, TTS, sahna (rasm) promptlarini rejalashtirish
  wav.ts                        PCM -> WAV header
  pipeline/
    runJob.ts                   bitta hikoyani boshidan oxirigacha bajaradi
    imageGeneration.ts           Cloudflare Workers AI orqali sahna rasmini yaratadi (bepul)
    assembleVideo.ts             ffmpeg: rasm->Ken Burns video, concat, audio overlay, siqish
```
