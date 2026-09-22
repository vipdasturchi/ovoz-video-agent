import "dotenv/config";
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

/**
 * Run once, interactively, on this Mac (needs a display):
 *   npm run login:flow
 *
 * Opens a real, visible Chromium window at flow.google.com. Log into the
 * Google account you'll use for Flow (a DEDICATED account, not your main
 * one — see README) by hand, open/create a Flow project, then come back to
 * this terminal and press Enter.
 *
 * Prints a base64 string — paste it as the FLOW_STORAGE_STATE secret in the
 * GitHub repo (Settings -> Secrets and variables -> Actions). Google
 * sessions eventually expire; re-run this and update the secret when Flow
 * automation starts failing with a login error.
 */
async function main() {
  const outPath = path.resolve("./flow-storage-state.local.json");

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto("https://flow.google.com/");

  console.log("\nBrauzerda Google hisobingizga kiring va Flow loyihasini oching (yoki yangi loyiha yarating).");
  console.log("Tayyor bo'lgach, shu yerga qaytib Enter bosing...\n");

  await new Promise<void>((resolve) => {
    process.stdin.resume();
    process.stdin.once("data", () => resolve());
  });

  await context.storageState({ path: outPath });
  const base64 = fs.readFileSync(outPath).toString("base64");

  console.log(`\nSessiya faylga saqlandi: ${outPath} (bu faylni git'ga qo'shmang — .gitignore allaqachon bloklaydi)\n`);
  console.log("Quyidagi qatorni GitHub repo -> Settings -> Secrets and variables -> Actions -> New repository secret");
  console.log("Nomi: FLOW_STORAGE_STATE   Qiymati (pastdagi butun qatorni nusxalang):\n");
  console.log(base64);
  console.log("\n");

  await browser.close();
  process.exit(0);
}

main();
