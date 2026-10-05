import { MongoClient } from "mongodb";
import { seed } from "./seed.js";
import type { Session, Turn } from "./schemas.js";
const memory = new Map<string, Session>();
let db: ReturnType<MongoClient["db"]> | undefined;
export async function initStore() {
  if (!process.env.MONGODB_URI) {
    console.warn(
      "MONGODB_URI unset: using in-memory storage; history resets on restart.",
    );
    return;
  }
  try {
    const client = new MongoClient(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 3000,
    });
    await client.connect();
    db = client.db("offline_interrogator");
    await db.collection("sessions").createIndex({ id: 1 }, { unique: true });
    await db
      .collection("turns")
      .createIndex({ session_id: 1, index: 1 }, { unique: true });
    await db
      .collection("question_bank")
      .createIndex({ track: 1, topic: 1 }, { unique: true });
    await db
      .collection("question_bank")
      .bulkWrite(
        seed.map((q) => ({
          updateOne: {
            filter: { track: q.track, topic: q.topic },
            update: { $setOnInsert: q },
            upsert: true,
          },
        })),
      );
  } catch (e) {
    db = undefined;
    console.warn("Atlas unavailable: using in-memory fallback.", String(e));
  }
}
export async function saveSession(s: Session) {
  memory.set(s.id, structuredClone(s));
  if (db)
    try {
      await db
        .collection("sessions")
        .updateOne({ id: s.id }, { $set: s }, { upsert: true });
    } catch (e) {
      console.warn(
        "Atlas write failed; session retained in memory.",
        String(e),
      );
    }
}
export async function saveTurn(session_id: string, turn: Turn, index: number) {
  if (db)
    try {
      await db
        .collection("turns")
        .updateOne(
          { session_id, index },
          { $set: { session_id, index, ...turn } },
          { upsert: true },
        );
    } catch (e) {
      console.warn(
        "Atlas turn write failed; embedded session transcript retained.",
        String(e),
      );
    }
}
export async function getSession(id: string): Promise<Session | undefined> {
  if (memory.has(id)) return structuredClone(memory.get(id));
  if (db)
    try {
      const s = await db
        .collection("sessions")
        .findOne({ id }, { projection: { _id: 0 } });
      return (s as unknown as Session) ?? undefined;
    } catch (e) {
      console.warn("Atlas read failed.", String(e));
    }
  return undefined;
}
export async function history(user_id: string) {
  let sessions = [...memory.values()].filter((s) => s.user_id === user_id);
  if (db)
    try {
      const saved = await db
        .collection("sessions")
        .find({ user_id }, { projection: { _id: 0 } })
        .toArray();
      const merged = new Map(saved.map((s) => [s.id, s as unknown as Session]));
      sessions.forEach((s) => merged.set(s.id, s));
      sessions = [...merged.values()];
    } catch (e) {
      console.warn("Atlas history unavailable.", String(e));
    }
  return sessions.sort((a, b) => b.started_at.localeCompare(a.started_at));
}
export function topicStats(sessions: Session[]) {
  const groups = new Map<string, number[]>();
  for (const s of sessions)
    for (const t of s.turns) {
      const scores = groups.get(t.question.topic) || [];
      scores.push(t.score.overall);
      groups.set(t.question.topic, scores);
    }
  return [...groups]
    .map(([topic, scores]) => ({
      topic,
      avg_score:
        Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) /
        10,
      attempts: scores.length,
    }))
    .sort((a, b) => a.avg_score - b.avg_score);
}
export async function bank(track: string) {
  if (db)
    try {
      return await db
        .collection("question_bank")
        .find({ track }, { projection: { _id: 0 } })
        .toArray();
    } catch {}
  return seed.filter((q) => q.track === track);
}
