import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { App } from "../client/src/App.js";
test("history opens a rendered report with topic scores, weak spots, transcript and JSON download", async () => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "http://localhost:3000",
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const oldFetch = globalThis.fetch;
  const score = {
    correctness: 4,
    approach: 4,
    complexity_analysis: 4,
    edge_cases: 4,
    communication: 5,
    overall: 4.2,
    feedback_markdown: "Discuss edge cases.",
  };
  const report = {
    session_id: "demo",
    overall: 4.2,
    topics: [{ topic: "Arrays", avg_score: 4.2, attempts: 1 }],
    weak_spots: [{ topic: "Arrays", avg_score: 4.2, attempts: 2 }],
    transcript: [
      {
        question: {
          question: "Find a pair.",
          topic: "Arrays",
          difficulty: 2,
          hints: ["a", "b", "c"],
        },
        answer: "Use a map.",
        score,
        answered_at: new Date().toISOString(),
      },
    ],
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
  };
  globalThis.fetch = async (input: any) =>
    new Response(
      JSON.stringify(
        String(input).includes("dashboard")
          ? {
              sessions: [
                {
                  id: "demo",
                  track: "DSA",
                  started_at: report.started_at,
                  ended_at: report.ended_at,
                  overall: 4.2,
                  question_count: 1,
                },
              ],
              weak_spots: report.weak_spots,
              progress: [
                { session_id: "demo", date: report.ended_at, score: 4.2 },
              ],
            }
          : String(input).includes("health")
            ? { status: "ready", model: "gemma3:4b", voice_available: false }
            : { report_card: report },
      ),
    );
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () => root.render(React.createElement(App)));
    assert.match(document.body.textContent!, /Your training log/);
    const row = document.querySelector<HTMLButtonElement>(".history-row")!;
    await act(async () => row.click());
    assert.match(document.body.textContent!, /THE VERDICT/);
    assert.match(document.body.textContent!, /4.2/);
    assert.match(document.body.textContent!, /Topic breakdown/);
    assert.match(document.body.textContent!, /4.2 avg over 2 answers/);
    assert.match(document.body.textContent!, /Use a map/);
    assert.equal(
      document.querySelector("a[download]")?.getAttribute("href"),
      "/api/interview/demo/export",
    );
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = oldFetch;
    dom.window.close();
  }
});
