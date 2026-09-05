const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const CONFIG_PATH = path.join(__dirname, 'config.json');

// Konfiguratsiyani yuklash (fayldan yoki Environment Variables dan)
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
    ALLOWED_USER_IDS: process.env.ALLOWED_USER_IDS 
      ? process.env.ALLOWED_USER_IDS.split(',').map(id => Number(id.trim())) 
      : (fileConfig.ALLOWED_USER_IDS || [])
  };
}

function saveConfig(cfg) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf-8');
  } catch (e) {}
}

let config = loadConfig();

if (!config.TELEGRAM_BOT_TOKEN || config.TELEGRAM_BOT_TOKEN.includes("BOT_TOKENINGIZNI")) {
  console.log("DIQQAT: Telegram bot tokeni kiritilmagan!");
  process.exit(1);
}

// Bepul bulutli serverlar (Render, Koyeb va h.k.) uchun yengil HTTP healthcheck server
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<h3>Telegram AI Bot 24/7 faol ishlab turibdi! 🚀</h3>');
}).listen(PORT, () => {
  console.log(`Cloud HTTP Server ${PORT}-portda ishlamoqda.`);
});

const TELEGRAM_API = `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}`;
const userHistories = new Map();

// IPv4 orqali xavfsiz va tezkor HTTPS so'rov yuboruvchi asosiy funksiya
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
      family: 4, // Har doim IPv4 (tarmoq uzilishining oldini oladi)
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

    req.on('timeout', () => {
      req.destroy(new Error('Ulanish vaqti tugadi (Timeout)'));
    });

    req.on('error', (err) => {
      reject(err);
    });

    if (payload) {
      req.write(payload);
    }
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

// Telegram faylini yuklab olib, Base64 ga o'girish
async function downloadTelegramFileAsBase64(filePath) {
  const url = `${TELEGRAM_FILE_API}/${filePath}`;
  const res = await httpsRequest(url, { method: 'GET', timeout: 60000 });
  if (res.statusCode !== 200) {
    throw new Error(`Ovoz faylini yuklab bo'lmadi (HTTP ${res.statusCode})`);
  }
  const buffer = res.buffer();
  return buffer.toString('base64');
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

// Harakat holatini yuborish (typing yoki record_voice)
async function sendChatAction(chatId, action = 'typing') {
  await telegramRequest('sendChatAction', {
    chat_id: chatId,
    action: action,
  });
}

// Mavjud modellar (zaxira bilan)
const AVAILABLE_MODELS = [
  'gemini-3.5-flash-lite',
  'gemini-flash-lite-latest',
  'gemini-flash-latest',
  'gemini-3.6-flash'
];

// Gemini API chaqiruvi (Matn yoki Ovoz bilan)
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
          text: "Sen foydalanuvchining shaxsiy sun'iy intellekt assistentisan. Foydalanuvchi Telegram orqali yozma yoki ovozli xabarlar yuboradi. Agar ovoz yuborilsa, ovozni diqqat bilan eshitib, undagi barcha talablarni to'liq tushun va o'zbek tilida juda aniq, chuqur va chiroyli javob qaytar."
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

        // Xotiraga saqlash
        history.push({
          role: "user",
          parts: [{ text: historyDescription || userParts[0].text || "[Ovozli xabar]" }]
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
        console.warn(`[${modelName}] xatolik (${data.error.code}): ${data.error.message}`);
        lastErrorMessage = data.error.message;
        continue;
      }
    } catch (err) {
      console.warn(`[${modelName}] tarmoq xatosi:`, err.message);
      lastErrorMessage = err.message;
    }
  }

  return `Kechirasiz, sun'iy intellekt serverlarida vaqtinchalik yuklama yuqori. Qayta urinib ko'ring.\n(Xatolik: ${lastErrorMessage})`;
}

