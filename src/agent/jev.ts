import { openRouterAlphaUrl, openRouterHeaders } from "../models/openrouter.js";

export const JEV_MODEL = "~typesafe/jev-latest";
export const JEV_DECISIONS_URL = "decisions";
export const JEV_TIMEOUT_MS = 30_000;

export type JevQuestion =
  | { kind: "yes"; prompt: string }
  | { kind: "choose"; prompt: string; options: string[] }
  | { kind: "score"; prompt: string; scale: string[] };

export interface JevAnswer {
  type: "noul" | "choice" | "score";
  noul?: number;
  probabilities?: Record<string, number>;
  score?: number;
  legend?: Record<string, string>;
}

interface JevApiResponse {
  answers?: Record<string, unknown>;
  error?: { message?: string };
}

function toRequestQuestion(question: JevQuestion): Record<string, unknown> {
  if (question.kind === "yes") {
    return { type: "noul", instructions: question.prompt };
  }
  if (question.kind === "choose") {
    return {
      type: "choice",
      instructions: question.prompt,
      criteria: Object.fromEntries(question.options.map((option) => [option, option])),
    };
  }
  return { type: "score", instructions: question.prompt, criteria: question.scale };
}

function parseAnswer(value: unknown): JevAnswer {
  if (!value || typeof value !== "object") throw new Error("Jev returned an empty answer.");
  const answer = value as Record<string, unknown>;
  if (answer.type !== "noul" && answer.type !== "choice" && answer.type !== "score") {
    throw new Error("Jev returned an unrecognized answer type.");
  }
  const probabilities = answer.probabilities;
  const validProbabilities =
    probabilities &&
    typeof probabilities === "object" &&
    !Array.isArray(probabilities) &&
    Object.values(probabilities).every((p) => typeof p === "number" && Number.isFinite(p));
  const legend = answer.legend;
  return {
    type: answer.type,
    ...(typeof answer.noul === "number" && Number.isFinite(answer.noul) ? { noul: answer.noul } : {}),
    ...(validProbabilities ? { probabilities: probabilities as Record<string, number> } : {}),
    ...(typeof answer.score === "number" && Number.isFinite(answer.score) ? { score: answer.score } : {}),
    ...(legend && typeof legend === "object" && !Array.isArray(legend)
      ? { legend: legend as Record<string, string> }
      : {}),
  };
}

/** Send a typed question to Jev through OpenRouter's Alpha Decisions API. */
export async function askJev(
  apiKey: string,
  question: JevQuestion,
  fetchImpl: typeof fetch = fetch,
  signal: AbortSignal = AbortSignal.timeout(JEV_TIMEOUT_MS),
): Promise<JevAnswer> {
  const response = await fetchImpl(openRouterAlphaUrl(JEV_DECISIONS_URL), {
    method: "POST",
    headers: { ...openRouterHeaders(apiKey), "Content-Type": "application/json" },
    body: JSON.stringify({
      model: JEV_MODEL,
      state: { question: question.prompt },
      questions: { answer: toRequestQuestion(question) },
    }),
    signal,
  });

  const raw = await response.text();
  let body: JevApiResponse;
  try {
    body = JSON.parse(raw) as JevApiResponse;
  } catch {
    throw new Error(`Jev returned an unreadable response (HTTP ${response.status}).`);
  }
  if (!response.ok) {
    const message = typeof body.error?.message === "string" ? body.error.message : response.statusText;
    throw new Error(`Jev request failed (HTTP ${response.status}): ${message || "unknown error"}`);
  }
  const answer = body.answers?.answer;
  if (!answer) throw new Error("Jev response did not include an answer.");
  return parseAnswer(answer);
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function mostLikely(probabilities: Record<string, number>): [string, number] | undefined {
  return Object.entries(probabilities).reduce<[string, number] | undefined>(
    (best, entry) => (!best || entry[1] > best[1] ? entry : best),
    undefined,
  );
}

/** Format Jev's typed values without inventing free-form reasoning. */
export function formatJevAnswer(question: JevQuestion, answer: JevAnswer): string {
  if (question.kind === "yes" && answer.type === "noul" && answer.noul !== undefined) {
    const pYes = Math.max(0, Math.min(1, answer.noul));
    const isYes = pYes >= 0.5;
    return `${isYes ? "Yes" : "No"} · ${percent(isYes ? pYes : 1 - pYes)} probability`;
  }
  if (question.kind === "choose" && answer.type === "choice" && answer.probabilities) {
    const best = mostLikely(answer.probabilities);
    if (best) return `${best[0]} · ${percent(best[1])} probability`;
  }
  if (question.kind === "score" && answer.type === "score" && answer.score !== undefined) {
    const best = answer.probabilities ? mostLikely(answer.probabilities) : undefined;
    const label = best ? answer.legend?.[best[0]] ?? best[0] : undefined;
    return `Score ${answer.score.toFixed(2)}${label ? ` · ${label}` : ""}`;
  }
  throw new Error("Jev returned an answer that does not match the requested question type.");
}
