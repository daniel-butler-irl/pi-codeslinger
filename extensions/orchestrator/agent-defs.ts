/**
 * Agent definitions: the structured representation of one subagent's
 * configuration — provider, model, tool set, and system prompt.
 *
 * Definitions live as markdown files with YAML frontmatter under
 * ./agents/<name>.md, following the same shape as Pi's subagent example
 * (which is the closest thing Pi has to a convention here — "agents" is
 * not itself a Pi package primitive).
 *
 * Example frontmatter:
 *
 *   ---
 *   name: intent-reviewer
 *   description: Adversarial reviewer for implementation artifacts.
 *   provider: openai
 *   model: gpt-4o
 *   tools: read, grep, find, ls
 *   ---
 *
 *   You are the adversarial reviewer. Your job is to find what's broken…
 */
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

export interface AgentDefinition {
  /** Unique name (kebab-case). Matches filename sans extension. */
  name: string;
  /** One-line purpose statement. */
  description: string;
  /**
   * Provider id as Pi knows it (e.g. "ibm-bob", "openai").
   * Omit to run in the main chat session instead of a subagent.
   */
  provider?: string;
  /**
   * Model id within the provider (e.g. "premium", "gpt-4o").
   * Omit to run in the main chat session instead of a subagent.
   */
  model?: string;
  /** Built-in tool names the agent may use. See extensions/orchestrator/tools. */
  tools: string[];
  /** System prompt body — everything after the frontmatter. */
  systemPrompt: string;
}

/**
 * Parse a single agent markdown file.
 *
 * Throws if the frontmatter is missing, malformed, or missing a required
 * field. Definitions are a tight contract — a broken one should fail loud
 * at load time, not silently skip at dispatch.
 */
export function parseAgentDefinition(
  filename: string,
  content: string,
): AgentDefinition {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) {
    throw new Error(
      `Agent definition ${filename}: missing or malformed frontmatter`,
    );
  }
  const [, rawFrontmatter, body] = match;

  const fields: Record<string, string> = {};
  for (const line of rawFrontmatter.split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    fields[key] = value;
  }

  const required = ["name", "description"];
  for (const k of required) {
    if (!fields[k]) {
      throw new Error(
        `Agent definition ${filename}: missing required field "${k}"`,
      );
    }
  }

  return {
    name: fields.name,
    description: fields.description,
    ...(fields.provider ? { provider: fields.provider } : {}),
    ...(fields.model ? { model: fields.model } : {}),
    tools: (fields.tools ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
    systemPrompt: body.trim(),
  };
}

/**
 * Load every agent definition from a directory. Returns a map keyed by
 * agent name for O(1) lookup at dispatch time.
 */
export function loadAgentDefinitions(
  dir: string,
): Map<string, AgentDefinition> {
  const out = new Map<string, AgentDefinition>();
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(dir, entry);
    if (!entry.endsWith(".md")) continue;
    try {
      if (!statSync(path).isFile()) continue;
    } catch {
      continue;
    }
    const content = readFileSync(path, "utf-8");
    const def = parseAgentDefinition(entry, content);
    if (out.has(def.name)) {
      throw new Error(
        `Duplicate agent definition name "${def.name}" loaded from ${path}`,
      );
    }
    out.set(def.name, def);
  }
  return out;
}

/**
 * Audit loaded definitions against the canonical role names the driver
 * binds to. Canonical roles MUST have provider+model — fresh-subagent
 * dispatch is the contract. Non-canonical defs without provider+model
 * are reported as warnings; they would silently fall back to host-session
 * mode otherwise.
 */
export interface AgentDefAudit {
  /** Hard errors: canonical names missing provider/model. */
  errors: string[];
  /** Soft warnings: non-canonical names missing provider/model. */
  warnings: string[];
}

export function auditAgentDefinitions(
  defs: Map<string, AgentDefinition>,
  canonicalNames: string[],
): AgentDefAudit {
  const errors: string[] = [];
  const warnings: string[] = [];
  const canonical = new Set(canonicalNames);

  for (const name of canonicalNames) {
    const def = defs.get(name);
    if (!def) {
      errors.push(
        `Canonical agent "${name}" is not loaded; orchestrator cannot run.`,
      );
      continue;
    }
    if (!def.provider || !def.model) {
      errors.push(
        `Canonical agent "${name}" must declare provider and model in frontmatter.`,
      );
    }
  }

  for (const [name, def] of defs) {
    if (canonical.has(name)) continue;
    if (!def.provider || !def.model) {
      warnings.push(
        `Agent "${name}" has no provider/model and would run in the host session.`,
      );
    }
  }

  return { errors, warnings };
}
