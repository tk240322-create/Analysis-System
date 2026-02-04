import { chromium } from "playwright";

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  // ① 自分のローカルサイトにアクセス
  await page.goto("http://localhost:3000");

  // ② ファイルをセット
  await page.setInputFiles(
    "input[type='file']",
    "C:/Users/iwamura/Downloads/インターン生実習内容 (1).pdf"
  );

  // ③ アップロードボタンをクリック
  await page.click("button[type='submit']");

  // ④ 結果確認用に少し待つ
  await page.waitForTimeout(5000);

  await browser.close();
})();
