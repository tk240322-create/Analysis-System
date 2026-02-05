console.log("### THIS IS server.cjs ###");
const express = require("express");
const multer = require("multer");
const fs = require("fs");

const app = express();
const PORT = 3000;
const mammoth = require("mammoth");

// アップロード先
const uploadDir = "uploads";

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => {
    cb(null, file.originalname);
  }
});

const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    if (
      file.mimetype === "application/pdf" ||
      file.mimetype ===
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ) {
      cb(null, true);
    } else {
      cb(new Error("PDF または DOCX ファイルのみアップロード可能です"));
    }
  }
});


// 画面
app.get("/", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<title>学習到達度自動分析システム</title>
<style>
  body {
    font-family: sans-serif;
  }
  .drop-zone {
    border: 2px dashed #888;
    border-radius: 10px;
    padding: 20px;
    margin-bottom: 20px;
    text-align: center;
    background: #fafafa;
  }
  .drop-zone.dragover {
    background: #e0f0ff;
    border-color: #3399ff;
  }
</style>
</head>

<body>
  <h2>学習到達度自動分析システム</h2>

  <form method="POST" action="/upload" enctype="multipart/form-data">

    <div class="drop-zone" id="curriculumZone">
      <strong>カリキュラム</strong><br>
      PDF / DOCX をドラッグ＆ドロップ<br>
      <input type="file" name="curriculum" accept=".pdf,.docx" hidden>
      <div class="filename"></div>
    </div>

    <div class="drop-zone" id="reportZone">
      <strong>日報</strong><br>
      PDF / DOCX をドラッグ＆ドロップ<br>
      <input type="file" name="report" accept=".pdf,.docx" hidden>
      <div class="filename"></div>
    </div>

    <button type="submit">アップロードして評価</button>
  </form>

<script>
function setupDropZone(zone) {
  const input = zone.querySelector("input");
  const filename = zone.querySelector(".filename");

  zone.addEventListener("click", () => {
    input.click();
  });

  zone.addEventListener("dragover", e => {
    e.preventDefault();
    zone.classList.add("dragover");
  });

  zone.addEventListener("dragleave", () => {
    zone.classList.remove("dragover");
  });

  zone.addEventListener("drop", e => {
    e.preventDefault();
    zone.classList.remove("dragover");

    const file = e.dataTransfer.files[0];
    if (!file) return;

    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;

    // D&D では change が出ないので手動発火
    input.dispatchEvent(new Event("change"));
  });

  // 表示は input の状態だけを見る
  input.addEventListener("change", () => {
    if (input.files.length > 0) {
      filename.textContent = "選択済み: " + input.files[0].name;
      filename.style.color = "green";
    } else {
      filename.textContent = "未選択";
      filename.style.color = "red";
    }
  });
}

setupDropZone(document.getElementById("curriculumZone"));
setupDropZone(document.getElementById("reportZone"));
</script>

</body>
</html>
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

// --- PDFテキスト抽出（buffer前提） ---
const path = require("path");

async function extractPdfTextFromBuffer(buffer) {
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");

  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(buffer),

    // ★ ここが重要：必ず末尾 /
    standardFontDataUrl:
      path.join(__dirname, "node_modules/pdfjs-dist/standard_fonts") + "/",

    cMapUrl:
      path.join(__dirname, "node_modules/pdfjs-dist/cmaps") + "/",

    cMapPacked: true
  });

  const pdf = await loadingTask.promise;

  let text = "";

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map(item => item.str).join(" ") + "\n";
  }

  return text;
}

// --- ファイル種別に応じたテキスト抽出 ---
async function extractText(file) {
  // PDF
  if (file.mimetype === "application/pdf") {
    return await extractPdfTextFromBuffer(file.buffer);
  }

  // DOCX
  if (
    file.mimetype ===
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    const result = await mammoth.extractRawText({
      buffer: file.buffer
    });
    return result.value;
  }

  throw new Error("未対応のファイル形式です");
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

      if (!req.files?.curriculum || !req.files?.report) {
        return res.status(400).send(`
          <h3>ファイルが不足しています</h3>
          <p>カリキュラムと日報の両方をアップロードしてください。</p>
          <a href="/">戻る</a>
        `);
      }

      const curriculumFile = req.files.curriculum[0];
      const reportFile     = req.files.report[0];

      const curriculumText = await extractText(curriculumFile);
      const reportText     = await extractText(reportFile);

      // --- Geminiプロンプト作成 ---
      const LLM_INPUT_LIMIT = 3000;
      const prompt = `
以下は2つのファイルから抽出したテキストです（一部）。

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
        console.error("### ERROR ###");
        console.error(err);

        res.status(500).send(`
          <h3>エラーが発生しました</h3>
          <pre>${err.message}</pre>
          <a href="/">戻る</a>
        `);
      }
  }
);

// サーバ起動
app.listen(PORT, () => {
  console.log(`サーバー起動：http://localhost:${PORT}`);
  // ハ＾さんはコメントします。
});
