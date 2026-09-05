const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { URL } = require('url');

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
    // Barcha foydalanuvchilar ishlata olishi uchun cheklov o'chirildi
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
  res.end('<h3>Telegram AI Bot (Matn + Ovoz + Rasm) faol ishlab turibdi! 🚀</h3>');
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

// Gemini orqali rasm promptini (inglizcha chizish tavsifini) yaratish
async function generateImagePromptWithGemini(userText) {
  const apiKey = config.GEMINI_API_KEY;
  const prompt = `Foydalanuvchi rasm chizishni so'ramoqda: "${userText}".
Ushbu so'rov asosida sun'iy intellekt (Flux/Midjourney) uchun professional, yuqori sifatli, batafsil INGLIZCHA prompt tuzib ber.
Javobda FAQAT INGLIZCHA PROMPT matnini qaytar, hech qanday ortiqcha so'z, izoh yoki tirnoqsiz bo'lsin.
Masalan: Cyberpunk night Tashkent city, futuristic Chorsu bazaar dome with neon lights, flying cars, hyperdetailed, 8k, cinematic lighting.`;

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

// Rasm yaratish va Telegramga yuborish
async function handleImageGeneration(chatId, promptText) {
  await sendChatAction(chatId, 'upload_photo');
  const actionInterval = setInterval(() => sendChatAction(chatId, 'upload_photo'), 3500);

  try {
    // 1. Promptni boyitish
    const englishPrompt = await generateImagePromptWithGemini(promptText);
    const cleanPrompt = encodeURIComponent(englishPrompt);
    const seed = Math.floor(Math.random() * 999999);
    const imageUrl = `https://image.pollinations.ai/prompt/${cleanPrompt}?width=1024&height=1024&nologo=true&seed=${seed}`;

    console.log(`Rasm yaratilmoqda: ${englishPrompt}`);

    // 2. Telegram orqali yuborish
    const res = await telegramRequest('sendPhoto', {
      chat_id: chatId,
      photo: imageUrl,
      caption: `🎨 **Siz so'ragan rasm tayyorlandi!**\n\n📝 *Tavsif:* ${englishPrompt.slice(0, 300)}`
    });

    clearInterval(actionInterval);

    if (!res.ok) {
      throw new Error(res.description || "Rasmni yuborib bo'lmadi");
    }
  } catch (err) {
    clearInterval(actionInterval);
    console.error("Rasm yaratish xatosi:", err.message);
    await telegramRequest('sendMessage', {
      chat_id: chatId,
      text: `Kechirasiz, rasm yaratishda xatolik yuz berdi: ${err.message}`
    });
  }
}

// Gemini API chaqiruvi (Matn, Ovoz yoki Rasm tahlili bilan)
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

// Foydalanuvchi rasm chizishni so'rayaptimi?
function isImageDrawingRequest(text) {
  const t = text.toLowerCase();
  if (t.startsWith('/image') || t.startsWith('/rasm') || t.startsWith('/draw')) return true;
  if (t.includes('rasm chiz') || t.includes('rasm yarat') || t.includes('chizib ber') || 
      t.includes('rasmini chiz') || t.includes('rasm tayyorla') || t.includes('tasvirla') || 
      t.includes('rasm chiqar') || t.includes('rasmini yarat')) {
    return true;
  }
  return false;
}

// Xabarni tahlil qilish
async function handleUpdate(update) {
  if (!update.message) return;

  const msg = update.message;
  const chatId = msg.chat.id;
  const fromUser = msg.from.first_name || "Foydalanuvchi";

  // 1. RASM QABUL QILISH VA TAHLIL QILISH (VISION)
  if (msg.photo && msg.photo.length > 0) {
    const photo = msg.photo[msg.photo.length - 1]; // Eng yuqori sifatlisi
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

      // Agar rasm asosida yangi rasm chizish/o'zgartirish so'ralgan bo'lsa
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
      console.error("Rasmni tahlil qilishda xatolik:", err);
      await telegramRequest('sendMessage', {
        chat_id: chatId,
        text: `Rasmni tahlil qilishda xatolik yuz berdi: ${err.message}`
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

      // Agar ovoz orqali rasm chizish so'ralgan bo'lsa
      if (isImageDrawingRequest(answer)) {
        await telegramRequest('sendMessage', {
          chat_id: chatId,
          text: `🎤 **Ovozingiz eshitildi.** Rasm tayyorlanmoqda...`
        });
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
        `Men sizning ko'p qirrali sun'iy intellekt botingizman.\n\n` +
        `✨ **Imkoniyatlar:**\n` +
        `✍️ **Matnli savol-javob:** Xohlagan mavzuda savol bering yoki topshiriq yozing.\n` +
        `🎤 **Ovozli xabar:** Mikrofonni bosib gapiring — ovozingizni tushunaman.\n` +
        `🎨 **Rasm chizish:** «Menga kiberpank Toshkent rasmini chizib ber» yoki «/rasm kosmosdagi mushuk» deb yozing — tayyor rasm chizib beraman!\n` +
        `🖼️ **Rasm tahlili:** Botga rasm yuboring, uni tahlil qilib, tushuntirib yoki tahrirlab beraman.\n\n` +
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
        text: "Xotira tozalandi! Yangi mavzuda savol yoki rasm so'rashingiz mumkin."
      });
      return;
    }

    if (text === '/help') {
      const helpText = `Qo'llanma:\n\n• Rasm chizish uchun: «Menga ... rasmini chizib ber» yoki «/rasm ...» deb yozing.\n• Rasm tahlili: Istalgan rasmni botga yuboring.\n• Ovozli xabar: Mikrofon orqali gapiring.\n• /clear — Xotirani tozalash.`;
      await telegramRequest('sendMessage', { chat_id: chatId, text: helpText });
      return;
    }

    // A) Agar foydalanuvchi rasm chizishni so'ragan bo'lsa
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

    // B) Oddiy savol-javob
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
  console.log("=================================================");
  console.log("Telegram AI Bot (Ovoz, Rasm, Vision) ishga tushdi!");
  console.log("Barcha foydalanuvchilar uchun ochiq!");
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
