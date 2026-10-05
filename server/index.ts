import "dotenv/config";
import * as Sentry from "@sentry/node";
import express from "express";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { z } from "zod";
import {
  initStore,
  getSession,
  saveSession,
  saveTurn,
  history,
  topicStats,
} from "./store.js";
import { runTool } from "./tools.js";
import {
  trackSchema,
  type Question,
  type Score,
  type Report,
  type Session,
} from "./schemas.js";
import { modelName } from "./llm.js";
Sentry.init({ dsn: process.env.SENTRY_DSN || undefined, tracesSampleRate: 1 });
export const app = express();
app.use(express.json({ limit: "128kb" }));
const active = new Set<string>();
async function locked<T>(id: string, fn: () => Promise<T>) {
  if (active.has(id))
    throw Object.assign(new Error("Session is busy. Please wait."), {
      status: 409,
    });
  active.add(id);
  try {
    return await fn();
  } finally {
    active.delete(id);
  }
}
function route(
  fn: (req: express.Request, res: express.Response) => Promise<unknown>,
) {
  return (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    fn(req, res).catch(next);
  };
}
async function session(id: string) {
  z.string().uuid().parse(id);
  const s = await getSession(id);
  if (!s) throw Object.assign(new Error("Session not found"), { status: 404 });
  return s;
}
const expired = (s: Session) =>
  Date.now() >=
  Date.parse(s.started_at) + s.duration_min * 60000 + (s.paused_ms || 0);
