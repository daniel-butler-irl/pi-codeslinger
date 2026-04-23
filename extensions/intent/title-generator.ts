/**
 * Title generator using isolated sub-agent.
 *
 * Spawns a separate `pi` process to generate a concise title from a description,
 * completely isolated from the main session's context.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

interface TitleGenerationResult {
  title: string | null;
  error: string | null;
}

/**
 * Generate a concise title from an intent description using a sub-agent.
 * Returns null if generation fails.
 */
export async function generateTitle(
  description: string,
  signal?: AbortSignal,
): Promise<TitleGenerationResult> {
  // Create a temporary prompt file
  const tmpDir = fs.mkdtempSync(
    path.join(require("os").tmpdir(), "pi-intent-"),
  );
  const promptPath = path.join(tmpDir, "prompt.txt");

  const prompt = `Generate a concise title (max 60 characters) for this intent description. Return ONLY the title, nothing else.

Intent description:
${description}

Title:`;

  try {
    fs.writeFileSync(promptPath, prompt, "utf-8");

    const args = [
      "--mode",
      "json",
      "--prompt",
      promptPath,
      "--no-session",
      "--no-tools",
      "--model",
      "fast",
    ];

    const result = await new Promise<TitleGenerationResult>((resolve) => {
      const proc = spawn("pi", args, {
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
      });

      let buffer = "";
      let stderr = "";
      let title: string | null = null;

      proc.stdout.on("data", (data) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            if (
              event.type === "message_end" &&
              event.message?.role === "assistant"
            ) {
              const text = event.message.content?.[0]?.text || "";
              if (text) {
                // Extract just the title, removing any extra formatting
                title = text
                  .trim()
                  .replace(/^["']|["']$/g, "")
                  .slice(0, 60);
              }
            }
          } catch {
            // Ignore parse errors
          }
        }
      });

      proc.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        if (buffer.trim()) {
          try {
            const event = JSON.parse(buffer);
            if (
              event.type === "message_end" &&
              event.message?.role === "assistant"
            ) {
              const text = event.message.content?.[0]?.text || "";
              if (text) {
                title = text
                  .trim()
                  .replace(/^["']|["']$/g, "")
                  .slice(0, 60);
              }
            }
          } catch {
            // Ignore
          }
        }

        if (title) {
          resolve({ title, error: null });
        } else if (code !== 0) {
          resolve({
            title: null,
            error: `Title generation failed (exit ${code}): ${stderr}`,
          });
        } else {
          resolve({ title: null, error: "No title generated" });
        }
      });

      proc.on("error", (err) => {
        resolve({ title: null, error: `Failed to spawn pi: ${err.message}` });
      });

      if (signal) {
        const killProc = () => {
          proc.kill("SIGTERM");
          setTimeout(() => {
            if (!proc.killed) proc.kill("SIGKILL");
          }, 2000);
        };
        if (signal.aborted) killProc();
        else signal.addEventListener("abort", killProc, { once: true });
      }
    });

    return result;
  } finally {
    // Clean up temp files
    try {
      if (fs.existsSync(promptPath)) fs.unlinkSync(promptPath);
      if (fs.existsSync(tmpDir)) fs.rmdirSync(tmpDir);
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Generate a title synchronously with a simple fallback strategy.
 * Takes the first meaningful sentence or line from the description.
 */
export function generateFallbackTitle(description: string): string {
  const firstLine = description
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith("#"));

  if (!firstLine) {
    return "New intent";
  }

  // Take first sentence or first 60 chars
  const sentences = firstLine.split(/[.!?]+/);
  const first = sentences[0].trim();

  if (first.length <= 60) {
    return first;
  }

  return first.slice(0, 57) + "...";
}
