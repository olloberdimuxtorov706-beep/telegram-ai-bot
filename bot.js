const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { URL } = require('url');

// Ixtiyoriy ofis paketlari (Render'da package.json orqali avtomatik o'rnatiladi)
let docxPkg = null;
let pptxPkg = null;
let excelPkg = null;

try { docxPkg = require('docx'); } catch (e) {}
try { pptxPkg = require('pptxgenjs'); } catch (e) {}
try { excelPkg = require('exceljs'); } catch (e) {}

const CONFIG_PATH = path.join(__dirname, 'config.json');

// Konfiguratsiyani yuklash
function loadConfig() {
  let fileConfig = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    } catch (e) {}
  }
  return {
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || fileConfig.TELEGRAM_BOT_TOKEN || "",
    GEMINI_API_KEY: process.env.GEMINI_API_KEY || fileConfig.GEMINI_API_KEY || "",
    ALLOWED_USER_IDS: []
  };
}

let config = loadConfig();

if (!config.TELEGRAM_BOT_TOKEN || config.TELEGRAM_BOT_TOKEN.includes("BOT_TOKENINGIZNI")) {
  console.log("DIQQAT: Telegram bot tokeni kiritilmagan!");
  process.exit(1);
}

// Bulutli serverlar uchun HTTP server
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<h3>Telegram AI Bot (Word + Excel + PowerPoint + Rasm + Ovoz) 24/7 faol! 🚀</h3>');
}).listen(PORT, () => {
  console.log(`Cloud HTTP Server ${PORT}-portda ishlamoqda.`);
});

const TELEGRAM_API = `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}`;
const userHistories = new Map();

// IPv4 orqali HTTPS so'rov
function httpsRequest(urlStr, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const headers = options.headers || {};

    let payload = null;
    if (body) {
      payload = typeof body === 'string' ? Buffer.from(body) : Buffer.from(JSON.stringify(body));
      headers['Content-Length'] = payload.length;
      if (!headers['Content-Type']) {
        headers['Content-Type'] = 'application/json';
      }
    }

    const req = https.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method: options.method || (body ? 'POST' : 'GET'),
      headers: headers,
      family: 4,
      timeout: options.timeout || 45000,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const fullBuf = Buffer.concat(chunks);
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          buffer: () => fullBuf,
          text: () => fullBuf.toString('utf-8'),
          json: () => {
            try {
              return JSON.parse(fullBuf.toString('utf-8'));
            } catch (e) {
              return { error: { message: fullBuf.toString('utf-8') } };
            }
          }
        });
      });
    });

    req.on('timeout', () => req.destroy(new Error('Timeout')));
    req.on('error', reject);

    if (payload) req.write(payload);
    req.end();
  });
}

// Telegram API so'rovi
async function telegramRequest(method, data = {}) {
  const url = `${TELEGRAM_API}/${method}`;
  try {
    const res = await httpsRequest(url, { method: 'POST' }, data);
    return res.json();
  } catch (err) {
    console.error(`Telegram API xatoligi (${method}):`, err.message);
    return { ok: false, description: err.message };
  }
}

// Telegramga fayl (Word, Excel, PPT) yuborish (Multipart form)
function sendTelegramDocument(chatId, buffer, filename, caption = "", mimeType = "application/octet-stream") {
  return new Promise((resolve, reject) => {
    const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
    const CRLF = '\r\n';

    const head = Buffer.from(
      `--${boundary}${CRLF}` +
      `Content-Disposition: form-data; name="chat_id"${CRLF}${CRLF}` +
      `${chatId}${CRLF}` +
      (caption ? `--${boundary}${CRLF}Content-Disposition: form-data; name="caption"${CRLF}${CRLF}${caption}${CRLF}` : '') +
      `--${boundary}${CRLF}` +
      `Content-Disposition: form-data; name="document"; filename="${filename}"${CRLF}` +
      `Content-Type: ${mimeType}${CRLF}${CRLF}`
    );

    const tail = Buffer.from(`${CRLF}--${boundary}--${CRLF}`);
    const fullBody = Buffer.concat([head, buffer, tail]);

    const req = https.request({
      hostname: 'api.telegram.org',
      port: 443,
      path: `/bot${config.TELEGRAM_BOT_TOKEN}/sendDocument`,
      method: 'POST',
      family: 4,
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': fullBody.length
      },
      timeout: 60000
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve({ ok: false, error: e.message });
        }
      });
    });

    req.on('timeout', () => req.destroy(new Error('Timeout')));
    req.on('error', reject);
    req.write(fullBody);
    req.end();
  });
}

