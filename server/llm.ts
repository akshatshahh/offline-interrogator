import { createOllama } from "ollama-ai-provider";
import { generateText } from "ai-v4";
import * as Sentry from "@sentry/node";
import { z } from "zod";
export const modelName = process.env.OLLAMA_MODEL || "gemma3:4b";
if (modelName.includes("cloud"))
  throw new Error(
    "Cloud Ollama models are prohibited; use local Gemma weights.",
  );
const base = (process.env.OLLAMA_BASE_URL || "http://localhost:11434").replace(
  /\/$/,
  "",
);
export const ollama = createOllama({ baseURL: `${base}/api` });
export const model = ollama(modelName);
export const interviewerPrompt =
  "You are a terse, no-nonsense FAANG interviewer running a mock interview for a friend. Ask one question at a time. Direct, slightly intimidating but fair. Never reveal the rubric. Adapt: candidate nails it → go harder; struggles → drop a level and probe fundamentals.";
export const scorerPrompt =
  "You are a strict interview rubric scorer. Score 1-10: correctness, approach, complexity analysis, edge cases, communication. Return ONLY valid JSON matching the schema. Be honest — wrong answers get low scores with specific feedback on what was missing.";
export async function jsonCall<T>(
  name: string,
  system: string,
  prompt: string,
  schema: z.ZodType<T>,
): Promise<T> {
  const toolSpan = Sentry.getActiveSpan();
  return Sentry.startSpan(
    { name: `tool.${name}`, op: "ai.tool", attributes: { model: modelName } },
    async (span) => {
      const start = Date.now();
      let promptTokens = 0,
        completionTokens = 0;
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          const response = await generateText({
            model,
            system,
            prompt:
              prompt +
              (attempt
                ? "\nYour previous response was invalid. Return only the requested JSON, without fences."
                : ""),
            temperature: 0.2,
            abortSignal: AbortSignal.timeout(120000),
          });
          promptTokens += response.usage.promptTokens ?? 0;
          completionTokens += response.usage.completionTokens ?? 0;
          try {
            const raw = response.text
              .trim()
              .replace(/^```(?:json)?\s*/, "")
              .replace(/\s*```$/, "");
            return schema.parse(JSON.parse(raw));
          } catch (e) {
            if (attempt === 1)
              throw new Error(
                `Gemma returned invalid ${name} JSON: ${String(e)}`,
              );
          }
        }
        throw new Error("Model response missing");
      } finally {
        const attributes = {
          model: modelName,
          latency_ms: Date.now() - start,
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
        };
        span?.setAttributes(attributes);
        toolSpan?.setAttributes(attributes);
        console.log(JSON.stringify({ tool: name, ...attributes }));
      }
    },
  );
}
