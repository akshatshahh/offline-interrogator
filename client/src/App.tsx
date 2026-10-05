import React, { useState, useEffect, useRef } from "react";
import type { Question, Score, Report } from "../../server/schemas";
async function api(path: string, body?: unknown) {
  const r = await fetch(
    `/api/${path}`,
    body
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : undefined,
  );
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "Request failed");
  return data;
}
export function App() {
  const [screen, setScreen] = useState<"setup" | "room" | "report">("setup"),
    [track, setTrack] = useState("DSA"),
    [difficulty, setDifficulty] = useState(2),
    [duration, setDuration] = useState(5),
    [voice, setVoice] = useState(false),
    [sid, setSid] = useState(""),
    [question, setQuestion] = useState<Question | null>(null),
    [answer, setAnswer] = useState(""),
    [hint, setHint] = useState(""),
    [score, setScore] = useState<Score | null>(null),
    [report, setReport] = useState<Report | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [dashboard, setDashboard] = useState<any>({
      sessions: [],
      weak_spots: [],
      progress: [],
    }),
    [now, setNow] = useState(Date.now()),
    [start, setStart] = useState(Date.now()),
    [qstart, setQstart] = useState(Date.now()),
    [count, setCount] = useState(0),
    [health, setHealth] = useState<any>(null),
    [listening, setListening] = useState(false);
  const [pausedAt, setPausedAt] = useState<number | null>(null);
  const [voiceStatus, setVoiceStatus] = useState("");
  const audio = useRef<HTMLAudioElement | null>(null),
    recognition = useRef<any>(null),
    ending = useRef(false);
  async function refresh() {
    try {
      setDashboard(await api("dashboard/avinash"));
      setHealth(await api("health"));
    } catch {}
  }
  useEffect(() => {
    refresh();
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(timer);
      audio.current?.pause();
      recognition.current?.stop();
    };
  }, []);
  useEffect(() => {
    audio.current?.pause();
    if (!voice || !question || screen !== "room") return;
    setVoiceStatus("Loading ElevenLabs audio…");
    const controller = new AbortController();
    let url: string | undefined;
    fetch("/api/voice", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: question.question }),
      signal: controller.signal,
    })
      .then(async (r) => {
        if (r.status === 204) {
          setVoiceStatus("Voice is not configured.");
          return;
        }
        if (!r.ok) {
          const data = await r.json();
          throw new Error(data.error || "Voice unavailable");
        }
        url = URL.createObjectURL(await r.blob());
        if (!audio.current) return;
        audio.current.src = url;
        setVoiceStatus("ElevenLabs question audio ready");
        audio.current
          .play()
          .catch(() =>
            setVoiceStatus(
              "Press Play below to hear the question—your browser blocked autoplay.",
            ),
          );
      })
      .catch((e) => {
        if (e.name !== "AbortError") setVoiceStatus(e.message);
      });
    return () => {
      controller.abort();
      audio.current?.pause();
      if (url) URL.revokeObjectURL(url);
    };
  }, [question, voice, screen]);
  async function action(fn: () => Promise<void>) {
    const pauseStart = Date.now();
    const inRoom = screen === "room";
    const oldQstart = qstart;
    if (inRoom) setPausedAt(pauseStart);
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      if (inRoom) {
        const elapsed = Date.now() - pauseStart;
        setStart((s) => s + elapsed);
        setQstart((q) => (q === oldQstart ? q + elapsed : q));
        setNow(Date.now());
        setPausedAt(null);
      }
      setBusy(false);
    }
  }
  async function finish() {
    if (ending.current) return;
    ending.current = true;
    await action(async () => {
      const data = await api("interview/end", { session_id: sid });
      setReport(data.report_card);
      setScreen("report");
      await refresh();
    });
    ending.current = false;
  }
  useEffect(() => {
    if (screen !== "room") recognition.current?.stop();
  }, [screen]);
  const remaining = Math.max(
    0,
    duration * 60 - Math.floor(((pausedAt ?? now) - start) / 1000),
  );
  useEffect(() => {
    if (screen === "room" && remaining === 0 && !busy && !ending.current)
      finish();
  }, [remaining, screen, busy]);
  function mic() {
    const Speech =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition;
    if (!Speech) {
      setError(
        "Speech recognition is not supported in this browser. Type your answer below.",
      );
      return;
    }
    if (listening) {
      recognition.current?.stop();
      return;
    }
    const r = new Speech();
    recognition.current = r;
    r.continuous = true;
    r.interimResults = false;
    r.lang = "en-US";
    r.onresult = (event: any) => {
      let text = "";
      for (let i = event.resultIndex; i < event.results.length; i++)
        if (event.results[i].isFinal)
          text += event.results[i][0].transcript + " ";
      setAnswer((a) => a + text);
    };
    r.onend = () => setListening(false);
    r.onerror = () => {
      setListening(false);
      setError("Microphone unavailable. You can still type your answer.");
    };
    try {
      r.start();
      setListening(true);
    } catch {
      setError("Unable to start microphone.");
    }
  }
  return (
    <main>
      <header>
        <a
          onClick={() => {
            if (screen !== "room") {
              setScreen("setup");
              refresh();
            }
          }}
        >
          OI<span> / THE OFFLINE INTERROGATOR</span>
        </a>
        <div className="status">
          <i className={health?.status === "ready" ? "ready" : ""} />{" "}
          {health?.model || "gemma3:4b"} · LOCAL CORE
        </div>
      </header>
      {error && (
        <div role="alert" className="error">
          {error}
          <button onClick={() => setError("")}>×</button>
        </div>
      )}
      {screen === "setup" && (
        <>
          <div className="hero">
            <p className="eyebrow">MADE FOR AVINASH / HACKTOBERFEST 2026</p>
            <h1>
              Your next interview.
              <br />
              <em>No easy questions.</em>
            </h1>
            <p className="muted">
              A strict interviewer. Honest feedback. Open-weight intelligence
              running on your machine.
            </p>
          </div>
          <section className="setup panel">
            <div>
              <label>01 / TRACK</label>
              <div className="choices">
                {["DSA", "Behavioral", "System Design"].map((t) => (
                  <button
                    className={track === t ? "selected" : ""}
                    onClick={() => setTrack(t)}
                    key={t}
                  >
                    {t}
                  </button>
                ))}
              </div>
              <label>
                02 / DIFFICULTY <strong>{difficulty} / 5</strong>
              </label>
              <input
                aria-label="Difficulty"
                type="range"
                min="1"
                max="5"
                value={difficulty}
                onChange={(e) => setDifficulty(+e.target.value)}
              />
              <div className="range-labels">
                <span>Fundamentals</span>
                <span>Staff-level pressure</span>
              </div>
            </div>
            <div>
              <label>03 / DURATION</label>
              <select
                value={duration}
                onChange={(e) => setDuration(+e.target.value)}
              >
                {[5, 10, 15, 30, 45, 60].map((n) => (
                  <option key={n} value={n}>
                    {n} minutes
                  </option>
                ))}
              </select>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={voice}
                  onChange={(e) => setVoice(e.target.checked)}
                />{" "}
                Read questions aloud <small>Optional · ElevenLabs</small>
              </label>
              {!health?.voice_available && voice && (
                <p className="muted">
                  Voice keys missing. Interview will run silently.
                </p>
              )}
              <button
                className="primary"
                disabled={busy}
                onClick={() =>
                  action(async () => {
                    const d = await api("interview/start", {
                      track,
                      difficulty,
                      duration_min: duration,
                    });
                    setSid(d.session_id);
                    setQuestion(d.first_question);
                    setScore(null);
                    setCount(0);
                    setAnswer("");
                    setHint("");
                    setStart(Date.parse(d.started_at));
                    setQstart(Date.now());
                    setScreen("room");
                  })
                }
              >
                {busy ? "GEMMA IS THINKING…" : "START INTERVIEW ↗"}
              </button>
            </div>
          </section>
          {health?.status !== "ready" && (
            <p className="notice">
              Start Ollama and run <code>ollama pull gemma3:4b</code> to enable
              interviews.
            </p>
          )}
          <section className="history">
            <div className="section-title">
              <h2>Your training log</h2>
              <span>{dashboard.sessions.length} sessions</span>
            </div>
            {dashboard.progress.length > 0 && (
              <div
                className="progress-log"
                aria-label="Score progress across sessions"
              >
                {dashboard.progress.slice(-12).map((p: any, i: number) => (
                  <div
                    key={p.session_id}
                    title={new Date(p.date).toLocaleString()}
                  >
                    <span>{p.score} / 10</span>
                    <progress max="10" value={p.score || 0} />
                    <small>Session {i + 1}</small>
                  </div>
                ))}
              </div>
            )}
            {dashboard.weak_spots.length > 0 && (
              <div className="callouts">
                {dashboard.weak_spots.map((w: any) => (
                  <div key={w.topic}>
                    <strong>{w.topic}</strong>
                    <p>
                      {w.avg_score} avg over {w.attempts} answers — drill this
                    </p>
                  </div>
                ))}
              </div>
            )}
            {dashboard.sessions.length === 0 ? (
              <p className="muted">
                No sessions yet. Your first rep starts above.
              </p>
            ) : (
              dashboard.sessions.map((s: any) => (
                <button
                  className="history-row"
                  key={s.id}
                  disabled={!s.ended_at || busy}
                  onClick={() =>
                    action(async () => {
                      setSid(s.id);
                      setReport(
                        (await api(`interview/${s.id}/report`)).report_card,
                      );
                      setScreen("report");
                    })
                  }
                >
                  <span>
                    {s.track}
                    <small>{new Date(s.started_at).toLocaleString()}</small>
                  </span>
                  <span>{s.question_count} answers</span>
                  <strong>
                    {s.ended_at ? `${s.overall} / 10` : "In progress"}
                  </strong>
                </button>
              ))
            )}
          </section>
        </>
      )}
      {screen === "room" && (
        <>
          <div className="room-top">
            <div>
              <p className="eyebrow">
                {track} / QUESTION {count + 1}
              </p>
              <h2>Stay sharp.</h2>
            </div>
            <div className="clock">
              {Math.floor(remaining / 60)}:
              {String(remaining % 60).padStart(2, "0")}
              <small>SESSION REMAINING</small>
            </div>
            <button disabled={busy} onClick={finish}>
              End session
            </button>
          </div>
          {busy && (
            <p className="notice">
              Timer paused while the interviewer is thinking.
            </p>
          )}
          <progress max={duration * 60} value={duration * 60 - remaining} />
          <section className="panel question">
            <div className="section-title">
              <span>
                {question?.topic || "Question unavailable"} · LEVEL{" "}
                {question?.difficulty}
              </span>
              <span>
                {Math.floor(((pausedAt ?? now) - qstart) / 60000)}:
                {String(
                  Math.floor(((pausedAt ?? now) - qstart) / 1000) % 60,
                ).padStart(2, "0")}{" "}
                on question
              </span>
            </div>
            <h2>
              {question?.question ||
                "Your answer is saved. End the session to view your report."}
            </h2>
            {hint && <aside>{hint}</aside>}
            <button
              disabled={busy || !question}
              onClick={() =>
                action(async () =>
                  setHint(
                    (await api("interview/hint", { session_id: sid })).hint,
                  ),
                )
              }
            >
              Give me a hint
            </button>
          </section>
          {voice && (
            <section className="panel">
              <p role="status">{voiceStatus}</p>
              <audio
                ref={audio}
                controls
                aria-label="ElevenLabs question audio"
                style={{ width: "100%" }}
              />
            </section>
          )}
          {score && (
            <section className="score panel">
              <strong>
                {score.overall} <small>/ 10 · LAST ANSWER</small>
              </strong>
              <details>
                <summary>Interviewer feedback</summary>
                <p className="feedback">{score.feedback_markdown}</p>
              </details>
            </section>
          )}
          <label>
            YOUR ANSWER{" "}
            <small>Think aloud. Explain tradeoffs and edge cases.</small>
          </label>
          <textarea
            value={answer}
            disabled={busy || !question}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder="Walk me through your approach…"
          />
          <div className="answer-actions">
            <button disabled={busy || !question} onClick={mic}>
              {listening ? "■ Stop mic" : "● Use mic"}
            </button>
            <span className="muted">
              Browser speech may use an online service.
            </span>
            <button
              className="primary"
              disabled={busy || !question || !answer.trim()}
              onClick={() =>
                action(async () => {
                  recognition.current?.stop();
                  const d = await api("interview/answer", {
                    session_id: sid,
                    answer_text: answer,
                  });
                  setScore(d.score);
                  setCount((c) => c + 1);
                  setAnswer("");
                  setHint("");
                  setQuestion(d.next_question);
                  setQstart(Date.now());
                  if (d.next_error) setError(d.next_error);
                  if (d.report_card) {
                    setReport(d.report_card);
                    setScreen("report");
                    await refresh();
                  }
                })
              }
            >
              {busy ? "GEMMA IS THINKING…" : "SUBMIT ANSWER ↗"}
            </button>
          </div>
        </>
      )}
      {screen === "report" && report && (
        <>
          <div className="report-hero">
            <p className="eyebrow">SESSION COMPLETE / THE VERDICT</p>
            <h1>
              {report.overall}
              <small> / 10</small>
            </h1>
            <p className="muted">
              {report.transcript.length} answers. Honest feedback. One step
              closer.
            </p>
            <button onClick={() => setScreen("setup")}>Train again ↗</button>
            <a
              className="button"
              href={`/api/interview/${sid}/export`}
              download
            >
              Download session JSON ↓
            </a>
          </div>
          <section className="report-grid">
            <div className="panel">
              <h2>Topic breakdown</h2>
              {report.topics.length === 0 && <p>No answers submitted.</p>}
              {report.topics.map((t) => (
                <div className="bar" key={t.topic}>
                  <div>
                    <span>{t.topic}</span>
                    <strong>{t.avg_score} / 10</strong>
                  </div>
                  <progress max="10" value={t.avg_score} />
                </div>
              ))}
            </div>
            <div className="panel">
              <h2>Where to push next</h2>
              {report.weak_spots.length ? (
                report.weak_spots.map((t) => (
                  <div className="weak" key={t.topic}>
                    <strong>{t.topic}</strong>
                    <p>
                      {t.avg_score} avg over {t.attempts} answers — drill this
                    </p>
                  </div>
                ))
              ) : (
                <p className="muted">
                  No weak spots recorded. Try a harder level.
                </p>
              )}
            </div>
          </section>
          <details className="panel transcript">
            <summary>Full interview transcript</summary>
            {report.transcript.map((t, i) => (
              <article key={i}>
                <p className="eyebrow">
                  QUESTION {i + 1} / {t.question.topic}
                </p>
                <h3>{t.question.question}</h3>
                <p className="feedback">{t.answer}</p>
                <strong>Score: {t.score.overall} / 10</strong>
                <p className="feedback">{t.score.feedback_markdown}</p>
                <div className="rubric">
                  {(
                    [
                      "correctness",
                      "approach",
                      "complexity_analysis",
                      "edge_cases",
                      "communication",
                    ] as const
                  ).map((k) => (
                    <span key={k}>
                      {k.replaceAll("_", " ")}: {t.score[k]}
                    </span>
                  ))}
                </div>
              </article>
            ))}
          </details>
        </>
      )}
      <footer>
        OPEN WEIGHTS. LOCAL REASONING. NO CLOUD LLM CALLS.
        <span>Gemma 3 × Ollama × Mastra</span>
      </footer>
    </main>
  );
}
