console.log("### THIS IS server.cjs ###");
const express = require("express");
const multer = require("multer");
const fs = require("fs");

const app = express();
const PORT = 3000;

// アップロード先
const uploadDir = "uploads";

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => {
    cb(null, file.originalname);
  }
});

const upload = multer({ storage });

// 画面
app.get("/", (req, res) => {
  res.send(`
    <h2>PDFアップロード</h2>
    <form method="POST" action="/upload" enctype="multipart/form-data">
      <label>カリキュラム PDF:</label><br>
      <input type="file" name="curriculum" accept=".pdf" /><br><br>
      <label>日報 PDF:</label><br>
      <input type="file" name="report" accept=".pdf" /><br><br>
      <button type="submit">アップロードして評価</button>
    </form>
  `);
});

// --- Gemini API 呼び出し関数 ---
async function callLLM(prompt) {
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent" +
    `?key=${GEMINI_API_KEY}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 4000 } // 十分に大きく
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini API error: ${response.status} ${errText}`);
  }

  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  return text || "評価不能";
}

// --- PDFテキスト抽出関数 ---
async function extractText(pdfjsLib, fileData) {
  const loadingTask = pdfjsLib.getDocument({
    data: fileData,
    cMapUrl: "node_modules/pdfjs-dist/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "node_modules/pdfjs-dist/standard_fonts/"
  });
  const pdf = await loadingTask.promise;
  let text = "";
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map(item => item.str).join(" ") + "\n";
  }
  return text.trim();
}

// アップロード処理
app.post(
  "/upload",
  upload.fields([
    { name: "curriculum", maxCount: 1 },
    { name: "report", maxCount: 1 }
  ]),
  async (req, res) => {
    try {
      console.log("### /upload CALLED ###");
      console.log(req.files);

      const curriculumPath = req.files.curriculum[0].path;
      const reportPath     = req.files.report[0].path;

      const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");

      const curriculumData = new Uint8Array(fs.readFileSync(curriculumPath));
      const reportData     = new Uint8Array(fs.readFileSync(reportPath));

      const curriculumText = await extractText(pdfjsLib, curriculumData);
      const reportText     = await extractText(pdfjsLib, reportData);

      // --- Geminiプロンプト作成 ---
      const LLM_INPUT_LIMIT = 3000;
      const prompt = `
以下は2つのPDFから抽出したテキストです（一部）。

【カリキュラム】
----
${curriculumText.slice(0, LLM_INPUT_LIMIT)}
----

【日報】
----
${reportText.slice(0, LLM_INPUT_LIMIT)}
----

質問：
1. 日報はカリキュラムの内容を正しく反映していますか？
2. 学習・理解の度合いはどうですか？
3. 改善点や注意点があれば挙げてください。

上記を文章で詳細かつ簡潔に答えてください。
`;

      // --- Gemini呼び出し ---
      const evaluation = await callLLM(prompt);

      // --- HTML表示 ---
      res.send(`
        <h2>PDF 比較評価結果</h2>
        <div style="background:#f4f4f4; padding:15px; border-radius:8px; white-space:pre-wrap;">
${evaluation}
        </div>
        <br>
        <a href="/">← 戻る</a>
      `);

    } catch (err) {
      console.error(err);
      res.status(500).send("PDFの読み取りまたは評価に失敗しました");
    }
  }
);

// サーバ起動
app.listen(PORT, () => {
  console.log(`サーバー起動：http://localhost:${PORT}`);
});