// Xabarni tahlil qilish
async function handleUpdate(update) {
  if (!update.message) return;

  const msg = update.message;
  const chatId = msg.chat.id;
  const fromUser = msg.from.first_name || "Foydalanuvchi";
  const userId = msg.from.id;

  // Xavfsizlik
  if (config.ALLOWED_USER_IDS && config.ALLOWED_USER_IDS.length > 0) {
    if (!config.ALLOWED_USER_IDS.includes(userId)) {
      await telegramRequest('sendMessage', {
        chat_id: chatId,
        text: "Kechirasiz, bu bot shaxsiy bot hisoblanadi."
      });
      return;
    }
  } else {
    config.ALLOWED_USER_IDS = [userId];
    saveConfig(config);
    console.log(`Bot egasi saqlandi! Telegram ID: ${userId}`);
  }

  // 1. OVOZLI XABARLAR
  if (msg.voice || msg.audio) {
    const audioObj = msg.voice || msg.audio;
    const isVoice = !!msg.voice;
    console.log(`[Ovoz keldi - ${fromUser}]: Davomiyligi ${audioObj.duration} soniya`);

    await sendChatAction(chatId, 'record_voice');
    const actionInterval = setInterval(() => {
      sendChatAction(chatId, 'record_voice');
    }, 3500);

    try {
      // 1. Fayl manzilini olish
      const fileInfo = await telegramRequest('getFile', { file_id: audioObj.file_id });
      if (!fileInfo.ok || !fileInfo.result?.file_path) {
        throw new Error("Telegram'dan fayl manzilini olib bo'lmadi.");
      }

      // 2. Faylni yuklab olish
      console.log(`Ovoz yuklab olinmoqda: ${fileInfo.result.file_path}...`);
      const base64Audio = await downloadTelegramFileAsBase64(fileInfo.result.file_path);
      const mimeType = audioObj.mime_type || (isVoice ? 'audio/ogg' : 'audio/mp3');

      const caption = msg.caption ? ` (Izoh: ${msg.caption})` : "";
      const userParts = [
        {
          inlineData: {
            mimeType: mimeType,
            data: base64Audio
          }
        },
        {
          text: `Foydalanuvchi ovozli xabar yubordi${caption}. Ushbu audio faylni diqqat bilan eshitib, undagi barcha gaplar, savol yoki topshiriqlarni tushun va o'zbek tilida to'liq, mukammal javob ber.`
        }
      ];

      console.log("Ovoz Gemini ga tahlil uchun yuborilmoqda...");
      const answer = await askGemini(chatId, userParts, `[Ovozli xabar${caption}]`);
      clearInterval(actionInterval);
      await sendLongMessage(chatId, `🎤 **Ovozli xabaringiz tahlil qilindi:**\n\n${answer}`);
    } catch (err) {
      clearInterval(actionInterval);
      console.error("Ovozni qayta ishlashda xatolik:", err);
      await telegramRequest('sendMessage', {
        chat_id: chatId,
        text: `Ovozli xabarni tahlil qilishda xatolik yuz berdi: ${err.message}`
      });
    }
    return;
  }

  // 2. MATNLI XABARLAR
  if (msg.text) {
    const text = msg.text.trim();
    console.log(`[Matn keldi - ${fromUser}]: ${text}`);

    if (text === '/start') {
      const welcome = `Assalomu alaykum, ${fromUser}!\n\n` +
        `Men sizning shaxsiy sun'iy intellekt botingizman.\n\n` +
        `✍️ **Matn orqali:** Xohlagan savol yoki topshiriqni yozing.\n` +
        `🎤 **Ovoz orqali:** Mikrofon tugmasini bosib gapiring — bot ovozingizni tushunib javob qaytaradi!\n\n` +
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
      const helpText = `Qo'llanma:\n\n• Matn yoki ovozli xabar (mikrofon) orqali topshiriq yuboring.\n• Bot ikkalasini ham tushunadi va bajaradi.\n• /clear — Xotirani tozalash.`;
      await telegramRequest('sendMessage', { chat_id: chatId, text: helpText });
      return;
    }

    await sendChatAction(chatId, 'typing');
    const actionInterval = setInterval(() => {
      sendChatAction(chatId, 'typing');
    }, 3500);

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
  console.log("=================================================");
  console.log("Telegram AI Bot (IPv4, Matn + Ovoz) ishga tushdi!");
  console.log("Xabarlar va ovozli topshiriqlar kutilmoqda...");
  console.log("=================================================");

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
