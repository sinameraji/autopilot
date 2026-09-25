import type Database from "better-sqlite3";
import type { LlmAuth } from "../agent/llm-auth.js";
import { fetchEmbeddings, cosineSimilarity } from "../memory/embeddings.js";
import { hasAnySections, listAllSectionRows, rowToSectionResult } from "./db.js";
import type { SectionResult } from "./types.js";

export interface SearchOpts extends LlmAuth {
  model?: string;
}

/**
 * Embed the query and rank all skill sections by cosine similarity.
 * Returns topN results sorted by similarity descending.
 */
export async function searchSections(
  query: string,
  db: Database.Database,
  opts: SearchOpts
): Promise<SectionResult[]> {
  if (!hasAnySections(db)) return [];

  const embeddings = await fetchEmbeddings({ ...opts, texts: [query] });
  const queryEmbedding = embeddings[0];
  if (!queryEmbedding) {
    throw new Error("Failed to embed query: no embedding returned");
  }

  const rows = listAllSectionRows(db);
  const scored: SectionResult[] = [];

  for (const row of rows) {
    const sectionEmbedding = new Float32Array(row.embedding);
    const similarity = cosineSimilarity(queryEmbedding, sectionEmbedding);
    scored.push({
      ...rowToSectionResult(row),
      similarity,
    });
  }

  scored.sort((a, b) => b.similarity - a.similarity);
  return scored;
}
