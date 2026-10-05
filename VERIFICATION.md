# Verification — October 4, 2026

## Automated checks

- `npm run build`: passed (TypeScript + production Vite build).
- `npm test`: 4 tests passed. Covers two complete API sessions, strict score schema, hints, exports, weak-spot aggregation, zero optional keys, malformed-model JSON retries, expired-session behavior, and rendered React report content/download link.
- `docker compose config --quiet`: passed.
- Core-path grep for OpenAI/Anthropic/Gemini SDK usage: no matches.

## Real local inference

- Installed Ollama and downloaded `gemma3:4b` (3.3 GB).
- `ollama run gemma3:4b`: returned `LOCAL_GEMMA_READY`.
- Native API: generated a Binary Search question, returned a hint, scored a strong answer at **8.8/10**, and generated a harder next question. All reasoning used local Gemma.
- Docker API: generated Binary Search questions and valid JSON scores of **2.8/10** and **1.4/10** for weak answers; next question difficulty dropped to level 1.
- Docker telemetry captured actual Ollama usage, for example `score_answer`: model `gemma3:4b`, latency `15744` ms, prompt tokens `222`, completion tokens `240`.

- Timed five-minute Docker interview completed at its deadline, generated a report, and wrote `exports/session_1746908e-1ac2-4c76-92a0-3babc1342051.json`.
- Two real Binary Search sessions updated the dashboard weak spot to **2.1/10 over 2 attempts**.

## Docker runtime

- Built and started the full app + Ollama stack, with all optional keys unset. Health endpoint reported `ready`, model `gemma3:4b`, voice unavailable.
- Initial model registry pull returned HTTP 503. Copied the already-downloaded identical weights into Docker's named cache, then Compose started successfully. The init service now skips downloads for cached weights.
- Docker Ollama runs with `OLLAMA_NO_CLOUD=true`; question generation, scoring, and hints use its local container API.

## Limits of verification

Atlas was connected successfully and its sessions, turns, and 24 seed questions were inspected. ElevenLabs returned audio/mpeg from both a direct voice test and the app voice route. Sentry accepted a labeled test event with HTTP 200; a test trace was also submitted. Actual interview traces should be captured in the Sentry UI for the submission. Render deployment remains untested. Missing-key behavior was tested. Native browser automation stalled; React report rendering was verified with a DOM test rather than a screenshot. Five low-severity dependency advisories remain in the legacy AI SDK/provider dependency chain; the higher-severity jsondiffpatch advisories were patched.
