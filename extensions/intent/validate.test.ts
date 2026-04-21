/**
 * Tests for intent validation.
 *
 * Run: node --experimental-strip-types validate.test.ts
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { validateIntentForLock } from "./validate.ts";

const FILLED_TEMPLATE = `# Intent

## Description
Fix the auth bug in the login flow

## Success Criteria
- Login works with valid credentials
- Invalid credentials show error message

## Verification
- Run the login test suite
- Manual test with test account
`;

describe("validateIntentForLock", () => {
  test("passes when all sections have content", () => {
    const result = validateIntentForLock(FILLED_TEMPLATE);
    assert.equal(result.valid, true);
    assert.deepEqual(result.missing, []);
  });

  test("fails when Success Criteria has only HTML comment", () => {
    const content = `# Intent

## Description
Fix the auth bug

## Success Criteria
<!-- What does "done" look like? List specific, verifiable outcomes. -->

## Verification
- Run tests
`;
    const result = validateIntentForLock(content);
    assert.equal(result.valid, false);
    assert.deepEqual(result.missing, ["Success Criteria"]);
  });

  test("fails when Verification section is missing entirely", () => {
    const content = `# Intent

## Description
Fix the auth bug

## Success Criteria
- Login works
`;
    const result = validateIntentForLock(content);
    assert.equal(result.valid, false);
    assert.deepEqual(result.missing, ["Verification"]);
  });

  test("fails when section heading exists but body is empty", () => {
    const content = `# Intent

## Description
Fix the auth bug

## Success Criteria

## Verification
- Run tests
`;
    const result = validateIntentForLock(content);
    assert.equal(result.valid, false);
    assert.deepEqual(result.missing, ["Success Criteria"]);
  });

  test("fails with all sections missing on empty content", () => {
    const result = validateIntentForLock("");
    assert.equal(result.valid, false);
    assert.deepEqual(result.missing, [
      "Description",
      "Success Criteria",
      "Verification",
    ]);
  });

  test("fails with all sections missing when no headings exist", () => {
    const result = validateIntentForLock(
      "just some random text\nwithout any headings",
    );
    assert.equal(result.valid, false);
    assert.deepEqual(result.missing, [
      "Description",
      "Success Criteria",
      "Verification",
    ]);
  });

  test("ignores extra sections — only checks required ones", () => {
    const content = `# Intent

## Description
Fix the auth bug

## Notes
Some extra notes here

## Success Criteria
- Login works

## Verification
- Run tests

## References
Some links
`;
    const result = validateIntentForLock(content);
    assert.equal(result.valid, true);
    assert.deepEqual(result.missing, []);
  });

  test("reports multiple missing sections", () => {
    const content = `# Intent

## Description
Fix the auth bug
`;
    const result = validateIntentForLock(content);
    assert.equal(result.valid, false);
    assert.deepEqual(result.missing, ["Success Criteria", "Verification"]);
  });

  test("content with only whitespace after heading fails", () => {
    const content = `# Intent

## Description
Fix the auth bug

## Success Criteria



## Verification
- Run tests
`;
    const result = validateIntentForLock(content);
    assert.equal(result.valid, false);
    assert.deepEqual(result.missing, ["Success Criteria"]);
  });
});
