import { test } from "node:test";
import assert from "node:assert/strict";
import { decideTransitionToImplementing } from "./transition-gate.ts";

test("returns 'cancel' when user declines", async () => {
  const result = await decideTransitionToImplementing({ confirm: async () => false });
  assert.equal(result, "cancel");
});

test("returns 'proceed' when user confirms", async () => {
  const result = await decideTransitionToImplementing({ confirm: async () => true });
  assert.equal(result, "proceed");
});
