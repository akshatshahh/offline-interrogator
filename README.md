# The Offline Interrogator

A local-first AI mock interviewer built for Dhruv, a friend preparing for FAANG interviews. Hacktoberfest 2026 Weekend Challenge: **Build for a Friend**.

Pick DSA, Behavioral, or System Design. Get one question at a time, explain your answer, ask for a hint, and receive a strict report card. Difficulty rises after strong answers and falls when fundamentals need work. Topic history makes weak spots visible across sessions.

## Open-source AI at the core

**Gemma 3 4B open weights → local Ollama → `ollama-ai-provider` → Mastra tools.** All question generation, answer scoring, and hint generation use this path. There are no OpenAI, Anthropic, or Gemini API calls in the app's reasoning code. Gemma is open-weight under Google's Gemma terms; Ollama and Mastra are open-source. This distinction matters: Gemma weights are available, but their license is not an OSI software license.

`server/llm.ts` is the sole inference entry point. `server/tools.ts` registers five `createTool` tools with the Mastra interviewer agent. The API invokes Mastra's registered tool execution layer in a deterministic interview loop instead of asking a second model to decide which route/tool to run. No framework fallback was needed. Express exposes the API; Mastra executes the tools. The hand-written scaffold keeps this weekend build small.

Scoring is validated against a strict Zod schema; malformed JSON is retried once. Overall is computed from the five rubric scores. Candidate text is passed as data, feedback is rendered as escaped text, and failures return actionable errors instead of fabricated scores.

## Five-minute setup

Requirements: Node 22.13+ and Ollama. Allow extra time for the initial ~3.3 GB model download. A machine with at least 8 GB RAM is recommended; inference speed depends on hardware.

```sh
ollama serve
```

In another terminal:

```sh
ollama pull gemma3:4b
ollama run gemma3:4b 'Reply with LOCAL_GEMMA_READY'
npm ci
cp .env.example .env
npm run build
npm start
```

Open **http://localhost:3000**. No optional API keys are required. Set duration to 5 minutes and start. Keep the server terminal visible to see `model=gemma3:4b` in startup output and JSON telemetry per inference.

