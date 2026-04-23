import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createAskDialog } from "./dialog.js";
import type { Question, DialogOutcome, ImageAttachment } from "./dialog.js";

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", (_event, ctx) => {
    const base = ctx.getSystemPrompt();
    return {
      systemPrompt: `${base}

## Interactive Questions

Call \`ask_user\` when the user needs to decide, clarify, or provide information only they have. Ask early rather than assuming. Prefer \`single\`/\`multi\` with concrete options over free-form \`text\`. If a clarification has several parts, split each part into its own entry in the \`questions\` array — never pack a numbered list into one text prompt.`,
    };
  });

  pi.registerTool({
    name: "ask_user",
    label: "Ask User",
    description:
      "Present one or more questions to the user in an interactive dialog and wait for answers before continuing. Use this when you need clarification or a decision from the user.",
    promptGuidelines: [
      "Each question must have a unique id.",
      "Use 'single' or 'multi' with an options list whenever the choices are finite. Use 'text' only when the answer is truly open-ended, and never combine 'text' with options.",
      "When a user ask has several parts, emit one question per part. Bad: one 'text' question whose body is '1) ... 2) ... 3) ...'. Good: a 'single' question with options for the decision, then follow-ups for the rest.",
      "Always handle a cancelled result gracefully.",
    ],
    parameters: Type.Object({
      questions: Type.Array(
        Type.Object({
          id: Type.String({
            description: "Unique key for this question's answer",
          }),
          text: Type.String({ description: "The question to display" }),
          type: Type.Union(
            [
              Type.Literal("single"),
              Type.Literal("multi"),
              Type.Literal("text"),
            ],
            {
              description:
                "Question type: single choice, multi select, or free text",
            },
          ),
          options: Type.Optional(
            Type.Array(Type.String(), {
              description:
                "Choices for single/multi. Optional suggestions for text.",
            }),
          ),
        }),
        { minItems: 0 },
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { questions } = params;

      // Empty array — return immediately
      if (questions.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ cancelled: false, answers: {} }),
            },
          ],
          details: { cancelled: false, answers: {} } as DialogOutcome,
        };
      }

      // Validate: single/multi must have options
      for (const q of questions) {
        if (
          (q.type === "single" || q.type === "multi") &&
          (!q.options || q.options.length === 0)
        ) {
          return {
            content: [
              {
                type: "text",
                text: `Error: question "${q.id}" has type "${q.type}" but no options provided.`,
              },
            ],
            details: {
              cancelled: true,
              reason: "Invalid question definition",
            } as DialogOutcome,
          };
        }
      }

      const outcome = await ctx.ui.custom<DialogOutcome>(
        (tui, theme, _kb, done) => {
          return createAskDialog(questions as Question[], tui, theme, done);
        },
        { overlay: true },
      );

      // Handle images in the result
      const content: Array<
        | { type: "text"; text: string }
        | { type: "image"; data: string; mimeType: string }
      > = [{ type: "text", text: JSON.stringify(outcome) }];

      if (!outcome.cancelled && outcome.images && outcome.images.length > 0) {
        for (const img of outcome.images) {
          // Convert Uint8Array to base64
          const base64 = Buffer.from(img.bytes).toString("base64");
          content.push({
            type: "image",
            data: base64,
            mimeType: img.mimeType,
          });
        }
      }

      return {
        content,
        details: outcome,
      };
    },
  });
}
