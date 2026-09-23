# Voice to Invoice — LocalPro Media

A contractor says the job out loud (or types it), and Gemini turns it into a
structured quote: client name, address, and line items with quantities and
rates, live-totaled in an iMessage-style chat card.

## Why this is two files

`index.html` never talks to Gemini directly. It only talks to your own
`server.js`, which holds the real `GEMINI_API_KEY` as a server-side
environment variable. The key is never sent to the browser, never visible in
page source, and never exposed in network requests a visitor could inspect.

## Run it locally

```bash
npm install
cp .env.example .env
# open .env and paste your real key from https://aistudio.google.com/app/apikey
npm start
```

Then open **http://localhost:3000** — `server.js` serves `index.html`
directly, so there's nothing else to configure locally.

## Deploying it for real

This needs an actual Node.js host — it cannot run as a static file the way
the templates do, because the whole point is that the API key lives on a
server. Any of these work with no code changes:

- **Render** (render.com) — free tier, connect a GitHub repo, set
  `GEMINI_API_KEY` in the dashboard's Environment tab, done.
- **Railway** (railway.app) — same idea, one-click deploy from a repo.
- **Fly.io** — a bit more setup but works well for small Node apps.

In all three: push these files to a GitHub repo, connect it, set the one
environment variable (`GEMINI_API_KEY`), and the platform runs `npm start`
for you.

## Files

| File | Purpose |
|---|---|
| `server.js` | Express server, Gemini call, JSON validation |
| `index.html` | The chat UI (served by `server.js`, or by any static host if you point it at a *different* deployed backend URL) |
| `package.json` | Dependencies (`express`, `multer`, `cors`, `dotenv`, `@google/generative-ai`) |
| `.env.example` | Copy to `.env` and fill in your key |

## Customizing the extraction

All of the "intelligence" lives in the `SYSTEM_INSTRUCTIONS` constant near
the top of `server.js`. If quotes are coming back with the wrong structure,
that's the first place to edit — no frontend changes needed.
