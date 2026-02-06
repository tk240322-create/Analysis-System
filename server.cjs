console.log("### THIS IS server.cjs ###");
const express = require("express");
const multer = require("multer");
const fs = require("fs");

const app = express();
const PORT = 3000;
const mammoth = require("mammoth");
// ★ サーバ全体で共有されるキャッシュ
const evaluationCache = new Map();

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
      cb(new Error("PDF または DOCX のみ"));
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

    <div class="drop-zone" id="dropZone">
      ここに PDF / DOCX をドラッグ（最大2つ）
      <input type="file" name="files" multiple style="display:none"/>

    </div>

    <ul id="fileSlots">
      <li>未選択</li>
      <li>未選択</li>
    </ul>

    <button type="button" onclick="resetAll()">リセット</button>

    <button type="button" onclick="uploadFiles()">アップロード</button>

  </form>

  <hr>

  <ul id="savedList"></ul>

<script>
const dropZone = document.getElementById("dropZone");
const input = dropZone.querySelector("input");
const fileSlots = document.getElementById("fileSlots");

let selectedFiles = [];
const MAX_FILES = 2;

dropZone.addEventListener("click", () => input.click());

dropZone.addEventListener("dragover", e => {
  e.preventDefault();
  dropZone.classList.add("dragover");
});

dropZone.addEventListener("dragleave", () => {
  dropZone.classList.remove("dragover");
});

dropZone.addEventListener("drop", e => {
  e.preventDefault();
  dropZone.classList.remove("dragover");

  const file = e.dataTransfer.files[0];
  if (!file) return;

  if (selectedFiles.length >= MAX_FILES) {
    alert("ファイルは2つまでです");
    return;
  }

  selectedFiles.push(file);
  renderFileSlots();
});

input.addEventListener("change", () => {
  const file = input.files[0];
  if (!file) return;

  if (selectedFiles.length >= MAX_FILES) {
    alert("ファイルは2つまでです");
    input.value = "";
    return;
  }

  selectedFiles.push(file);
  renderFileSlots();
  input.value = "";
});

function renderFileSlots() {
  fileSlots.innerHTML = "";
  for (let i = 0; i < 2; i++) {
    const li = document.createElement("li");
    li.textContent = selectedFiles[i]
      ? selectedFiles[i].name
      : "未選択";
    fileSlots.appendChild(li);
  }
}

function resetAll() {
  selectedFiles = [];
  renderFileSlots();
}

async function uploadFiles() {
  if (selectedFiles.length !== 2) {
    alert("ファイルを2つ選んでください");
    return;
  }

 // ★ ローディング表示
  document.getElementById("loadingOverlay").style.display = "flex";

  const formData = new FormData();
  selectedFiles.forEach(f => formData.append("files", f));

  try {
    const res = await fetch("/upload", {
      method: "POST",
      body: formData
    });

    const html = await res.text();
    document.body.innerHTML = html;
   } catch (e) {
    alert("通信エラーが発生しました");
    console.error(e);
  }
}
</script>

<style>
.spinner {
  width: 40px;
  height: 40px;
  border: 4px solid #ccc;
  border-top: 4px solid #3498db;
  border-radius: 50%;
  animation: spin 1s linear infinite;
  margin: 0 auto 10px;
}

@keyframes spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}
</style>

<div id="loadingOverlay" style="
  display:none;
  position:fixed;
  top:0;
  left:0;
  width:100%;
  height:100%;
  background:rgba(255,255,255,0.8);
  z-index:9999;
  align-items:center;
  justify-content:center;
">
  <div style="text-align:center; font-size:18px;">
    <div class="spinner"></div>
    <p>評価中です…少々お待ちください</p>
  </div>
</div>

</body>
</html>
  `);
});

// --- Gemini API 呼び出し関数 ---
async function callLLM(prompt) {
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent" +
    `?key=${GEMINI_API_KEY}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 4000 } // 十分に大きく
    })
  });

  if (response.status === 429) {
    const errText = await response.text();
    throw new Error("現在Geminiが混雑しています。30秒ほど待ってから再実行してください。");
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
  upload.array("files", 2), // ★ ここが超重要
  async (req, res) => {
    try {
      console.log("### /upload CALLED ###");
      console.log(req.files);

      if (!req.files || req.files.length !== 2) {
        return res.status(400).send(`
          <h3>ファイルが不足しています</h3>
          <p>PDF / DOCX を2つアップロードしてください。</p>
          <a href="/">戻る</a>
        `);
      }

      const file1 = req.files[0];
      const file2 = req.files[1];

      const text1 = await extractText(file1);
      const text2 = await extractText(file2);

      const prompt = `
以下は2つのファイルです。

【ファイル1】
----
${text1.slice(0, 3000)}
----

【ファイル2】
----
${text2.slice(0, 6000)}
----

以下の内容を、
教員が印刷して配布できる
「評価報告書」形式で出力してください。

条件：
・丁寧語
・見出しを明確に
・箇条書きを適切に使用
・A4 1〜2枚を想定
・最後に総合評価を必ず記載
・最後に署名欄は不要です。

【前提】
本報告書は、第1週〜第3週の学習内容をまとめたものである。
以下の観点で評価せよ。

・各週の学習内容が大きく逸脱していないか
・週を通じた理解の深化や一貫性が見られるか
・単週評価ではなく、全体としての成長を重視すること
※文章は途中で省略されている可能性がある。全体構成と要点を重視して評価せよ。

【構成】
1. 評価概要
2. 学習理解度の評価
3. 良い点
4. 改善点・指導上の注意
5. 総合評価

【補足】
以下は評価上の減点対象とはしない前提条件である。
・１週目予定されていた「業務フロー」に関する内容は会社側の事情により実施されていない。
・GitHubの利用は、開発効率向上を目的として会社の指示により途中から導入された。
`;

      console.log("PROMPT LENGTH:", prompt.length);

      let evaluation;

      if (evaluationCache.has(prompt)) {
        console.log("🔥 cache hit");
        evaluation = evaluationCache.get(prompt);
      } else {
        console.log("🧠 Gemini call");
        evaluation = await callLLM(prompt);
        evaluationCache.set(prompt, evaluation);
      }

    res.send(`
    <!DOCTYPE html>
    <html lang="ja">
    <head>
    <meta charset="UTF-8">
    <title>評価報告書</title>
    <style>
      body {
        font-family: "Yu Mincho", "Hiragino Mincho Pro", serif;
        margin: 30mm;
        line-height: 1.8;
      }
      h1, h2 {
        border-bottom: 1px solid #333;
        padding-bottom: 4px;
      }
      .meta {
        margin-bottom: 20px;
        font-size: 14px;
      }
    </style>
    </head>
    <body>

    <h1>学習到達度評価レポート</h1>

    <div class="meta">
      作成日：${new Date().toLocaleDateString("ja-JP")}<br>
      本レポートは学習内容理解の参考評価として自動生成されたものです。
    </div>

    <div class="content">
      ${evaluation.replace(/\n/g, "<br>")}
    </div>

    </body>
    </html>
    `);

  } catch (err) {
      console.error("UPLOAD ERROR:", err);
      res.status(500).send(`
        <h3>エラーが発生しました</h3>
        <pre>${err.message}</pre>
        <a href="/">戻る</a>
      `);
    }
});

// サーバ起動
app.listen(PORT, () => {
  console.log(`サーバー起動：http://localhost:${PORT}`);
  // ハ＾さんはコメントします。
});
