// server.js
// -----------------------------------------------------------------------------
// LocalPro Assistant backend — Voice/Photo/Text-to-Invoice.
//
// Responsibilities:
// 1. Keep GEMINI_API_KEY on the server only — it is never sent to the browser.
// 2. Accept an audio recording, an image (screenshot of a customer text/email),
//    and/or typed text from the frontend — any combination — plus a short
//    running conversation history so the AI can ask a follow-up question
//    instead of guessing when it doesn't have enough to quote.
// 3. Forward it to Gemini 1.5 Flash with a strict system instruction that
//    forces raw-JSON output — either a finished estimate or a clarifying
//    question.
// 4. Validate/normalize that JSON and return it to the client.
//
// Run:
//   npm install
//   cp .env.example .env   # then paste your real key into .env
//   npm start
// -----------------------------------------------------------------------------

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const PORT = process.env.PORT || 3000;

// ---- Config / sanity checks -------------------------------------------------
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.error(
    '\n[FATAL] GEMINI_API_KEY is not set.\n' +
    'Create a .env file (see .env.example) with:\n' +
    '  GEMINI_API_KEY=your-real-key-here\n'
  );
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname))); // serves index.html from this same folder

// ---- System instruction: the entire "brain" of the extraction --------------
const SYSTEM_INSTRUCTIONS = `
You are the backend for LocalPro Assistant, a chat tool that turns a contractor's
description of a job (voice, screenshot of a customer text/email, and/or typed
text) into a priced quote.

You will often receive only a partial picture on the first message. Your job is
to decide, each turn, whether you have ENOUGH to produce a real quote, or
whether you need to ask ONE short, friendly, specific follow-up question first.

Respond with RAW JSON ONLY — no markdown fences, no commentary, nothing outside
a single JSON object. It must be exactly one of these two shapes:

If you need more information:
{ "type": "question", "message": "" }

If you have enough to quote (even roughly):
{
  "type": "estimate",
  "client_name": "",
  "address": "",
  "line_items": [
    { "description": "", "quantity": 1, "rate": 0 }
  ]
}

Rules for deciding which shape to use:
- Ask a "question" when the work being done is too vague to name a real line
  item (e.g. "clean my house" with no rooms, size, or scope; "fix my sink"
  with no idea what's wrong). Ask about the ONE most important missing
  detail — don't list several questions at once.
- Do NOT ask about client name or address just because they're missing — those
  can stay "". Only ask about them if the job genuinely can't be scoped or
  priced without one (rare).
- Once you have enough to name at least one concrete billable item, return
  "estimate" — don't keep asking questions past that point. It's fine for an
  estimate to be a reasonable, clearly-scoped guess.
- If a contractor default hourly rate or material markup is provided below,
  use it for any line item that doesn't have its own stated price.
- "quantity": a plain number, default 1. "rate": a plain number, no symbols;
  0 only if truly no price is available anywhere.
- Never invent a client name, address, or price that wasn't stated, shown in
  an image, or reasonably implied.

Remember: output ONLY the JSON object, nothing else.
`.trim();

// ---- The endpoint ------------------------------------------------------------
app.post(
  '/api/generate-quote',
  upload.fields([
    { name: 'audio', maxCount: 1 },
    { name: 'image', maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const textInput = req.body && typeof req.body.text === 'string' ? req.body.text.trim() : '';
      const audioFile = req.files?.audio?.[0] || null;
      const imageFile = req.files?.image?.[0] || null;

      const defaultHourlyRate = req.body?.defaultHourlyRate ? Number(req.body.defaultHourlyRate) : null;
      const defaultMaterialMarkup = req.body?.defaultMaterialMarkup ? Number(req.body.defaultMaterialMarkup) : null;

      // Prior turns of this conversation, sent by the client as JSON text:
      // [{ role: 'user' | 'model', text: '...' }, ...]
      // Kept in the browser only — nothing is persisted server-side.
      let history = [];
      if (req.body?.history) {
        try {
          const parsed = JSON.parse(req.body.history);
          if (Array.isArray(parsed)) {
            history = parsed
              .filter((h) => h && (h.role === 'user' || h.role === 'model') && typeof h.text === 'string' && h.text.trim())
              .map((h) => ({ role: h.role, parts: [{ text: h.text.trim() }] }));
          }
        } catch (_) {
          history = [];
        }
      }

      if (!audioFile && !imageFile && !textInput) {
        return res.status(400).json({
          error: 'Send an audio recording, a screenshot/photo, or some text describing the job.',
        });
      }

      const model = genAI.getGenerativeModel({
        model: 'gemini-1.5-flash',
        systemInstruction: SYSTEM_INSTRUCTIONS,
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.2,
        },
      });

      const chat = model.startChat({ history });

      const parts = [];
      if (audioFile) {
        parts.push({
          inlineData: {
            mimeType: audioFile.mimetype || 'audio/webm',
            data: audioFile.buffer.toString('base64'),
          },
        });
      }
      if (imageFile) {
        parts.push({
          inlineData: {
            mimeType: imageFile.mimetype || 'image/jpeg',
            data: imageFile.buffer.toString('base64'),
          },
        });
      }

      let combinedText = textInput;
      if (defaultHourlyRate || defaultMaterialMarkup) {
        combinedText +=
          `\n\n[Contractor defaults — use only when a line item has no stated price] ` +
          (defaultHourlyRate ? `default hourly rate: $${defaultHourlyRate}. ` : '') +
          (defaultMaterialMarkup ? `default material markup: ${defaultMaterialMarkup}%.` : '');
      }
      if (combinedText.trim()) {
        parts.push({ text: combinedText.trim() });
      }
      if (parts.length === 0) {
        parts.push({ text: '(no additional text)' });
      }

      const result = await chat.sendMessage(parts);
      const raw = (result.response.text() || '').trim();
      const parsed = safeParseJson(raw);

      if (!parsed || (parsed.type !== 'estimate' && parsed.type !== 'question')) {
        console.error('Gemini returned unexpected output:', raw);
        return res.status(502).json({ error: 'The AI response could not be parsed. Please try again.' });
      }

      if (parsed.type === 'question') {
        return res.json({ type: 'question', message: typeof parsed.message === 'string' ? parsed.message : 'Can you tell me a bit more about the job?' });
      }

      return res.json({ type: 'estimate', ...normalizeInvoice(parsed) });
    } catch (err) {
      console.error('generate-quote error:', err);
      res.status(500).json({ error: 'Something went wrong generating the quote. Please try again.' });
    }
  }
);

// ---- Helpers -----------------------------------------------------------------
function safeParseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch (_) {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch (_) {
        return null;
      }
    }
    return null;
  }
}

function normalizeInvoice(parsed) {
  const lineItems = Array.isArray(parsed.line_items) ? parsed.line_items : [];
  return {
    client_name: typeof parsed.client_name === 'string' ? parsed.client_name : '',
    address: typeof parsed.address === 'string' ? parsed.address : '',
    line_items: lineItems.map((li) => ({
      description: typeof li.description === 'string' ? li.description : '',
      quantity: Number.isFinite(Number(li.quantity)) && Number(li.quantity) > 0 ? Number(li.quantity) : 1,
      rate: Number.isFinite(Number(li.rate)) && Number(li.rate) >= 0 ? Number(li.rate) : 0,
    })),
  };
}

app.listen(PORT, () => {
  console.log(`LocalPro Assistant server running at http://localhost:${PORT}`);
});
