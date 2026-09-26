// server.js
// -----------------------------------------------------------------------------
// AI Voice/Photo-to-Invoice backend.
//
// Responsibilities:
// 1. Keep GEMINI_API_KEY on the server only — it is never sent to the browser.
// 2. Accept an audio recording, an image (screenshot of a customer text/email),
//    and/or typed text from the frontend — any combination.
// 3. Forward it to Gemini 1.5 Flash with a strict system instruction that
//    forces raw-JSON output matching the invoice schema.
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

// Accept audio and/or an image in memory (not written to disk).
// 20MB covers a few minutes of compressed voice or a large screenshot.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname))); // serves index.html from this same folder

// ---- The system instruction: this is the entire "brain" of the extraction --
const SYSTEM_INSTRUCTIONS = `
You are a backend data-extraction engine for a contractor's voice/photo-to-invoice tool.

You will receive some combination of: a short audio recording, a screenshot or
photo of a text message / email from a customer, and/or typed text, in which a
contractor describes (or a customer's message implies) a job, a client, and/or
the work to be billed. Audio is often spoken quickly, out of order, or with
filler words ("uh", "so basically", "let's see"). A screenshot is often a
casual text message thread — read any visible names, addresses, and job
details directly from the image.

Your ONLY job is to extract the relevant facts and return them as RAW JSON —
nothing else. No markdown code fences. No "Here is the JSON:". No trailing
commentary. Your entire response must be a single valid JSON object and
nothing outside of it.

Return JSON matching exactly this shape:
{
  "client_name": "",
  "address": "",
  "line_items": [
    { "description": "", "quantity": 1, "rate": 0 }
  ]
}

Extraction rules:
- "client_name": the person or business being billed. If not stated, use "".
- "address": the job site or billing address, as stated. If not stated, use "".
- "line_items": one entry per distinct task, material, or billable item
  mentioned. Always return at least one line item if any work is described
  at all — never return an empty array unless the input contains no
  identifiable work.
- "description": a short, clean label for the item (e.g. "Replace kitchen
  faucet", not a verbatim transcript).
- "quantity": a plain number. Default to 1 if not stated or implied.
- "rate": a plain number with NO currency symbol, commas, or units. If a
  dollar amount is mentioned for that item, use it. If a default hourly rate
  or material markup is provided below, use it for line items that don't have
  their own stated price. If no price is available anywhere, use 0.
- Never invent a client name, address, or price that was not stated,
  shown in an image, or reasonably implied.
- If the input contains no usable information at all, return:
  { "client_name": "", "address": "", "line_items": [] }

Remember: output ONLY the JSON object. No explanations, no apologies, no
markdown formatting of any kind.
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

      // Optional defaults the frontend can send along (from the settings drawer)
      // so Gemini can price line items the customer didn't give a number for.
      const defaultHourlyRate = req.body?.defaultHourlyRate ? Number(req.body.defaultHourlyRate) : null;
      const defaultMaterialMarkup = req.body?.defaultMaterialMarkup ? Number(req.body.defaultMaterialMarkup) : null;

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

      // Build the multi-part request: audio + image + text, whichever are present.
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

      const result = await model.generateContent(parts);
      const raw = (result.response.text() || '').trim();
      const parsed = safeParseInvoiceJson(raw);

      if (!parsed) {
        console.error('Gemini returned non-JSON output:', raw);
        return res.status(502).json({ error: 'The AI response could not be parsed. Please try again.' });
      }

      res.json(normalizeInvoice(parsed));
    } catch (err) {
      console.error('generate-quote error:', err);
      res.status(500).json({ error: 'Something went wrong generating the quote. Please try again.' });
    }
  }
);

// ---- Helpers -----------------------------------------------------------------
function safeParseInvoiceJson(raw) {
  try {
    return JSON.parse(raw);
  } catch (_) {
    // Fallback: in case the model wraps the JSON in stray text despite
    // instructions, pull out the first {...} block and try again.
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
  console.log(`Voice/Photo-to-Invoice server running at http://localhost:${PORT}`);
});
