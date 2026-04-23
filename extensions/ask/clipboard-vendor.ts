// Vendored from @mariozechner/pi-coding-agent/dist/utils/clipboard-image
// This allows us to use clipboard image functionality in our extension

import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export type ClipboardImage = {
  bytes: Uint8Array;
  mimeType: string;
};

export function extensionForImageMimeType(mimeType: string): string | null {
  switch (mimeType) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    case "image/bmp":
      return "bmp";
    default:
      return null;
  }
}

async function readClipboardImageMacOS(): Promise<ClipboardImage | null> {
  try {
    // Use osascript to get clipboard image
    const { stdout } = await execAsync(
      'osascript -e "set theImage to (the clipboard as «class PNGf»)" -e "return theImage"',
      { encoding: "buffer" as any, maxBuffer: 50 * 1024 * 1024 },
    );

    if (stdout && stdout.length > 0) {
      return {
        bytes: new Uint8Array(stdout),
        mimeType: "image/png",
      };
    }
  } catch (err) {
    // No image in clipboard or error
  }
  return null;
}

async function readClipboardImageLinux(): Promise<ClipboardImage | null> {
  try {
    // Try xclip first
    const { stdout } = await execAsync(
      "xclip -selection clipboard -t image/png -o",
      { encoding: "buffer" as any, maxBuffer: 50 * 1024 * 1024 },
    );

    if (stdout && stdout.length > 0) {
      return {
        bytes: new Uint8Array(stdout),
        mimeType: "image/png",
      };
    }
  } catch (err) {
    // Try wl-paste for Wayland
    try {
      const { stdout } = await execAsync("wl-paste -t image/png", {
        encoding: "buffer" as any,
        maxBuffer: 50 * 1024 * 1024,
      });

      if (stdout && stdout.length > 0) {
        return {
          bytes: new Uint8Array(stdout),
          mimeType: "image/png",
        };
      }
    } catch (err2) {
      // No clipboard tool available
    }
  }
  return null;
}

export async function readClipboardImage(options?: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}): Promise<ClipboardImage | null> {
  const platform = options?.platform ?? process.platform;

  try {
    if (platform === "darwin") {
      return await readClipboardImageMacOS();
    } else if (platform === "linux") {
      return await readClipboardImageLinux();
    }
  } catch {
    // Silently fail — caller gets null
  }

  return null;
}
