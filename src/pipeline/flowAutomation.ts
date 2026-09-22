import { chromium, type Browser, type Page } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.ts";

/**
 * Drives https://flow.google.com through the real browser UI (Flow has no
 * public API for this). This is inherently fragile: it depends on Flow's
 * current DOM/accessibility tree, which can change without notice and break
 * every selector below. Before trusting this unattended, run it once with
 * `headless: false` (see runFlowJob's `headed` option) and watch it work.
 *
 * Selector strategy: everything is matched by accessible role + name (the
 * same strings a screen reader would announce), never by CSS class, because
 * Flow's own JS blocks generic DOM/class inspection on this page. The known
 * "chrome" button names below were captured by hand from the live app on
 * 2026-09-22 (Uzbek locale) — update this list if Flow's UI copy changes.
 */

const KNOWN_CHROME_BUTTON_NAMES = new Set([
  "Uy",
  "Barcha media fayllar",
  "Qahramonlar",
  "Sahnalar",
  "Vositalar",
  "Chiqitdon",
  "Yopish",
  "Qidiruv",
  "Filtrlash va saralash parametrlari",
  "Media qoʻshish menyusi",
  "Mahsulot boʻyicha yordam",
  "Katakcha jadvali sozlamalari",
  "Yana",
  "Hisob tafsilotlari",
  "Loyiha uchun boshqa parametrlar",
  "Soʻrov maydoniga materiallarni kiriting",
  "Sozlamalar triggeri",
  "Yaratishni boshlash",
  "Avvalgi sahifaga qaytish uchun orqaga tugmasi",
  "Videolar",
]);

export class FlowQuotaError extends Error {}
export class FlowAutomationError extends Error {}

export interface FlowSceneResult {
  index: number;
  prompt: string;
  filePath: string;
}

export interface FlowJobOptions {
  jobDir: string;
  prompts: string[];
  headed?: boolean;
  perSceneTimeoutMs?: number;
}

function isChromeButton(name: string | null): boolean {
  if (!name) return true;
  if (KNOWN_CHROME_BUTTON_NAMES.has(name)) return true;
  if (name.startsWith("Google hisobi")) return true;
  return false;
}

async function listContentThumbnails(page: Page) {
  const buttons = page.getByRole("button");
  const count = await buttons.count();
  const items: { index: number; name: string }[] = [];
  for (let i = 0; i < count; i++) {
    const name = await buttons.nth(i).getAttribute("aria-label").catch(() => null);
    const accessibleName = name ?? (await buttons.nth(i).innerText().catch(() => ""));
    if (!isChromeButton(accessibleName)) {
      items.push({ index: i, name: accessibleName });
    }
  }
  return items;
}

async function submitPrompt(page: Page, prompt: string) {
  const composerPlaceholder = page.getByText("Nima yaratilishi kerak?", { exact: true });
  await composerPlaceholder.click({ timeout: 15000 });
  await page.keyboard.type(prompt, { delay: 5 });

  const submitButton = page.getByRole("button", { name: "Yaratishni boshlash" });
  await submitButton.click({ timeout: 10000 });
}

async function detectQuotaError(page: Page): Promise<string | null> {
  const bodyText = await page.locator("body").innerText().catch(() => "");
  // Deliberately specific multi-word phrases — a bare word like "tugadi"
  // ("finished") also appears in ordinary success text and would false-positive.
  const quotaMarkers = [
    "kvota tugadi",
    "limit tugadi",
    "kunlik limit",
    "oylik limit",
    "generatsiya limiti",
    "resource_exhausted",
    "quota exceeded",
    "rate limit exceeded",
    "too many requests",
  ];
  const lower = bodyText.toLowerCase();
  const hit = quotaMarkers.find((m) => lower.includes(m));
  return hit ? bodyText.slice(0, 400) : null;
}

async function waitForNewestSceneReady(page: Page, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  // Give Flow a moment to insert the new (generating) thumbnail.
  await page.waitForTimeout(3000);

  while (Date.now() < deadline) {
    const thumbnails = await listContentThumbnails(page);
    if (thumbnails.length === 0) {
      await page.waitForTimeout(3000);
      continue;
    }
    const newest = thumbnails[0];
    const hasPercent = /\d{1,3}\s?%/.test(newest.name);
    if (!hasPercent) return;

    const quota = await detectQuotaError(page);
    if (quota) throw new FlowQuotaError(`Flow limitga uchradi: ${quota}`);

    await page.waitForTimeout(4000);
  }

  throw new FlowAutomationError(`Sahna ${timeoutMs / 1000}s ichida tayyor bo'lmadi (Flow generatsiyasi juda uzoq davom etmoqda yoki osilib qoldi).`);
}

async function openNewestScene(page: Page) {
  const thumbnails = await listContentThumbnails(page);
  if (thumbnails.length === 0) throw new FlowAutomationError("Galereyada hech qanday video topilmadi.");
  const newest = page.getByRole("button", { name: thumbnails[0].name, exact: true }).first();
  await newest.click({ timeout: 10000 });
}

async function downloadCurrentSceneAt1080p(page: Page, destPath: string) {
  const downloadButton = page.getByRole("button", { name: "Mediani yuklab olish" });
  await downloadButton.click({ timeout: 10000 });

  const menuItem1080 = page.getByRole("menuitem").filter({ hasText: "1080p" });
  await menuItem1080.waitFor({ state: "visible", timeout: 10000 });

  const downloadPromise = page.waitForEvent("download", { timeout: 5 * 60 * 1000 });
  await menuItem1080.click();
  const download = await downloadPromise;
  await download.saveAs(destPath);
}

async function goBackToGallery(page: Page) {
  const backButton = page.getByRole("button", { name: "Avvalgi sahifaga qaytish uchun orqaga tugmasi" });
  if (await backButton.isVisible().catch(() => false)) {
    await backButton.click({ timeout: 10000 });
    await page.waitForTimeout(1000);
  }
}

export async function runFlowJob(opts: FlowJobOptions): Promise<FlowSceneResult[]> {
  const { jobDir, prompts, headed = false, perSceneTimeoutMs = 4 * 60 * 1000 } = opts;

  let storageState: NonNullable<Parameters<Browser["newContext"]>[0]>["storageState"];
  try {
    storageState = JSON.parse(Buffer.from(config.flowStorageState, "base64").toString("utf8"));
  } catch {
    throw new FlowAutomationError(
      "FLOW_STORAGE_STATE noto'g'ri formatda. `npm run login:flow` natijasidagi base64 qatorni qayta tekshiring."
    );
  }

  const clipsDir = path.join(jobDir, "clips");
  fs.mkdirSync(clipsDir, { recursive: true });

  let browser: Browser | null = null;
  const results: FlowSceneResult[] = [];

  try {
    browser = await chromium.launch({ headless: !headed });
    const context = await browser.newContext({
      storageState,
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();

    await page.goto(config.flowProjectUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);

    for (let i = 0; i < prompts.length; i++) {
      const prompt = prompts[i];

      await submitPrompt(page, prompt);
      await waitForNewestSceneReady(page, perSceneTimeoutMs);
      await openNewestScene(page);

      const destPath = path.join(clipsDir, `scene-${String(i + 1).padStart(2, "0")}.mp4`);
      await downloadCurrentSceneAt1080p(page, destPath);
      await goBackToGallery(page);

      results.push({ index: i, prompt, filePath: destPath });
    }

    await context.close();
  } finally {
    await browser?.close();
  }

  return results;
}
