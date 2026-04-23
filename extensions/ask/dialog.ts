import {
  decodeKittyPrintable,
  Key,
  matchesKey,
  visibleWidth,
} from "@mariozechner/pi-tui";
import type { Component } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { renderMarkdownLines } from "../shared/markdown.ts";

export type QuestionType = "single" | "multi" | "text";

export interface Question {
  id: string;
  text: string;
  type: QuestionType;
  options?: string[];
}

export interface ImageAttachment {
  bytes: Uint8Array;
  mimeType: string;
  fileName: string;
}

export type AnswerValue = string | string[];

export interface DialogResult {
  cancelled: false;
  answers: Record<string, AnswerValue>;
  images?: ImageAttachment[];
}

export interface DialogCancelled {
  cancelled: true;
  reason: string;
}

export type DialogOutcome = DialogResult | DialogCancelled;

interface DialogState {
  currentQuestion: number;
  answers: Record<string, AnswerValue>;
  cursor: number;
  inputMode: boolean;
  inputBuffer: string;
  inputCursorLine: number;
  inputCursorCol: number;
  addendumMode: boolean;
  addendumBuffer: string;
  // Bracketed paste mode support
  isInPaste: boolean;
  pasteBuffer: string;
  // Image attachments
  images: ImageAttachment[];
  imagePreviewMode: boolean;
  selectedImageIndex: number;
}

// Word wrap text to fit within width
function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [];
  const lines: string[] = [];
  const paragraphs = text.split("\n");

  for (const para of paragraphs) {
    if (para.trim() === "") {
      lines.push("");
      continue;
    }

    const words = para.split(/\s+/);
    let currentLine = "";

    for (const word of words) {
      const testLine = currentLine ? `${currentLine} ${word}` : word;
      const testWidth = visibleWidth(testLine);

      if (testWidth <= width) {
        currentLine = testLine;
      } else {
        if (currentLine) {
          lines.push(currentLine);
        }
        // Handle word longer than width
        if (visibleWidth(word) > width) {
          // Split long word
          let remaining = word;
          while (remaining.length > 0) {
            let chunk = "";
            for (const char of remaining) {
              if (visibleWidth(chunk + char) <= width) {
                chunk += char;
              } else {
                break;
              }
            }
            if (chunk) {
              lines.push(chunk);
              remaining = remaining.slice(chunk.length);
            } else {
              break;
            }
          }
          currentLine = "";
        } else {
          currentLine = word;
        }
      }
    }

    if (currentLine) {
      lines.push(currentLine);
    }
  }

  return lines.length > 0 ? lines : [""];
}

// Convert cursor position in buffer to line/col
function bufferPosToLineCol(
  buffer: string,
  pos: number,
): { line: number; col: number } {
  const lines = buffer.split("\n");
  let currentPos = 0;

  for (let line = 0; line < lines.length; line++) {
    const lineLength = lines[line].length;
    if (currentPos + lineLength >= pos) {
      return { line, col: pos - currentPos };
    }
    currentPos += lineLength + 1; // +1 for newline
  }

  return { line: lines.length - 1, col: lines[lines.length - 1]?.length ?? 0 };
}

// Convert line/col to buffer position
function lineColToBufferPos(buffer: string, line: number, col: number): number {
  const lines = buffer.split("\n");
  let pos = 0;

  for (let i = 0; i < line && i < lines.length; i++) {
    pos += lines[i].length + 1; // +1 for newline
  }

  pos += Math.min(col, lines[line]?.length ?? 0);
  return pos;
}

