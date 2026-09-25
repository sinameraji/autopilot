import type Database from "better-sqlite3";
import type { LlmAuth } from "../agent/llm-auth.js";
import { fetchEmbeddings } from "../memory/embeddings.js";
import { discoverSkills, readSkillFile } from "./discovery.js";
import { parseSkillFile, parseAgentsMd } from "./parser.js";
import type { ParsedSkill } from "./types.js";
import {
  initSkillsSchema,
  upsertSkill,
  insertSections,
  deleteOrphanedSkills,
  getSkillByPath,
} from "./db.js";

export interface IndexerOpts extends LlmAuth {
  cwd: string;
  db: Database.Database;
  embeddingModel?: string;
}

/**
 * Build the embedding input for a section.
 * Prepends skill name/description to give the embedding model context.
 */
function buildEmbeddingInput(skill: ParsedSkill, section: ParsedSkill["sections"][number]): string {
  return `${skill.name}: ${skill.description}\n\n${section.heading}\n${section.body}`;
}

/**
 * Index all discoverable skills into the database.
 * Skips files whose content_hash matches the stored hash.
 * Removes skills whose files no longer exist.
 */
export async function indexSkills(opts: IndexerOpts): Promise<{
  indexed: number;
  skipped: number;
  removed: number;
  errors: string[];
}> {
  initSkillsSchema(opts.db);

  const discovered = await discoverSkills(opts.cwd);
  const errors: string[] = [];
  const parsedSkills: ParsedSkill[] = [];

  // Parse all discovered files
  for (const file of discovered) {
    try {
      const { text } = await readSkillFile(file.filePath);
      if (file.source === "agents-md") {
        const skills = parseAgentsMd(file.filePath, text);
        parsedSkills.push(...skills);
      } else {
        const skill = parseSkillFile(file.filePath, text);
        parsedSkills.push(skill);
      }
    } catch (err) {
      errors.push(`Failed to parse ${file.filePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Deduplicate by skill name (first wins based on discovery order)
  const seenNames = new Set<string>();
  const deduped: ParsedSkill[] = [];
  for (const skill of parsedSkills) {
    if (seenNames.has(skill.name)) continue;
    seenNames.add(skill.name);
    deduped.push(skill);
  }

  let indexed = 0;
  let skipped = 0;

  for (const skill of deduped) {
    const existing = getSkillByPath(opts.db, skill.filePath);
    if (existing && existing.contentHash === skill.contentHash && existing.parserVersion === skill.parserVersion) {
      skipped++;
      continue;
    }

    // Upsert skill (clears old sections)
    const skillId = upsertSkill(opts.db, skill);

    // Embed sections
    if (skill.sections.length > 0) {
      const inputs = skill.sections.map((section) => buildEmbeddingInput(skill, section));
      try {
        const embeddings = await fetchEmbeddings({
          openrouterApiKey: opts.openrouterApiKey,
          customEndpoint: opts.customEndpoint,
          model: opts.embeddingModel,
          texts: inputs,
        });
        insertSections(opts.db, skillId, skill.sections, embeddings);
      } catch (err) {
        errors.push(
          `Failed to embed sections for ${skill.filePath}: ${err instanceof Error ? err.message : String(err)}`
        );
        continue;
      }
    }

    indexed++;
  }

  // Remove orphaned skills
  const existingPaths = deduped.map((s) => s.filePath);
  const removed = deleteOrphanedSkills(opts.db, existingPaths);

  return { indexed, skipped, removed, errors };
}