Development uses two terminals: `npm run dev` and `npm run dev:client` (Vite at http://localhost:5173 with `/api` proxy).

## Docker

```sh
docker compose up --build
```

Compose starts Ollama, pulls `gemma3:4b` in a one-shot init service, then starts the app. Open http://localhost:3000. Initial startup waits for the model download. The Ollama volume caches weights; finished session exports are mounted into `./exports`. Stop any native server using port 3000 before starting Compose, or run `APP_PORT=3001 docker compose up --build` for a second port. The published port binds to localhost. CPU-only Docker inference on macOS is slower than native Ollama with Metal.

```sh
docker compose down
```

This preserves the model volume. No optional keys are needed. Docker Desktop must be running.

## Supporting partner technology

| Technology | Role | Missing configuration |
| --- | --- | --- |
| MongoDB Atlas M0 | Sessions, turns, seeded question bank | Warns and uses in-memory history |
| ElevenLabs | Optional question TTS | Silent interviews |
| Sentry Node | Tool/inference spans and errors | Console telemetry remains |
| Render | Optional app hosting | Local app and Docker work independently |

None of these services generates interview questions or scores answers. ElevenLabs only reads already-generated text.

## Environment

- `OLLAMA_BASE_URL`: defaults to `http://localhost:11434`; provider appends `/api`.
- `OLLAMA_MODEL`: defaults to `gemma3:4b`; use a locally installed open-weight model, never a cloud model suffix.
- `MONGODB_URI`: optional Atlas URI. Database: `offline_interrogator`; collections: `sessions`, `turns`, `question_bank`. The 24 seed questions are upserted on startup.
- `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`: both required for TTS. Voice defaults OFF; missing keys or voice failures silently degrade.
- `SENTRY_DSN`: optional. Model spans include `model`, `latency_ms`, `prompt_tokens`, `completion_tokens`. The provider maps Ollama `prompt_eval_count` and `eval_count` into SDK usage; tokens include retries. Storage tools use zero token counts.
- `PORT`: defaults to `3000`.

Set up Atlas M0, create a database user, allow your app's IP, and paste the connection URI into `.env`. The app still starts if Atlas cannot connect. Without Atlas, history lasts only until process restart; exports remain on disk. Never commit `.env`.

Optional microphone input uses browser Web Speech API and needs permission/support. Browsers may send speech to their own online recognition service. Text-only interviews with voice OFF can run fully offline after dependencies and weights are downloaded. Atlas, TTS, and Sentry require internet when enabled.

## Render deployment

Import the repository as a Render Blueprint using `render.yaml`, or create a Docker web service. Set `OLLAMA_BASE_URL` to an Ollama server reachable from the Render service. **Render cannot reach your laptop's localhost.** Use a private, securely connected self-hosted Ollama machine with enough RAM; avoid exposing Ollama directly to the public internet. Set Atlas URI and optional supporting keys in Render's environment settings.

This deployment hosts the UI/API; the Gemma inference server remains self-hosted. For a strictly offline demo, use the local/Docker setup. Render's ephemeral filesystem does not durably retain `exports/`; use a persistent disk at `/app/exports` or download JSON after sessions. The starter app instance is not sized to run Gemma itself. This no-auth friend prototype is intended for local/private use, not an unrestricted public API.

## API

- `POST /api/interview/start` — `{track, difficulty, duration_min}` → `{session_id, first_question, started_at}`
- `POST /api/interview/answer` — `{session_id, answer_text}` → `{score, feedback, next_question}`; includes a report when time runs out.
- `POST /api/interview/hint` — `{session_id}` → `{hint}`; up to three progressively revealing hints.
- `POST /api/interview/end` — `{session_id}` → `{report_card}`; idempotent.
- `GET /api/dashboard/dhruv` — sessions, weak spots, chronological score progress.
- `GET /api/interview/:session_id/report` — saved report.
- `GET /api/interview/:session_id/export` — download a finished session JSON.
- `GET /api/health` — local model and voice availability.

Default user is `dhruv`; there is no auth. Duration is 1–60 minutes; UI presets start at five. The UI automatically ends at the deadline. Concurrent answer/hint/end mutations are rejected with 409 to prevent duplicate turns. If generation fails after scoring, the scored answer remains saved and can be included in the report by ending the session.

## Demo and verification

1. Start with optional keys empty, track DSA, difficulty 2, duration 5, voice OFF.
2. Ask for a hint. Give an answer with approach, complexity, and edge cases.
3. Submit and expand feedback. Observe the next question's difficulty.
4. End the session (or let the five-minute timer expire), inspect topic bars and transcript, and download JSON.
5. Repeat a topic with a weaker answer. Dashboard weak spots aggregate completed answers across sessions and show average and attempt count.
6. For the submission write-up, collect `exports/session_<uuid>.json` and terminal telemetry. Restarting without Atlas clears in-memory dashboard history.

```sh
npm run build
npm test
rg 'openai|anthropic|google-generative|gemini' server client/src
```

Integration tests use a local Ollama protocol fixture, **not an actual LLM**. They exercise two complete sessions, strict score schema, hints, persisted exports, weak-spot updates, absent optional keys, malformed-output retries, and request validation. A DOM rendering test also checks the report card, transcript, topic scores, weak spots, and JSON download link. Live-model and Docker verification evidence is recorded in `VERIFICATION.md`.

Known limitations: no auth; interrupted sessions cannot be resumed in the UI; feedback Markdown is shown as readable plain text; Atlas outages retain current-process sessions but do not automatically replay failed writes; the requested legacy `ollama-ai-provider`/AI SDK v4 chain retains low-severity dependency advisories. A patched `jsondiffpatch` override removes its higher-severity advisories.