// Telegram faylini yuklab olib, Base64 ga o'girish
async function downloadTelegramFileAsBase64(filePath) {
  const url = `${TELEGRAM_FILE_API}/${filePath}`;
  const res = await httpsRequest(url, { method: 'GET', timeout: 60000 });
  if (res.statusCode !== 200) {
    throw new Error(`Faylni yuklab bo'lmadi (HTTP ${res.statusCode})`);
  }
  return res.buffer().toString('base64');
}

// Xabarni bo'laklab yuborish
async function sendLongMessage(chatId, text) {
  const MAX_LENGTH = 4000;
  if (text.length <= MAX_LENGTH) {
    return await telegramRequest('sendMessage', {
      chat_id: chatId,
      text: text,
    });
  }

  for (let i = 0; i < text.length; i += MAX_LENGTH) {
    const chunk = text.substring(i, i + MAX_LENGTH);
    await telegramRequest('sendMessage', {
      chat_id: chatId,
      text: chunk,
    });
    await new Promise((r) => setTimeout(r, 250));
  }
}

// Harakat holati
async function sendChatAction(chatId, action = 'typing') {
  await telegramRequest('sendChatAction', {
    chat_id: chatId,
    action: action,
  });
}

// Modellar ro'yxati
const AVAILABLE_MODELS = [
  'gemini-3.5-flash-lite',
  'gemini-flash-lite-latest',
  'gemini-flash-latest',
  'gemini-3.6-flash'
];

