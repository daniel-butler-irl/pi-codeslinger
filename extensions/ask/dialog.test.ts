import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createAskDialog, type Question } from "./dialog.ts";

function mockTui() {
  return {
    requestRender: () => {},
  } as any;
}

function mockTheme() {
  return {
    fg: (_name: string, text: string) => text,
    bg: (_name: string, text: string) => text,
    bold: (text: string) => text,
    italic: (text: string) => text,
    underline: (text: string) => text,
    strikethrough: (text: string) => text,
  } as any;
}

function stripAnsi(value: string): string {
  return value.replace(/\x1B\[[0-9;]*m/g, "");
}

describe("createAskDialog", () => {
  test("renders markdown in question text", () => {
    const questions: Question[] = [
      {
        id: "q1",
        text: "# Clarify\n\n**Need** more detail\n- include an example",
        type: "text",
      },
    ];

    const dialog = createAskDialog(questions, mockTui(), mockTheme(), () => {});
    const rendered = stripAnsi(dialog.render(70).join("\n"));

    assert.match(rendered, /Clarify/);
    assert.match(rendered, /Need/);
    assert.match(rendered, /include an example/);
    assert.doesNotMatch(rendered, /# Clarify/);
    assert.doesNotMatch(rendered, /\*\*Need\*\*/);
  });

  test("renders markdown in option labels", () => {
    const questions: Question[] = [
      {
        id: "q1",
        text: "Pick one",
        type: "single",
        options: ["**Fast** path", "`Safe` path"],
      },
    ];

    const dialog = createAskDialog(questions, mockTui(), mockTheme(), () => {});
    const rendered = stripAnsi(dialog.render(70).join("\n"));

    assert.match(rendered, /Fast path/);
    assert.match(rendered, /Safe path/);
    assert.doesNotMatch(rendered, /\*\*Fast\*\*/);
    assert.doesNotMatch(rendered, /`Safe`/);
  });
});
