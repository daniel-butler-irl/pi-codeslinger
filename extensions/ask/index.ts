import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createAskDialog } from "./dialog.js";
import type { Question, DialogOutcome } from "./dialog.js";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "ask_user",
    label: "Ask User",
    description:
      "Present one or more questions to the user in an interactive dialog and wait for answers before continuing. Use this when you need clarification or a decision from the user.",
    promptGuidelines: [
      "Use ask_user when you need information from the user before proceeding.",
      "Each question must have a unique id.",
      "Use type 'single' when the user must pick exactly one option from a fixed list — always provide options.",
      "Use type 'multi' when the user may select multiple options from a fixed list — always provide options.",
      "Use type 'text' only for fully open-ended questions with no predefined options. Never combine type 'text' with an options list.",
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

      return {
        content: [{ type: "text", text: JSON.stringify(outcome) }],
        details: outcome,
      };
    },
  });
}