// Gemini orqali rasm promptini yaratish
async function generateImagePromptWithGemini(userText) {
  const apiKey = config.GEMINI_API_KEY;
  const prompt = `Foydalanuvchi rasm chizishni so'ramoqda: "${userText}".
Sun'iy intellekt uchun yuqori sifatli, batafsil INGLIZCHA prompt tuzib ber.
Javobda FAQAT INGLIZCHA PROMPT matnini qaytar, boshqa hech narsa bo'lmasin.`;

  for (const modelName of AVAILABLE_MODELS) {
    try {
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
      const res = await httpsRequest(endpoint, { method: 'POST', timeout: 30000 }, {
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 250 }
      });
      const data = res.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (text) return text.replace(/["\n\r]/g, ' ').trim();
    } catch (e) {}
  }
  return userText;
}

// Rasm yaratish
async function handleImageGeneration(chatId, promptText) {
  await sendChatAction(chatId, 'upload_photo');
  const actionInterval = setInterval(() => sendChatAction(chatId, 'upload_photo'), 3500);

  try {
    const englishPrompt = await generateImagePromptWithGemini(promptText);
    const cleanPrompt = encodeURIComponent(englishPrompt);
    const seed = Math.floor(Math.random() * 999999);
    const imageUrl = `https://image.pollinations.ai/prompt/${cleanPrompt}?width=1024&height=1024&nologo=true&seed=${seed}`;

    const res = await telegramRequest('sendPhoto', {
      chat_id: chatId,
      photo: imageUrl,
      caption: `🎨 **Siz so'ragan rasm tayyorlandi!**\n\n📝 *Tavsif:* ${englishPrompt.slice(0, 300)}`
    });

    clearInterval(actionInterval);
    if (!res.ok) throw new Error(res.description || "Rasmni yuborib bo'lmadi");
  } catch (err) {
    clearInterval(actionInterval);
    console.error("Rasm yaratish xatosi:", err.message);
    await telegramRequest('sendMessage', {
      chat_id: chatId,
      text: `Kechirasiz, rasm yaratishda xatolik yuz berdi: ${err.message}`
    });
  }
}

// -------------------------------------------------------------
// OFIS HUJJATLARI: WORD, POWERPOINT, EXCEL
// -------------------------------------------------------------

// Gemini'dan strukturaviy JSON olish yordamchisi
async function getJsonFromGemini(systemPrompt, userPrompt) {
  const apiKey = config.GEMINI_API_KEY;
  for (const modelName of AVAILABLE_MODELS) {
    try {
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
      const res = await httpsRequest(endpoint, { method: 'POST', timeout: 45000 }, {
        contents: [{ role: "user", parts: [{ text: userPrompt }] }],
        systemInstruction: { parts: [{ text: systemPrompt }] },
        generationConfig: {
          temperature: 0.3,
          responseMimeType: "application/json"
        }
      });
      const data = res.json();
      const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (rawText) {
        return JSON.parse(rawText);
      }
    } catch (e) {
      console.warn("JSON olish xatosi:", e.message);
    }
  }
  return null;
}

// 1. WORD (.docx) YARATISH
async function handleWordGeneration(chatId, userText) {
  await sendChatAction(chatId, 'upload_document');
  const actionInterval = setInterval(() => sendChatAction(chatId, 'upload_document'), 3500);

  try {
    if (!docxPkg) {
      docxPkg = require('docx');
    }

    const sysPrompt = `Sen professional Word hujjatlari tuzuvchi mutaxassissan. Foydalanuvchi so'roviga asosan mukammal o'zbek tilida hujjat tuzib ber.
Javobni quyidagi JSON sxemasida qaytar:
{
  "title": "Hujjat bosh sarlavhasi",
  "subtitle": "Kichik izoh yoki sana",
  "sections": [
    {
      "heading": "Bo'lim sarlavhasi",
      "paragraphs": ["Paragraf matni 1", "Paragraf matni 2"],
      "bullets": ["Band 1", "Band 2"]
    }
  ]
}`;

    const docData = await getJsonFromGemini(sysPrompt, `Ushbu mavzuda to'liq, mazmunli Word hujjati tuzib ber: ${userText}`);
    if (!docData) throw new Error("Hujjat matnini shakllantirib bo'lmadi.");

    const { Document, Packer, Paragraph, TextRun, HeadingLevel } = docxPkg;
    const children = [];

    if (docData.title) {
      children.push(new Paragraph({
        text: docData.title,
        heading: HeadingLevel.TITLE,
        spacing: { after: 200 }
      }));
    }

    if (docData.subtitle) {
      children.push(new Paragraph({
        children: [new TextRun({ text: docData.subtitle, italics: true, color: "555555" })],
        spacing: { after: 300 }
      }));
    }

    for (const sec of docData.sections || []) {
      if (sec.heading) {
        children.push(new Paragraph({
          text: sec.heading,
          heading: HeadingLevel.HEADING_1,
          spacing: { before: 240, after: 120 }
        }));
      }
      for (const p of sec.paragraphs || []) {
        children.push(new Paragraph({
          children: [new TextRun({ text: p, size: 24 })],
          spacing: { after: 120 }
        }));
      }
      for (const b of sec.bullets || []) {
        children.push(new Paragraph({
          text: b,
          bullet: { level: 0 },
          spacing: { after: 80 }
        }));
      }
    }

    const doc = new Document({
      sections: [{ properties: {}, children: children }]
    });

    const buffer = await Packer.toBuffer(doc);
    clearInterval(actionInterval);

    const filename = `${docData.title ? docData.title.slice(0, 30).replace(/[^a-zA-Z0-9]/g, '_') : 'hujjat'}.docx`;
    await sendTelegramDocument(
      chatId,
      buffer,
      filename,
      `📄 **Word hujjatingiz tayyorlandi!**\n\n📌 *Mavzu:* ${docData.title || userText}`,
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
  } catch (err) {
    clearInterval(actionInterval);
    console.error("Word xatosi:", err.message);
    await telegramRequest('sendMessage', {
      chat_id: chatId,
      text: `Word hujjatini tayyorlashda xatolik: ${err.message}`
    });
  }
}

// 2. POWERPOINT (.pptx) YARATISH
async function handlePowerPointGeneration(chatId, userText) {
  await sendChatAction(chatId, 'upload_document');
  const actionInterval = setInterval(() => sendChatAction(chatId, 'upload_document'), 3500);

  try {
    if (!pptxPkg) {
      pptxPkg = require('pptxgenjs');
    }

    const sysPrompt = `Sen professional taqdimotlar tuzuvchisan. Foydalanuvchi mavzusi bo'yicha 5-7 slayddan iborat taqdimot tuz.
Javobni quyidagi JSON sxemasida qaytar:
{
  "title": "Taqdimot asosiy nomi",
  "subtitle": "Qisqacha ta'rif",
  "slides": [
    {
      "title": "Slayd sarlavhasi",
      "bullets": ["Asosiy fikr 1", "Asosiy fikr 2", "Asosiy fikr 3"]
    }
  ]
}`;

    const pptData = await getJsonFromGemini(sysPrompt, `Ushbu mavzuda taqdimot slaydlari tuz: ${userText}`);
    if (!pptData) throw new Error("Taqdimot matnini shakllantirib bo'lmadi.");

    const pres = new pptxPkg();
    pres.layout = 'LAYOUT_16x9';

    // Bosh slayd
    const slide1 = pres.addSlide();
    slide1.background = { color: '1A365D' };
    slide1.addText(pptData.title || "Taqdimot", {
      x: 0.5, y: 2.0, w: '90%', h: 1.5,
      fontSize: 36, bold: true, color: 'FFFFFF', align: 'center'
    });
    if (pptData.subtitle) {
      slide1.addText(pptData.subtitle, {
        x: 0.5, y: 3.5, w: '90%', h: 1.0,
        fontSize: 20, color: 'CBD5E0', align: 'center'
      });
    }

    // Tarkibiy slaydlar
    for (const s of pptData.slides || []) {
      const slide = pres.addSlide();
      slide.background = { color: 'F7FAFC' };

      slide.addShape(pres.shapes.RECTANGLE, {
        x: 0, y: 0, w: '100%', h: 1.1,
        fill: { color: '2B6CB0' }
      });
      slide.addText(s.title || "Mavzu", {
        x: 0.8, y: 0.2, w: '85%', h: 0.7,
        fontSize: 24, bold: true, color: 'FFFFFF'
      });

      if (s.bullets && s.bullets.length > 0) {
        const bulletItems = s.bullets.map(b => ({ text: b, options: { bullet: true, breakLine: true } }));
        slide.addText(bulletItems, {
          x: 0.8, y: 1.5, w: '85%', h: 5.0,
          fontSize: 18, color: '2D3748', lineSpacing: 32
        });
      }
    }

    const buffer = await pres.write({ outputType: 'nodebuffer' });
    clearInterval(actionInterval);

    const filename = `${pptData.title ? pptData.title.slice(0, 30).replace(/[^a-zA-Z0-9]/g, '_') : 'taqdimot'}.pptx`;
    await sendTelegramDocument(
      chatId,
      buffer,
      filename,
      `📊 **PowerPoint taqdimotingiz tayyorlandi!**\n\n📌 *Mavzu:* ${pptData.title || userText}`,
      "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    );
  } catch (err) {
    clearInterval(actionInterval);
    console.error("PPT xatosi:", err.message);
    await telegramRequest('sendMessage', {
      chat_id: chatId,
      text: `PowerPoint taqdimotini tayyorlashda xatolik: ${err.message}`
    });
  }
}

// 3. EXCEL (.xlsx) YARATISH
async function handleExcelGeneration(chatId, userText) {
  await sendChatAction(chatId, 'upload_document');
  const actionInterval = setInterval(() => sendChatAction(chatId, 'upload_document'), 3500);

  try {
    if (!excelPkg) {
      excelPkg = require('exceljs');
    }

    const sysPrompt = `Sen ma'lumotlar va jadvallar bo'yicha mutaxassissan. Foydalanuvchi so'roviga ko'ra mukammal Excel jadvali tuz.
Javobni quyidagi JSON sxemasida qaytar:
{
  "title": "Jadval umumiy nomi",
  "sheetName": "Varaq nomi",
  "headers": ["Ustun 1", "Ustun 2", "Ustun 3", "Ustun 4"],
  "rows": [
    ["Qiymat 1", "Qiymat 2", 100, 200],
    ["Qiymat 3", "Qiymat 4", 300, 400]
  ]
}`;

    const excelData = await getJsonFromGemini(sysPrompt, `Ushbu mavzuda to'liq Excel jadvali tuz: ${userText}`);
    if (!excelData) throw new Error("Excel ma'lumotlarini shakllantirib bo'lmadi.");

    const workbook = new excelPkg.Workbook();
    const worksheet = workbook.addWorksheet(excelData.sheetName || 'Jadval');

    if (excelData.headers && excelData.headers.length > 0) {
      const headerRow = worksheet.addRow(excelData.headers);
      headerRow.font = { name: 'Arial', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
      headerRow.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF1F497D' }
      };
      headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
    }

    for (const r of excelData.rows || []) {
      worksheet.addRow(r);
    }

    worksheet.columns.forEach(column => {
      let maxLength = 12;
      column.eachCell({ includeEmpty: true }, cell => {
        const val = cell.value ? cell.value.toString() : '';
        if (val.length > maxLength) maxLength = Math.min(val.length + 4, 45);
      });
      column.width = maxLength;
    });

    const buffer = await workbook.xlsx.writeBuffer();
    clearInterval(actionInterval);

    const filename = `${excelData.title ? excelData.title.slice(0, 30).replace(/[^a-zA-Z0-9]/g, '_') : 'jadval'}.xlsx`;
    await sendTelegramDocument(
      chatId,
      buffer,
      filename,
      `📈 **Excel jadvalingiz tayyorlandi!**\n\n📌 *Mavzu:* ${excelData.title || userText}`,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
  } catch (err) {
    clearInterval(actionInterval);
    console.error("Excel xatosi:", err.message);
    await telegramRequest('sendMessage', {
      chat_id: chatId,
      text: `Excel jadvalini tayyorlashda xatolik: ${err.message}`
    });
  }
}

// Gemini API chaqiruvi (Oddiy suhbat yoki ovoz)
async function askGemini(chatId, userParts, historyDescription = "") {
  const apiKey = config.GEMINI_API_KEY;
  if (!apiKey || apiKey.includes("GEMINI_API_KALITINGIZNI")) {
    return "Xatolik: config.json faylida 'GEMINI_API_KEY' kiritilmagan.";
  }

  if (!userHistories.has(chatId)) {
    userHistories.set(chatId, []);
  }
  const history = userHistories.get(chatId);

  const currentTurn = {
    role: "user",
    parts: userParts
  };
  const contentsToSend = [...history, currentTurn];

  const requestBody = {
    contents: contentsToSend,
    systemInstruction: {
      parts: [
        {
          text: "Sen har tomonlama aqlli, do'stona va mohir sun'iy intellekt assistentisan. Foydalanuvchi yozma, ovozli xabarlar yoki rasmlar yuboradi. Har qanday savol va topshiriqqa o'zbek tilida to'liq, ravon, professional va chiroyli javob ber."
        }
      ]
    },
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 3000
    }
  };

  let lastErrorMessage = "";

  for (const modelName of AVAILABLE_MODELS) {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;

    try {
      const res = await httpsRequest(endpoint, {
        method: 'POST',
        timeout: 60000
      }, requestBody);

      const data = res.json();

      if (data.candidates?.[0]?.content?.parts?.[0]?.text) {
        const answer = data.candidates[0].content.parts[0].text;

        history.push({
          role: "user",
          parts: [{ text: historyDescription || userParts[0].text || "[Xabar]" }]
        });
        history.push({
          role: "model",
          parts: [{ text: answer }]
        });

        if (history.length > 20) {
          history.splice(0, history.length - 20);
        }

        return answer;
      }

      if (data.error) {
        lastErrorMessage = data.error.message;
        continue;
      }
    } catch (err) {
      lastErrorMessage = err.message;
    }
  }

  return `Kechirasiz, sun'iy intellekt serverlarida vaqtinchalik yuklama yuqori. Qayta urinib ko'ring.\n(Xatolik: ${lastErrorMessage})`;
}

// Matnli topshiriq turini aniqlash
function isImageDrawingRequest(text) {
  const t = text.toLowerCase();
  if (t.startsWith('/image') || t.startsWith('/rasm') || t.startsWith('/draw')) return true;
  return t.includes('rasm chiz') || t.includes('rasm yarat') || t.includes('chizib ber') || 
         t.includes('rasmini chiz') || t.includes('rasm tayyorla') || t.includes('tasvirla') || 
         t.includes('rasm chiqar') || t.includes('rasmini yarat');
}

function isWordRequest(text) {
  const t = text.toLowerCase();
  if (t.startsWith('/word') || t.startsWith('/doc')) return true;
  return t.includes('wordda') || t.includes('word fayl') || t.includes('word qilib') || 
         t.includes('docx') || t.includes('ariza namuna') || t.includes('hujjat shaklida');
}

function isPowerPointRequest(text) {
  const t = text.toLowerCase();
  if (t.startsWith('/ppt') || t.startsWith('/powerpoint') || t.startsWith('/presentation')) return true;
  return t.includes('taqdimot') || t.includes('prezentatsiya') || t.includes('slayd') || 
         t.includes('powerpoint') || t.includes('pptx');
}

function isExcelRequest(text) {
  const t = text.toLowerCase();
  if (t.startsWith('/excel') || t.startsWith('/xlsx')) return true;
  return t.includes('excelda') || t.includes('excel fayl') || t.includes('excel qilib') || 
         t.includes('jadval tuz') || t.includes('jadval qilib') || t.includes('xlsx');
}

// Xabarni tahlil qilish
async function handleUpdate(update) {
  if (!update.message) return;

  const msg = update.message;
  const chatId = msg.chat.id;
  const fromUser = msg.from.first_name || "Foydalanuvchi";

  // 1. RASM QABUL QILISH VA TAHLIL QILISH (VISION)
  if (msg.photo && msg.photo.length > 0) {
    const photo = msg.photo[msg.photo.length - 1];
    console.log(`[Rasm keldi - ${fromUser}]`);

    await sendChatAction(chatId, 'typing');
    const actionInterval = setInterval(() => sendChatAction(chatId, 'typing'), 3500);

    try {
      const fileInfo = await telegramRequest('getFile', { file_id: photo.file_id });
      if (!fileInfo.ok || !fileInfo.result?.file_path) {
        throw new Error("Rasm manzilini olib bo'lmadi.");
      }

      const base64Photo = await downloadTelegramFileAsBase64(fileInfo.result.file_path);
      const caption = msg.caption ? msg.caption.trim() : "Ushbu rasmni batafsil tahlil qil va nima tasvirlanganini o'zbek tilida aytib ber.";

      if (/o'zgartir|tahrir|yangi rasm|kiberpank|uslub|boshqacha qilib/i.test(caption)) {
        clearInterval(actionInterval);
        await telegramRequest('sendMessage', {
          chat_id: chatId,
          text: "Rasm tahlil qilinmoqda va yangi varianti chizilmoqda, kuting..."
        });
        await handleImageGeneration(chatId, caption);
        return;
      }

      const userParts = [
        {
          inlineData: {
            mimeType: "image/jpeg",
            data: base64Photo
          }
        },
        {
          text: `Foydalanuvchi rasm yubordi. Xabar matni: "${caption}". Ushbu rasmni diqqat bilan ko'rib, foydalanuvchining savoliga yoki iltimosiga to'liq o'zbek tilida javob ber.`
        }
      ];

      const answer = await askGemini(chatId, userParts, `[Rasm: ${caption}]`);
      clearInterval(actionInterval);
      await sendLongMessage(chatId, answer);
    } catch (err) {
      clearInterval(actionInterval);
      await telegramRequest('sendMessage', {
        chat_id: chatId,
        text: `Rasmni tahlil qilishda xatolik: ${err.message}`
      });
    }
    return;
  }

  // 2. OVOZLI XABARLAR
  if (msg.voice || msg.audio) {
    const audioObj = msg.voice || msg.audio;
    const isVoice = !!msg.voice;
    console.log(`[Ovoz keldi - ${fromUser}]: Davomiyligi ${audioObj.duration} soniya`);

    await sendChatAction(chatId, 'record_voice');
    const actionInterval = setInterval(() => sendChatAction(chatId, 'record_voice'), 3500);

    try {
      const fileInfo = await telegramRequest('getFile', { file_id: audioObj.file_id });
      if (!fileInfo.ok || !fileInfo.result?.file_path) {
        throw new Error("Telegram'dan fayl manzilini olib bo'lmadi.");
      }

      const base64Audio = await downloadTelegramFileAsBase64(fileInfo.result.file_path);
      const mimeType = audioObj.mime_type || (isVoice ? 'audio/ogg' : 'audio/mp3');

      const userParts = [
        {
          inlineData: {
            mimeType: mimeType,
            data: base64Audio
          }
        },
        {
          text: "Foydalanuvchi ovozli xabar yubordi. Ushbu audio faylni diqqat bilan eshitib, undagi topshiriqni tushun va o'zbek tilida to'liq javob ber."
        }
      ];

      const answer = await askGemini(chatId, userParts, "[Ovozli xabar]");
      clearInterval(actionInterval);

      // Ovozli buyruq orqali rasm yoki ofis hujjati so'ralsa
      if (isWordRequest(answer)) {
        await handleWordGeneration(chatId, answer);
      } else if (isPowerPointRequest(answer)) {
        await handlePowerPointGeneration(chatId, answer);
      } else if (isExcelRequest(answer)) {
        await handleExcelGeneration(chatId, answer);
      } else if (isImageDrawingRequest(answer)) {
        await handleImageGeneration(chatId, answer);
      } else {
        await sendLongMessage(chatId, `🎤 **Ovozli xabaringiz javobi:**\n\n${answer}`);
      }
    } catch (err) {
      clearInterval(actionInterval);
      await telegramRequest('sendMessage', {
        chat_id: chatId,
        text: `Ovozli xabarni tahlil qilishda xatolik yuz berdi: ${err.message}`
      });
    }
    return;
  }

  // 3. MATNLI XABARLAR
  if (msg.text) {
    const text = msg.text.trim();
    console.log(`[Matn keldi - ${fromUser}]: ${text}`);

    if (text === '/start') {
      const welcome = `Assalomu alaykum, ${fromUser}!\n\n` +
        `Men sizning universal sun'iy intellekt botingizman.\n\n` +
        `🚀 **Mening barcha imkoniyatlarim:**\n` +
        `✍️ **Savol-javob:** Har qanday mavzuda savol yoki topshiriq.\n` +
        `🎤 **Ovozli xabar:** Mikrofondan gapiring — tushunaman.\n` +
        `🎨 **Rasm chizish:** «Menga ... rasmini chizib ber» deng.\n` +
        `📄 **Word (.docx):** «Wordda ariza/hisobot tayyorla» deng.\n` +
        `📊 **PowerPoint (.pptx):** «Sun'iy intellekt haqida taqdimot/slayd tayyorla» deng.\n` +
        `📈 **Excel (.xlsx):** «Oylik xarajatlar jadvalini excel qilib ber» deng.\n` +
        `🖼️ **Rasm tahlili:** Botga rasm yuboring, tahlil qilib beraman.\n\n` +
        `Buyruqlar:\n` +
        `/clear — Xotirani tozalash\n` +
        `/help — Yordam`;
      await telegramRequest('sendMessage', { chat_id: chatId, text: welcome });
      return;
    }

    if (text === '/clear') {
      userHistories.delete(chatId);
      await telegramRequest('sendMessage', {
        chat_id: chatId,
        text: "Xotira tozalandi! Yangi mavzuda topshiriq yuborishingiz mumkin."
      });
      return;
    }

    if (text === '/help') {
      const helpText = `Qo'llanma:\n\n` +
        `• 📄 **Word hujjati:** «Menga mehnat ta'tili haqida Word fayl qilib ber»\n` +
        `• 📊 **Taqdimot (PowerPoint):** «Marketing bo'yicha taqdimot tayyorla»\n` +
        `• 📈 **Excel jadvali:** «Xodimlar maoshi bo'yicha Excel jadval tuz»\n` +
        `• 🎨 **Rasm chizish:** «Menga kosmosdagi kema rasmini chizib ber»\n` +
        `• 🎤 **Ovozli xabar:** Mikrofonni bosib gapiring.`;
      await telegramRequest('sendMessage', { chat_id: chatId, text: helpText });
      return;
    }

    // A) WORD HUJJATI SO'RALGANDA
    if (isWordRequest(text)) {
      await telegramRequest('sendMessage', {
        chat_id: chatId,
        text: "📄 Word (.docx) hujjati tayyorlanmoqda, iltimos kuting..."
      });
      await handleWordGeneration(chatId, text);
      return;
    }

    // B) POWERPOINT TAQDIMOT SO'RALGANDA
    if (isPowerPointRequest(text)) {
      await telegramRequest('sendMessage', {
        chat_id: chatId,
        text: "📊 PowerPoint (.pptx) taqdimoti tayyorlanmoqda, iltimos kuting..."
      });
      await handlePowerPointGeneration(chatId, text);
      return;
    }

    // C) EXCEL JADVALI SO'RALGANDA
    if (isExcelRequest(text)) {
      await telegramRequest('sendMessage', {
        chat_id: chatId,
        text: "📈 Excel (.xlsx) jadvali shakllantirilmoqda, iltimos kuting..."
      });
      await handleExcelGeneration(chatId, text);
      return;
    }

    // D) RASM CHIZISH SO'RALGANDA
    if (isImageDrawingRequest(text)) {
      let promptToDraw = text
        .replace(/^\/(image|rasm|draw)\s*/i, '')
        .replace(/(menga|iltimos|rasm chiz|rasm yarat|chizib ber|rasmini chiz|rasmini yarat|tayyorlab ber)/gi, '')
        .trim();

      if (!promptToDraw) promptToDraw = text;

      await telegramRequest('sendMessage', {
        chat_id: chatId,
        text: "🎨 Rasm tayyorlanmoqda, bir necha soniya kuting..."
      });

      await handleImageGeneration(chatId, promptToDraw);
      return;
    }

    // E) ODDIY MATNLI SUHBAT
    await sendChatAction(chatId, 'typing');
    const actionInterval = setInterval(() => sendChatAction(chatId, 'typing'), 3500);

    try {
      const userParts = [{ text: text }];
      const answer = await askGemini(chatId, userParts, text);
      clearInterval(actionInterval);
      await sendLongMessage(chatId, answer);
    } catch (err) {
      clearInterval(actionInterval);
      await telegramRequest('sendMessage', {
        chat_id: chatId,
        text: `Xatolik yuz berdi: ${err.message}`
      });
    }
  }
}

// Long Polling sikli
let offset = 0;
async function startPolling() {
  console.log("=========================================================");
  console.log("Telegram AI Bot (Word, Excel, PowerPoint, Rasm, Ovoz)");
  console.log("Ishga tushdi va xabarlarni kutmoqda...");
  console.log("=========================================================");

  while (true) {
    try {
      const data = await telegramRequest('getUpdates', {
        offset: offset,
        timeout: 20,
      });

      if (data.ok && Array.isArray(data.result)) {
        for (const update of data.result) {
          offset = update.update_id + 1;
          handleUpdate(update).catch((err) => {
            console.error("Xabarni ishlashda xatolik:", err);
          });
        }
      } else if (!data.ok) {
        console.error("Polling xatosi:", data.description);
        await new Promise((r) => setTimeout(r, 3000));
      }
    } catch (err) {
      console.error("Polling tarmoq xatosi:", err.message);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

startPolling();