export function createAskDialog(
  questions: Question[],
  tui: { requestRender(): void },
  theme: Theme,
  done: (result: DialogOutcome) => void,
): Component {
  const firstQ = questions[0];
  const startsInInputMode =
    firstQ?.type === "text" && (!firstQ.options || firstQ.options.length === 0);

  const state: DialogState = {
    currentQuestion: 0,
    answers: Object.fromEntries(
      questions.map((q) => [q.id, q.type === "multi" ? [] : ""]),
    ),
    cursor: 0,
    inputMode: startsInInputMode,
    inputBuffer: "",
    inputCursorLine: 0,
    inputCursorCol: 0,
    addendumMode: false,
    addendumBuffer: "",
    isInPaste: false,
    pasteBuffer: "",
    images: [],
    imagePreviewMode: false,
    selectedImageIndex: 0,
  };

  let cachedLines: string[] | undefined;

  function refresh() {
    cachedLines = undefined;
    tui.requestRender();
  }

  function isTextOnly(q: Question): boolean {
    return q.type === "text" && (!q.options || q.options.length === 0);
  }

  function answeredCount(): number {
    return questions.filter((q) => {
      const a = state.answers[q.id];
      if (q.type === "multi") return (a as string[]).length > 0;
      return (a as string) !== "";
    }).length;
  }

  function renderTitleBar(width: number): string {
    const title = " Agent Questions";
    const counter = ` [${answeredCount()} of ${questions.length}]`;
    const imageIndicator =
      state.images.length > 0 ? ` 📷 ${state.images.length}` : "";
    const info = counter + imageIndicator + "  ↔ ";
    const gap = width - 2 - visibleWidth(title) - visibleWidth(info);
    const spacer = gap > 0 ? " ".repeat(gap) : "";
    return (
      theme.fg("borderAccent", "║") +
      theme.bold(theme.fg("text", title)) +
      spacer +
      theme.fg("muted", info) +
      theme.fg("borderAccent", "║")
    );
  }

  function renderDivider(width: number): string {
    return (
      theme.fg("borderAccent", "╠") +
      theme.fg("border", "═".repeat(width - 2)) +
      theme.fg("borderAccent", "╣")
    );
  }

  function renderStatusBar(width: number): string {
    const q = questions[state.currentQuestion];
    let hints: string;
    if (state.imagePreviewMode) {
      hints = " ↑↓ select image · del remove · esc back · enter confirm";
    } else if (state.addendumMode) {
      hints = " type addendum · esc cancel · enter confirm";
    } else if (state.inputMode) {
      hints =
        " type · shift+enter newline · enter submit · ctrl+v paste image · esc cancel";
    } else if (q.type === "multi") {
      hints =
        " ↑↓ navigate · space toggle/unselect · tab addendum · ← → cycle · enter submit";
    } else {
      hints =
        " ↑↓ select · space unselect · tab addendum · enter confirm · ← → cycle";
    }

    const innerWidth = width - 2;
    const wrapped = wrapText(hints, innerWidth);
    const line = wrapped[0] ?? "";
    const pad = " ".repeat(Math.max(0, innerWidth - visibleWidth(line)));

    return (
      theme.fg("borderAccent", "║") +
      theme.fg("dim", line + pad) +
      theme.fg("borderAccent", "║")
    );
  }

  function renderOptions(q: Question, innerWidth: number): string[] {
    const lines: string[] = [];
    const opts = q.options ?? [];

    for (let i = 0; i < opts.length; i++) {
      const isSelected = (() => {
        if (q.type === "multi") {
          return (state.answers[q.id] as string[]).some(
            (v) => v === opts[i] || v.startsWith(opts[i] + ": "),
          );
        }
        const a = state.answers[q.id] as string;
        return a === opts[i] || a.startsWith(opts[i] + ": ");
      })();
      const isCursor = state.cursor === i;
      const highlightRow = isCursor && !state.inputMode && !state.addendumMode;

      let indicator: string;
      if (q.type === "multi") {
        indicator = isSelected
          ? theme.fg("accent", "  ☑  ")
          : theme.fg("muted", "  ☐  ");
      } else {
        indicator = isSelected
          ? theme.fg("accent", "  ●  ")
          : theme.fg("muted", "  ○  ");
      }

      const maxLabelWidth = Math.max(
        1,
        innerWidth - 2 - visibleWidth(indicator),
      );
      const renderedLabel = renderMarkdownLines(opts[i], maxLabelWidth, theme, {
        color: (value: string) => theme.fg("text", value),
        bgColor: highlightRow
          ? (value: string) => theme.bg("selectedBg", value)
          : undefined,
        bold: highlightRow,
      });

      for (let lineIdx = 0; lineIdx < renderedLabel.length; lineIdx++) {
        const labelLine = renderedLabel[lineIdx] ?? "";
        const showIndicator =
          lineIdx === 0 ? indicator : " ".repeat(visibleWidth(indicator));
        const renderedIndicator = highlightRow
          ? theme.bg("selectedBg", showIndicator)
          : showIndicator;
        const leadingPad = highlightRow ? theme.bg("selectedBg", "  ") : "  ";
        lines.push(
          theme.fg("borderAccent", "║") +
            leadingPad +
            renderedIndicator +
            labelLine +
            theme.fg("borderAccent", "║"),
        );
      }

      // Addendum box beneath the highlighted option
      if (isCursor && state.addendumMode) {
        const boxWidth = innerWidth - 6;
        const wrappedAddendum = wrapText(state.addendumBuffer + "█", boxWidth);

        lines.push(
          theme.fg("borderAccent", "║") +
            "    " +
            theme.fg("border", "┌" + "─".repeat(boxWidth) + "┐") +
            theme.fg("borderAccent", "║"),
        );

        for (const addLine of wrappedAddendum) {
          const pad = " ".repeat(Math.max(0, boxWidth - visibleWidth(addLine)));
          lines.push(
            theme.fg("borderAccent", "║") +
              "    " +
              theme.fg("border", "│") +
              theme.fg("text", addLine + pad) +
              theme.fg("border", "│") +
              theme.fg("borderAccent", "║"),
          );
        }

        lines.push(
          theme.fg("borderAccent", "║") +
            "    " +
            theme.fg("border", "└" + "─".repeat(boxWidth) + "┘") +
            theme.fg("borderAccent", "║"),
        );
      }
    }

    return lines;
  }

  function renderTextBox(innerWidth: number): string[] {
    const lines: string[] = [];
    const boxWidth = innerWidth - 4;

    if (!state.inputMode) {
      const emptyLine = " ".repeat(boxWidth);
      lines.push(
        theme.fg("borderAccent", "║") +
          "  " +
          theme.fg("border", "┌" + "─".repeat(boxWidth) + "┐") +
          theme.fg("borderAccent", "║"),
      );
      lines.push(
        theme.fg("borderAccent", "║") +
          "  " +
          theme.fg("border", "│") +
          theme.fg("text", emptyLine) +
          theme.fg("border", "│") +
          theme.fg("borderAccent", "║"),
      );
      lines.push(
        theme.fg("borderAccent", "║") +
          "  " +
          theme.fg("border", "└" + "─".repeat(boxWidth) + "┘") +
          theme.fg("borderAccent", "║"),
      );
      return lines;
    }

    // Multi-line text input with cursor
    const textLines = state.inputBuffer.split("\n");
    const { line: cursorLine, col: cursorCol } = bufferPosToLineCol(
      state.inputBuffer,
      lineColToBufferPos(
        state.inputBuffer,
        state.inputCursorLine,
        state.inputCursorCol,
      ),
    );

    lines.push(
      theme.fg("borderAccent", "║") +
        "  " +
        theme.fg("border", "┌" + "─".repeat(boxWidth) + "┐") +
        theme.fg("borderAccent", "║"),
    );

    const maxLines = 10; // Maximum lines to show in text box
    const startLine = Math.max(0, cursorLine - Math.floor(maxLines / 2));
    const endLine = Math.min(textLines.length, startLine + maxLines);

    for (let i = startLine; i < endLine; i++) {
      const line = textLines[i] ?? "";
      const isCursorLine = i === cursorLine;

      let displayLine: string;
      if (isCursorLine) {
        const before = line.slice(0, cursorCol);
        const at = line[cursorCol] ?? " ";
        const after = line.slice(cursorCol + 1);
        displayLine = before + `\x1b[7m${at}\x1b[27m` + after; // Reverse video for cursor
      } else {
        displayLine = line;
      }

      // Wrap if needed
      const wrapped = wrapText(displayLine, boxWidth);
      for (const wline of wrapped) {
        const pad = " ".repeat(Math.max(0, boxWidth - visibleWidth(wline)));
        lines.push(
          theme.fg("borderAccent", "║") +
            "  " +
            theme.fg("border", "│") +
            theme.fg("text", wline + pad) +
            theme.fg("border", "│") +
            theme.fg("borderAccent", "║"),
        );
      }
    }

    lines.push(
      theme.fg("borderAccent", "║") +
        "  " +
        theme.fg("border", "└" + "─".repeat(boxWidth) + "┘") +
        theme.fg("borderAccent", "║"),
    );

    return lines;
  }

  function renderImages(innerWidth: number): string[] {
    if (state.images.length === 0) return [];

    const lines: string[] = [];
    lines.push(
      theme.fg("borderAccent", "║") +
        " ".repeat(innerWidth) +
        theme.fg("borderAccent", "║"),
    );

    lines.push(
      theme.fg("borderAccent", "║") +
        "  " +
        theme.bold(theme.fg("text", `📷 Images (${state.images.length})`)) +
        " ".repeat(
          Math.max(
            0,
            innerWidth - 2 - visibleWidth(`📷 Images (${state.images.length})`),
          ),
        ) +
        theme.fg("borderAccent", "║"),
    );

    for (let i = 0; i < state.images.length; i++) {
      const img = state.images[i];
      const isSelected =
        state.imagePreviewMode && state.selectedImageIndex === i;
      const sizeMB = (img.bytes.length / 1024 / 1024).toFixed(2);
      const info = `  ${i + 1}. ${img.fileName} (${sizeMB}MB)`;
      const displayInfo = isSelected
        ? theme.bg("selectedBg", theme.bold(info))
        : info;

      lines.push(
        theme.fg("borderAccent", "║") +
          displayInfo +
          " ".repeat(Math.max(0, innerWidth - visibleWidth(info))) +
          theme.fg("borderAccent", "║"),
      );
    }

    return lines;
  }

  function render(width: number): string[] {
    if (cachedLines) return cachedLines;

    const q = questions[state.currentQuestion];
    const innerWidth = width - 2;
    const lines: string[] = [];

    // Top border
    lines.push(theme.fg("borderAccent", "╔" + "═".repeat(innerWidth) + "╗"));
    // Title bar
    lines.push(renderTitleBar(width));
    // Divider
    lines.push(renderDivider(width));
    // Empty line
    lines.push(
      theme.fg("borderAccent", "║") +
        " ".repeat(innerWidth) +
        theme.fg("borderAccent", "║"),
    );

    // Question text with markdown rendering
    const questionLines = renderMarkdownLines(q.text, innerWidth - 2, theme, {
      color: (value: string) => theme.fg("text", value),
      bold: true,
    });
    for (const qline of questionLines) {
      lines.push(
        theme.fg("borderAccent", "║") +
          "  " +
          qline +
          theme.fg("borderAccent", "║"),
      );
    }

    // Empty line
    lines.push(
      theme.fg("borderAccent", "║") +
        " ".repeat(innerWidth) +
        theme.fg("borderAccent", "║"),
    );
    // Options
    lines.push(...renderOptions(q, innerWidth));
    // Empty line
    lines.push(
      theme.fg("borderAccent", "║") +
        " ".repeat(innerWidth) +
        theme.fg("borderAccent", "║"),
    );
    // Text box
    lines.push(...renderTextBox(innerWidth));
    // Images
    lines.push(...renderImages(innerWidth));
    // Empty line
    lines.push(
      theme.fg("borderAccent", "║") +
        " ".repeat(innerWidth) +
        theme.fg("borderAccent", "║"),
    );
    // Status bar divider
    lines.push(renderDivider(width));
    // Status bar
    lines.push(renderStatusBar(width));
    // Bottom border
    lines.push(theme.fg("borderAccent", "╚" + "═".repeat(innerWidth) + "╝"));

    cachedLines = lines;
    return lines;
  }

  function isAnswered(q: Question): boolean {
    const a = state.answers[q.id];
    if (q.type === "multi") return (a as string[]).length > 0;
    return (a as string) !== "";
  }

  function allAnswered(): boolean {
    return questions.every(isAnswered);
  }

  function advanceOrSubmit(): void {
    if (allAnswered()) {
      const result: DialogResult = {
        cancelled: false,
        answers: state.answers,
      };
      if (state.images.length > 0) {
        result.images = state.images;
      }
      done(result);
      return;
    }
    const nextUnanswered = questions.findIndex((qq, i) => {
      if (i <= state.currentQuestion) return false;
      return !isAnswered(qq);
    });
    if (nextUnanswered !== -1) {
      state.currentQuestion = nextUnanswered;
      state.cursor = 0;
      state.inputMode = isTextOnly(questions[nextUnanswered]);
      state.inputBuffer = state.inputMode
        ? (state.answers[questions[nextUnanswered].id] as string)
        : "";
      state.inputCursorLine = 0;
      state.inputCursorCol = 0;
    }
    refresh();
  }

  function handlePaste(pastedText: string, isAddendum: boolean): void {
    // For addendum, clean newlines; for input, keep them
    const cleanText = isAddendum
      ? pastedText
          .replace(/\r\n/g, "")
          .replace(/\r/g, "")
          .replace(/\n/g, "")
          .replace(/\t/g, "    ")
      : pastedText
          .replace(/\r\n/g, "\n")
          .replace(/\r/g, "\n")
          .replace(/\t/g, "    ");

    if (isAddendum) {
      state.addendumBuffer += cleanText;
    } else {
      const pos = lineColToBufferPos(
        state.inputBuffer,
        state.inputCursorLine,
        state.inputCursorCol,
      );
      state.inputBuffer =
        state.inputBuffer.slice(0, pos) +
        cleanText +
        state.inputBuffer.slice(pos);
      // Update cursor position
      const newPos = pos + cleanText.length;
      const newLineCol = bufferPosToLineCol(state.inputBuffer, newPos);
      state.inputCursorLine = newLineCol.line;
      state.inputCursorCol = newLineCol.col;
    }
    refresh();
  }

  async function handleImagePaste(): Promise<void> {
    try {
      const { readClipboardImage, extensionForImageMimeType } =
        await import("./clipboard-vendor.js");

      const image = await readClipboardImage();
      if (!image) return;

      const ext = extensionForImageMimeType(image.mimeType) ?? "bin";
      const fileName = `pasted-image-${Date.now()}.${ext}`;

      state.images.push({
        bytes: image.bytes,
        mimeType: image.mimeType,
        fileName,
      });

      refresh();
    } catch {
      // Silently fail if clipboard image not available
    }
  }

  function handleInput(data: string): void {
    const q = questions[state.currentQuestion];

    // Check for Ctrl+V image paste FIRST (before bracketed paste handling)
    if (state.inputMode && matchesKey(data, Key.ctrl("v"))) {
      handleImagePaste();
      return;
    }

    // Handle bracketed paste mode
    if (data.includes("\x1b[200~")) {
      state.isInPaste = true;
      state.pasteBuffer = "";
      data = data.replace("\x1b[200~", "");
    }

    if (state.isInPaste) {
      state.pasteBuffer += data;
      const endIndex = state.pasteBuffer.indexOf("\x1b[201~");
      if (endIndex !== -1) {
        const pasteContent = state.pasteBuffer.substring(0, endIndex);
        const isAddendum = state.addendumMode;
        handlePaste(pasteContent, isAddendum);
        state.isInPaste = false;
        const remaining = state.pasteBuffer.substring(endIndex + 6);
        state.pasteBuffer = "";
        if (remaining) {
          handleInput(remaining);
        }
      }
      return;
    }

    // --- Image Preview Mode ---
    if (state.imagePreviewMode) {
      if (matchesKey(data, Key.escape)) {
        state.imagePreviewMode = false;
        refresh();
        return;
      }
      if (matchesKey(data, Key.up)) {
        state.selectedImageIndex = Math.max(0, state.selectedImageIndex - 1);
        refresh();
        return;
      }
      if (matchesKey(data, Key.down)) {
        state.selectedImageIndex = Math.min(
          state.images.length - 1,
          state.selectedImageIndex + 1,
        );
        refresh();
        return;
      }
      if (matchesKey(data, Key.delete) || data === "d") {
        if (state.images.length > 0) {
          state.images.splice(state.selectedImageIndex, 1);
          state.selectedImageIndex = Math.min(
            state.selectedImageIndex,
            state.images.length - 1,
          );
          if (state.images.length === 0) {
            state.imagePreviewMode = false;
          }
          refresh();
        }
        return;
      }
      if (matchesKey(data, Key.enter)) {
        state.imagePreviewMode = false;
        refresh();
        return;
      }
      return;
    }

    // --- Text input mode ---
    if (state.inputMode) {
      // Ctrl+I for image preview
      if (matchesKey(data, Key.ctrl("i")) && state.images.length > 0) {
        state.imagePreviewMode = true;
        state.selectedImageIndex = 0;
        refresh();
        return;
      }

      if (matchesKey(data, Key.escape)) {
        state.inputMode = false;
        state.inputBuffer = "";
        state.inputCursorLine = 0;
        state.inputCursorCol = 0;
        refresh();
        return;
      }

      // Shift+Enter creates new line
      if (matchesKey(data, "shift+enter")) {
        const pos = lineColToBufferPos(
          state.inputBuffer,
          state.inputCursorLine,
          state.inputCursorCol,
        );
        state.inputBuffer =
          state.inputBuffer.slice(0, pos) + "\n" + state.inputBuffer.slice(pos);
        state.inputCursorLine++;
        state.inputCursorCol = 0;
        refresh();
        return;
      }

      // Regular Enter submits
      if (matchesKey(data, Key.enter)) {
        if (state.inputBuffer.trim() !== "") {
          state.answers[q.id] = state.inputBuffer.trim();
          state.inputMode = false;
          state.inputBuffer = "";
          state.inputCursorLine = 0;
          state.inputCursorCol = 0;
          advanceOrSubmit();
        }
        return;
      }

      if (matchesKey(data, Key.backspace)) {
        const pos = lineColToBufferPos(
          state.inputBuffer,
          state.inputCursorLine,
          state.inputCursorCol,
        );
        if (pos > 0) {
          state.inputBuffer =
            state.inputBuffer.slice(0, pos - 1) + state.inputBuffer.slice(pos);
          const newLineCol = bufferPosToLineCol(state.inputBuffer, pos - 1);
          state.inputCursorLine = newLineCol.line;
          state.inputCursorCol = newLineCol.col;
          refresh();
        }
        return;
      }

      // Arrow keys
      if (matchesKey(data, Key.up)) {
        if (state.inputCursorLine > 0) {
          state.inputCursorLine--;
          const lines = state.inputBuffer.split("\n");
          state.inputCursorCol = Math.min(
            state.inputCursorCol,
            lines[state.inputCursorLine]?.length ?? 0,
          );
          refresh();
        }
        return;
      }

      if (matchesKey(data, Key.down)) {
        const lines = state.inputBuffer.split("\n");
        if (state.inputCursorLine < lines.length - 1) {
          state.inputCursorLine++;
          state.inputCursorCol = Math.min(
            state.inputCursorCol,
            lines[state.inputCursorLine]?.length ?? 0,
          );
          refresh();
        }
        return;
      }

      if (matchesKey(data, Key.left)) {
        if (state.inputCursorCol > 0) {
          state.inputCursorCol--;
        } else if (state.inputCursorLine > 0) {
          state.inputCursorLine--;
          const lines = state.inputBuffer.split("\n");
          state.inputCursorCol = lines[state.inputCursorLine]?.length ?? 0;
        }
        refresh();
        return;
      }

      if (matchesKey(data, Key.right)) {
        const lines = state.inputBuffer.split("\n");
        const currentLineLength = lines[state.inputCursorLine]?.length ?? 0;
        if (state.inputCursorCol < currentLineLength) {
          state.inputCursorCol++;
        } else if (state.inputCursorLine < lines.length - 1) {
          state.inputCursorLine++;
          state.inputCursorCol = 0;
        }
        refresh();
        return;
      }

      // Printable character
      const inputChar =
        decodeKittyPrintable(data) ??
        (data.length === 1 && data.charCodeAt(0) >= 32 ? data : undefined);
      if (inputChar !== undefined) {
        const pos = lineColToBufferPos(
          state.inputBuffer,
          state.inputCursorLine,
          state.inputCursorCol,
        );
        state.inputBuffer =
          state.inputBuffer.slice(0, pos) +
          inputChar +
          state.inputBuffer.slice(pos);
        state.inputCursorCol++;
        refresh();
      }
      return;
    }

    // --- Addendum mode ---
    if (state.addendumMode) {
      if (matchesKey(data, Key.escape)) {
        state.addendumMode = false;
        state.addendumBuffer = "";
        refresh();
        return;
      }

      // Enter to submit addendum
      if (matchesKey(data, Key.enter)) {
        if (state.addendumBuffer.trim() !== "") {
          const q = questions[state.currentQuestion];
          const opts = q.options ?? [];
          const base = opts[state.cursor];
          const withAddendum = `${base}: ${state.addendumBuffer.trim()}`;
          if (q.type === "multi") {
            const current = state.answers[q.id] as string[];
            const idx = current.findIndex(
              (v) => v === base || v.startsWith(base + ": "),
            );
            if (idx !== -1) {
              const updated = [...current];
              updated[idx] = withAddendum;
              state.answers[q.id] = updated;
            } else {
              state.answers[q.id] = [...current, withAddendum];
            }
          } else {
            state.answers[q.id] = withAddendum;
          }
        }
        state.addendumMode = false;
        state.addendumBuffer = "";
        advanceOrSubmit();
        return;
      }

      if (matchesKey(data, Key.backspace)) {
        state.addendumBuffer = state.addendumBuffer.slice(0, -1);
        refresh();
        return;
      }

      const addendumChar =
        decodeKittyPrintable(data) ??
        (data.length === 1 && data.charCodeAt(0) >= 32 ? data : undefined);
      if (addendumChar !== undefined) {
        state.addendumBuffer += addendumChar;
        refresh();
      }
      return;
    }

    // --- Normal mode ---

    // Dismiss
    if (matchesKey(data, Key.escape)) {
      done({ cancelled: true, reason: "User dismissed the question dialog" });
      return;
    }

    // Ctrl+I for image preview
    if (matchesKey(data, Key.ctrl("i")) && state.images.length > 0) {
      state.imagePreviewMode = true;
      state.selectedImageIndex = 0;
      refresh();
      return;
    }

    // Cycle questions
    if (questions.length > 1) {
      if (matchesKey(data, Key.left)) {
        state.currentQuestion =
          (state.currentQuestion - 1 + questions.length) % questions.length;
        state.cursor = 0;
        state.inputMode = isTextOnly(questions[state.currentQuestion]);
        state.inputBuffer = state.inputMode
          ? (state.answers[questions[state.currentQuestion].id] as string)
          : "";
        state.inputCursorLine = 0;
        state.inputCursorCol = 0;
        refresh();
        return;
      }
      if (matchesKey(data, Key.right)) {
        state.currentQuestion = (state.currentQuestion + 1) % questions.length;
        state.cursor = 0;
        state.inputMode = isTextOnly(questions[state.currentQuestion]);
        state.inputBuffer = state.inputMode
          ? (state.answers[questions[state.currentQuestion].id] as string)
          : "";
        state.inputCursorLine = 0;
        state.inputCursorCol = 0;
        refresh();
        return;
      }
    }

    const opts = q.options ?? [];

    // Navigate options
    if (matchesKey(data, Key.up)) {
      if (opts.length > 0) {
        state.cursor = Math.max(0, state.cursor - 1);
        refresh();
      }
      return;
    }
    if (matchesKey(data, Key.down)) {
      if (opts.length > 0) {
        state.cursor = Math.min(opts.length - 1, state.cursor + 1);
        refresh();
      }
      return;
    }

    // Space — toggle selection (works for both select and unselect)
    if (
      matchesKey(data, Key.space) &&
      opts.length > 0 &&
      state.cursor < opts.length
    ) {
      if (q.type === "multi") {
        const current = state.answers[q.id] as string[];
        const opt = opts[state.cursor];
        const idx = current.findIndex(
          (v) => v === opt || v.startsWith(opt + ": "),
        );
        if (idx !== -1) {
          // Unselect
          state.answers[q.id] = current.filter((_, i) => i !== idx);
        } else {
          // Select
          state.answers[q.id] = [...current, opt];
        }
      } else if (q.type === "single") {
        const current = state.answers[q.id] as string;
        const opt = opts[state.cursor];
        // Toggle: if same option is selected, unselect it
        if (current === opt || current.startsWith(opt + ": ")) {
          state.answers[q.id] = "";
        } else {
          state.answers[q.id] = opt;
        }
      }
      refresh();
      return;
    }

    // Tab — open addendum box
    if (
      (matchesKey(data, Key.tab) || data === "\t") &&
      opts.length > 0 &&
      state.cursor < opts.length
    ) {
      state.addendumMode = true;
      state.addendumBuffer = "";
      refresh();
      return;
    }

    // Enter — select and advance, or activate text input
    if (matchesKey(data, Key.enter)) {
      if (
        q.type === "single" &&
        opts.length > 0 &&
        state.cursor < opts.length
      ) {
        state.answers[q.id] = opts[state.cursor];
        advanceOrSubmit();
        return;
      }
      if (q.type === "multi" && opts.length > 0) {
        if (isAnswered(q)) {
          advanceOrSubmit();
        }
        return;
      }
      if (q.type === "text" || opts.length === 0) {
        if (allAnswered()) {
          const result: DialogResult = {
            cancelled: false,
            answers: state.answers,
          };
          if (state.images.length > 0) {
            result.images = state.images;
          }
          done(result);
          return;
        }
        state.inputMode = true;
        state.inputBuffer =
          typeof state.answers[q.id] === "string"
            ? (state.answers[q.id] as string)
            : "";
        const lineCol = bufferPosToLineCol(
          state.inputBuffer,
          state.inputBuffer.length,
        );
        state.inputCursorLine = lineCol.line;
        state.inputCursorCol = lineCol.col;
        refresh();
        return;
      }
      return;
    }
  }

  return {
    render,
    handleInput,
    invalidate: () => {
      cachedLines = undefined;
    },
  };
}
