import "dotenv/config";
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import * as Sentry from "@sentry/node";
import type { Server } from "node:http";
import { readFile, rm } from "node:fs/promises";
let fake: Server, server: Server, base: string;
let bad = false;
let scoreDelay = 0;
let called = 0;
const ids: string[] = [];
before(async () => {
  const ollama = express();
  ollama.use(express.json());
  ollama.get("/api/tags", (_req, res) =>
    res.json({ models: [{ name: "gemma3:4b" }] }),
  );
  ollama.post("/api/chat", async (req, res) => {
    assert.equal(req.body.model, "gemma3:4b");
    called++;
    const prompt = req.body.messages.at(-1).content;
    if (prompt.includes("numeric scores") && scoreDelay)
      await new Promise((r) => setTimeout(r, scoreDelay));
    const result = prompt.includes("numeric scores")
      ? {
          correctness: 4,
          approach: 4,
          complexity_analysis: 4,
          edge_cases: 4,
          communication: 5,
          overall: 4.2,
          feedback_markdown: "Missing edge cases and complexity analysis.",
        }
      : prompt.includes("hint level")
        ? { hint: "Consider a hash map." }
        : {
            question: "Find two numbers that sum to a target.",
            topic: "Arrays",
            difficulty: 2,
            hints: ["Clarify input", "Try a map", "Consider duplicates"],
          };
    res.json({
      model: "gemma3:4b",
      created_at: new Date().toISOString(),
      message: {
        role: "assistant",
        content: bad ? "broken json" : JSON.stringify(result),
      },
      done: true,
      done_reason: "stop",
      total_duration: 100,
      load_duration: 0,
      prompt_eval_count: 12,
      prompt_eval_duration: 1,
      eval_count: 20,
      eval_duration: 1,
    });
  });
  fake = ollama.listen(0, "127.0.0.1");
  await new Promise<void>((r) => fake.once("listening", r));
  process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${(fake.address() as any).port}`;
  delete process.env.MONGODB_URI;
  delete process.env.ELEVENLABS_API_KEY;
  delete process.env.SENTRY_DSN;
  const { app } = await import("../server/index.js");
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(async () => {
  server?.close();
  fake?.close();
  await Promise.all(
    ids.map((id) => rm(`exports/session_${id}.json`, { force: true })),
  );
});
async function post(path: string, body: unknown) {
  return fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
test("two sessions: Mastra tools, strict scores, hints, adaptive question, report, export and weak spots with zero optional keys", async () => {
  for (let i = 0; i < 2; i++) {
    const start = await post("/api/interview/start", {
      track: "DSA",
      difficulty: 2,
      duration_min: 5,
    });
    assert.equal(start.status, 200);
    const { session_id, first_question } = await start.json();
    ids.push(session_id);
    assert.equal(first_question.topic, "Arrays");
    assert.equal(
      (await (await post("/api/interview/hint", { session_id })).json()).hint,
      "Consider a hash map.",
    );
    const scored = await post("/api/interview/answer", {
      session_id,
      answer_text: "I would use a hash map.",
    });
    assert.equal(scored.status, 200);
    const answer = await scored.json();
    assert.equal(answer.score.overall, 4.2);
    assert.equal(answer.next_question.topic, "Arrays");
    const end = await post("/api/interview/end", { session_id });
    assert.equal(end.status, 200);
    const { report_card } = await end.json();
    assert.equal(report_card.overall, 4.2);
    assert.equal(report_card.transcript.length, 1);
    const exported = JSON.parse(
      await readFile(`exports/session_${session_id}.json`, "utf8"),
    );
    assert.equal(exported.turns.length, 1);
    assert.equal(
      (await fetch(`${base}/api/interview/${session_id}/export`)).status,
      200,
    );
    assert.deepEqual(
      (await (await post("/api/interview/end", { session_id })).json())
        .report_card,
      report_card,
    );
  }
  const dash = await (await fetch(base + "/api/dashboard/dhruv")).json();
  assert.equal(dash.sessions.length, 2);
  assert.deepEqual(dash.weak_spots, [
    { topic: "Arrays", avg_score: 4.2, attempts: 2 },
  ]);
  assert.equal(dash.progress.length, 2);
  assert.equal((await post("/api/voice", { text: "Hello" })).status, 204);
  assert.equal(
    (await post("/api/interview/start", { track: "bad" })).status,
    400,
  );
  assert.equal((await fetch(base + "/api/health")).status, 200);
  assert.ok(called >= 8);
});
test("malformed model output retries then returns an actionable error", async () => {
  bad = true;
  const r = await post("/api/interview/start", {
    track: "DSA",
    difficulty: 2,
    duration_min: 5,
  });
  assert.equal(r.status, 503);
  bad = false;
});

test("expired sessions end without scoring late answers; ended sessions reject new hints", async () => {
  const start = await (
    await post("/api/interview/start", {
      track: "DSA",
      difficulty: 2,
      duration_min: 5,
    })
  ).json();
  ids.push(start.session_id);
  const { getSession, saveSession } = await import("../server/store.js");
  const s = (await getSession(start.session_id))!;
  s.started_at = new Date(Date.now() - 6 * 60000).toISOString();
  await saveSession(s);
  const beforeCalls = called;
  const r = await post("/api/interview/answer", {
    session_id: s.id,
    answer_text: "Late answer",
  });
  assert.equal(r.status, 200);
  const result = await r.json();
  assert.equal(result.next_question, null);
  assert.equal(result.report_card.transcript.length, 0);
  assert.equal(called, beforeCalls);
  assert.equal(
    (await post("/api/interview/hint", { session_id: s.id })).status,
    409,
  );
});

test("model processing does not consume the remaining interview budget", async () => {
  const start = await (
    await post("/api/interview/start", {
      track: "DSA",
      difficulty: 2,
      duration_min: 5,
    })
  ).json();
  ids.push(start.session_id);
  const { getSession, saveSession } = await import("../server/store.js");
  const s = (await getSession(start.session_id))!;
  s.started_at = new Date(Date.now() - 299500).toISOString();
  await saveSession(s);
  scoreDelay = 1200;
  try {
    const r = await post("/api/interview/answer", {
      session_id: s.id,
      answer_text: "Use a map.",
    });
    assert.equal(r.status, 200);
    const result = await r.json();
    assert.ok(result.next_question);
    assert.equal(result.report_card, undefined);
    const saved = (await getSession(s.id))!;
    assert.ok(saved.paused_ms! >= 1200);
    assert.ok(
      Date.now() < Date.parse(saved.started_at) + 300000 + saved.paused_ms!,
    );
  } finally {
    scoreDelay = 0;
  }
});

test("Sentry telemetry is disabled for local tests", () => {
  assert.equal(Sentry.getClient()?.getOptions().enabled, false);
});
