// server.js
// -----------------------------------------------------------------------------
// AI Voice-to-Invoice backend.
//
// Responsibilities:
//   1. Keep GEMINI_API_KEY on the server only — it is never sent to the browser.
//   2. Accept an audio recording (and/or typed text) from the frontend.
//   3. Forward it to Gemini 1.5 Flash with a strict system instruction that
//      forces raw-JSON output matching the invoice schema.
//   4. Validate/normalize that JSON and return it to the client.
//
// Run:
//   npm install
//   cp .env.example .env      # then paste your real key into .env
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

// Accept audio in memory (not written to disk). 20MB covers a few minutes
// of compressed voice, which is far more than a spoken job description needs.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname))); // serves index.html from this same folder

// ---- The system instruction: this is the entire "brain" of the extraction --

const SYSTEM_INSTRUCTIONS = `
You are a backend data-extraction engine for a contractor's voice-to-invoice tool.

You will receive either a short audio recording, or a short piece of text, in
which a contractor casually describes a job, a client, and/or the work to be
billed — often spoken quickly, out of order, or with filler words ("uh", "so
basically", "let's see").

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
  dollar amount is mentioned for that item, use it. If only a total is
  mentioned for multiple items, distribute reasonably or place the total on a
  single combined line item — use your best judgment. If no price is
  mentioned anywhere, use 0.
- Never invent a client name, address, or price that was not stated or
  reasonably implied.
- If the input contains no usable information at all, return:
  { "client_name": "", "address": "", "line_items": [] }

Remember: output ONLY the JSON object. No explanations, no apologies, no
markdown formatting of any kind.
`.trim();

// ---- The endpoint ------------------------------------------------------------

app.post('/api/generate-quote', upload.single('audio'), async (req, res) => {
  try {
    const textInput = req.body && typeof req.body.text === 'string' ? req.body.text.trim() : '';
    const hasAudio = !!req.file;

    if (!hasAudio && !textInput) {
      return res.status(400).json({ error: 'Send an audio recording or some text describing the job.' });
    }

    const model = genAI.getGenerativeModel({
      model: 'gemini-1.5-flash',
      systemInstruction: SYSTEM_INSTRUCTIONS,
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.2,
      },
    });

    // Build the multi-part request: audio (if present) + text (if present).
    const parts = [];
    if (hasAudio) {
      parts.push({
        inlineData: {
          mimeType: req.file.mimetype || 'audio/webm',
          data: req.file.buffer.toString('base64'),
        },
      });
    }
    if (textInput) {
      parts.push({ text: textInput });
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
});

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
  console.log(`Voice-to-Invoice server running at http://localhost:${PORT}`);
});