app.get(
  "/api/health",
  route(async (_req, res) => {
    let ready = false;
    try {
      const r = await fetch(
        `${process.env.OLLAMA_BASE_URL || "http://localhost:11434"}/api/tags`,
        { signal: AbortSignal.timeout(3000) },
      );
      const data = (await r.json()) as { models?: { name: string }[] };
      ready = !!data.models?.some((m) => m.name === modelName);
    } catch {}
    res.json({
      status: ready ? "ready" : "ollama_unavailable",
      model: modelName,
      voice_available: !!(
        process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_VOICE_ID
      ),
    });
  }),
);
app.post(
  "/api/interview/start",
  route(async (req, res) => {
    const data = z
      .object({
        track: trackSchema,
        difficulty: z.number().int().min(1).max(5),
        duration_min: z.number().int().min(1).max(60),
      })
      .parse(req.body);
    const weak = await runTool("get_weak_spots", { user_id: "dhruv" });
    const first = (await runTool("generate_question", {
      ...data,
      avoid_topics: [],
      weak_spots: weak,
    })) as Question;
    const s: Session = {
      ...data,
      id: randomUUID(),
      user_id: "dhruv",
      started_at: new Date().toISOString(),
      current_question: first,
      hint_level: 0,
      turns: [],
    };
    await saveSession(s);
    res.json({
      session_id: s.id,
      first_question: first,
      started_at: s.started_at,
    });
  }),
);
app.post(
  "/api/interview/answer",
  route(async (req, res) => {
    const { session_id, answer_text } = z
      .object({
        session_id: z.string().uuid(),
        answer_text: z.string().trim().min(1).max(20000),
      })
      .parse(req.body);
    await locked(session_id, async () => {
      const s = await session(session_id);
      if (s.ended_at || !s.current_question)
        throw Object.assign(new Error("Session has ended"), { status: 409 });
      if (expired(s)) {
        res.json({
          score: null,
          feedback: "Time is up.",
          next_question: null,
          report_card: await runTool("end_session", { session_id }),
        });
        return;
      }
      const processingStart = Date.now();
      let score: Score;
      try {
        score = (await runTool("score_answer", {
          question: s.current_question.question,
          answer: answer_text,
        })) as Score;
      } catch (error) {
        s.paused_ms = (s.paused_ms || 0) + Date.now() - processingStart;
        await saveSession(s);
        throw error;
      }
      s.turns.push({
        question: s.current_question,
        answer: answer_text,
        score,
        answered_at: new Date().toISOString(),
      });
      s.difficulty = Math.max(
        1,
        Math.min(
          5,
          s.difficulty + (score.overall >= 8 ? 1 : score.overall < 5 ? -1 : 0),
        ),
      );
      s.hint_level = 0;
      await saveTurn(s.id, s.turns.at(-1)!, s.turns.length - 1);
      s.current_question = null;
      await saveSession(s);
      let next: Question | null = null;
      let next_error: string | undefined;
      try {
        next = (await runTool("generate_question", {
          track: s.track,
          difficulty: s.difficulty,
          avoid_topics: s.turns.map((t) => t.question.topic),
          weak_spots: await runTool("get_weak_spots", { user_id: s.user_id }),
        })) as Question;
      } catch {
        next_error =
          "Answer saved. Next question could not be generated; end the session for your report.";
      }
      s.paused_ms = (s.paused_ms || 0) + Date.now() - processingStart;
      s.current_question = next;
      await saveSession(s);
      res.json({
        score,
        feedback: score.feedback_markdown,
        next_question: next,
        next_error,
      });
    });
  }),
);
app.post(
  "/api/interview/hint",
  route(async (req, res) => {
    const { session_id } = z
      .object({ session_id: z.string().uuid() })
      .parse(req.body);
    await locked(session_id, async () => {
      const s = await session(session_id);
      if (s.ended_at || !s.current_question || expired(s))
        throw Object.assign(new Error("No active question"), { status: 409 });
      if (s.hint_level >= 3) {
        res.json({ hint: "All three hints have been used." });
        return;
      }
      const processingStart = Date.now();
      let result;
      try {
        result = await runTool("get_hint", {
          question: s.current_question.question,
          hint_level: s.hint_level + 1,
        });
      } finally {
        s.paused_ms = (s.paused_ms || 0) + Date.now() - processingStart;
        await saveSession(s);
      }
      s.hint_level++;
      await saveSession(s);
      res.json(result);
    });
  }),
);
app.post(
  "/api/interview/end",
  route(async (req, res) => {
    const { session_id } = z
      .object({ session_id: z.string().uuid() })
      .parse(req.body);
    await locked(session_id, async () => {
      await session(session_id);
      res.json({ report_card: await runTool("end_session", { session_id }) });
    });
  }),
);
app.get(
  "/api/dashboard/:user_id",
  route(async (req, res) => {
    const sessions = await history(String(req.params.user_id));
    const completed = sessions.filter((s) => s.ended_at);
    res.json({
      sessions: sessions.map(
        ({ turns, current_question, report_card, ...s }) => ({
          ...s,
          overall: report_card?.overall,
          question_count: turns.length,
        }),
      ),
      weak_spots: topicStats(completed).filter((t) => t.avg_score < 7),
      progress: completed
        .slice()
        .reverse()
        .map((s) => ({
          session_id: s.id,
          date: s.ended_at,
          score: s.report_card?.overall,
        })),
    });
  }),
);
app.get(
  "/api/interview/:session_id/export",
  route(async (req, res) => {
    const s = await session(String(req.params.session_id));
    if (!s.ended_at)
      throw Object.assign(new Error("Finish the session first"), {
        status: 409,
      });
    res.attachment(`session_${s.id}.json`).json(s);
  }),
);
app.get(
  "/api/interview/:session_id/report",
  route(async (req, res) => {
    const s = await session(String(req.params.session_id));
    if (!s.report_card)
      throw Object.assign(new Error("Report not ready"), { status: 409 });
    res.json({ report_card: s.report_card });
  }),
);
app.post(
  "/api/voice",
  route(async (req, res) => {
    const { text } = z
      .object({ text: z.string().min(1).max(5000) })
      .parse(req.body);
    if (!process.env.ELEVENLABS_API_KEY || !process.env.ELEVENLABS_VOICE_ID) {
      res.status(204).end();
      return;
    }
    try {
      const r = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(process.env.ELEVENLABS_VOICE_ID)}`,
        {
          method: "POST",
          headers: {
            "xi-api-key": process.env.ELEVENLABS_API_KEY,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ text, model_id: "eleven_flash_v2_5" }),
          signal: AbortSignal.timeout(30000),
        },
      );
      if (!r.ok) {
        res
          .status(502)
          .json({
            error:
              "ElevenLabs could not generate audio. Check voice access and remaining credits.",
          });
        return;
      }
      res.type("audio/mpeg").send(Buffer.from(await r.arrayBuffer()));
    } catch {
      res
        .status(502)
        .json({
          error: "Voice request timed out or failed. Try Read aloud again.",
        });
    }
  }),
);
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "API route not found" });
});
app.use(express.static(resolve("dist/client")));
app.get("/{*path}", (_req, res) =>
  res.sendFile(resolve("dist/client/index.html")),
);
app.use(
  (
    err: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: "Invalid request", details: err.issues });
      return;
    }
    const e = err as Error & { status?: number };
    Sentry.captureException(err);
    console.error(e.message);
    res.status(e.status || 503).json({
      error: e.status
        ? e.message
        : "Local model or storage unavailable. Check Ollama is running and gemma3:4b is pulled. Your saved answers are retained.",
    });
  },
);
await initStore();
if (process.env.NODE_ENV !== "test")
  app.listen(Number(process.env.PORT || 3000), "0.0.0.0", () =>
    console.log(
      `Offline Interrogator :${process.env.PORT || 3000} model=${modelName}`,
    ),
  );
