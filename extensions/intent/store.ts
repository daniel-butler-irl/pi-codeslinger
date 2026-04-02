/**
 * Intent store — file-based persistence for the intent bar.
 *
 * Metadata lives in <cwd>/.pi/intents.json.
 * Rich content (description, goals, tasks, etc.) lives in <cwd>/.pi/intents/<id>.md.
 *
 * Separating the two lets the .md file grow freely without touching the metadata
 * index, and lets the LLM read/edit intent content as a plain file.
 */
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  unlinkSync,
} from "fs";
import { join } from "path";

export interface Intent {
  id: string;
  title: string;
  createdAt: number;
}

export interface IntentStore {
  activeIntentId: string | null;
  intents: Intent[];
}

function piDir(cwd: string): string {
  return join(cwd, ".pi");
}

function storePath(cwd: string): string {
  return join(piDir(cwd), "intents.json");
}

export function intentFilePath(cwd: string, id: string): string {
  return join(piDir(cwd), "intents", `${id}.md`);
}

/**
 * Load the intent store metadata from disk.
 * Returns an empty store if the file doesn't exist or is corrupt.
 */
export function loadStore(cwd: string): IntentStore {
  try {
    const raw = readFileSync(storePath(cwd), "utf-8");
    return JSON.parse(raw) as IntentStore;
  } catch {
    return { activeIntentId: null, intents: [] };
  }
}

/**
 * Save the intent store metadata atomically.
 */
export function saveStore(cwd: string, store: IntentStore): void {
  mkdirSync(piDir(cwd), { recursive: true });
  const tmp = storePath(cwd) + ".tmp";
  writeFileSync(tmp, JSON.stringify(store, null, 2), "utf-8");
  renameSync(tmp, storePath(cwd));
}

/**
 * Read the markdown content for an intent.
 * Returns an empty string if the file doesn't exist yet.
 */
export function loadIntentContent(cwd: string, id: string): string {
  try {
    return readFileSync(intentFilePath(cwd, id), "utf-8");
  } catch {
    return "";
  }
}

/**
 * Write markdown content for an intent.
 */
export function saveIntentContent(
  cwd: string,
  id: string,
  content: string,
): void {
  const dir = join(piDir(cwd), "intents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(intentFilePath(cwd, id), content, "utf-8");
}

/**
 * Return the currently active intent, or undefined if none is set.
 */
export function getActiveIntent(store: IntentStore): Intent | undefined {
  if (!store.activeIntentId) return undefined;
  return store.intents.find((i) => i.id === store.activeIntentId);
}

/**
 * Derive a short title from the first 7 words of the description.
 */
export function deriveTitle(description: string): string {
  const words = description.trim().split(/\s+/).slice(0, 7);
  const raw = words.join(" ");
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

/**
 * Create a new intent: adds metadata to the store and writes the initial .md file.
 * Does NOT call saveStore() — caller must do that.
 */
export function createIntent(
  store: IntentStore,
  cwd: string,
  description: string,
): Intent {
  const id = crypto.randomUUID();
  const intent: Intent = {
    id,
    title: deriveTitle(description),
    createdAt: Date.now(),
  };
  store.intents.push(intent);
  store.activeIntentId = id;
  saveIntentContent(cwd, id, description);
  return intent;
}

/**
 * Delete an intent by id — removes metadata and the .md file.
 * Falls back to the most recent remaining intent as active, or null.
 * Does NOT call saveStore() — caller must do that.
 */
export function deleteIntent(
  store: IntentStore,
  cwd: string,
  id: string,
): void {
  try {
    unlinkSync(intentFilePath(cwd, id));
  } catch {
    /* file may not exist */
  }
  store.intents = store.intents.filter((i) => i.id !== id);
  if (store.activeIntentId === id) {
    store.activeIntentId = store.intents.at(-1)?.id ?? null;
  }
}
