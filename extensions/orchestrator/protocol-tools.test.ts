import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  makeProposeDoneTool,
  makeReportReviewTool,
  makeAskOrchestratorTool,
  makeSpawnChildIntentTool,
  protocolToolsForRole,
} from "./protocol-tools.ts";
import { newFlight } from "./state.ts";

// Minimal ctx / signal stand-ins for the tool execute signature.
const noCtx: any = {};
const noSignal: any = { aborted: false, addEventListener: () => {} };
const noOp = () => {};

describe("propose_done tool", () => {
  test("records a proposal signal onto the flight", async () => {
    const flight = newFlight("intent-1");
    const tool = makeProposeDoneTool(flight, "implementer");
    const result = await tool.execute(
      "call-1",
      { summary: "All criteria satisfied.", artifacts: ["src/foo.ts"] },
      noSignal,
      noOp,
      noCtx,
    );
    assert.ok((result.content[0] as any).text.includes("recorded"));
    assert.ok(flight.pendingSignal);
    assert.equal(flight.pendingSignal!.kind, "proposal");
    if (flight.pendingSignal!.kind === "proposal") {
      assert.equal(flight.pendingSignal!.summary, "All criteria satisfied.");
      assert.equal(flight.pendingSignal!.agentRole, "implementer");
      assert.deepEqual(flight.pendingSignal!.artifacts, ["src/foo.ts"]);
    }
  });

  test("artifacts default to empty array when omitted", async () => {
    const flight = newFlight("intent-1");
    const tool = makeProposeDoneTool(flight, "implementer");
    await tool.execute("c", { summary: "ok" }, noSignal, noOp, noCtx);
    if (flight.pendingSignal?.kind === "proposal") {
      assert.deepEqual(flight.pendingSignal.artifacts, []);
    }
  });
});

describe("report_review tool", () => {
  test("records a pass verdict", async () => {
    const flight = newFlight("i1");
    const tool = makeReportReviewTool(flight);
    const result = await tool.execute(
      "c",
      { verdict: "pass", findings: [] },
      noSignal,
      noOp,
      noCtx,
    );
    assert.ok((result.content[0] as any).text.includes("recorded"));
    if (flight.pendingSignal?.kind === "review") {
      assert.equal(flight.pendingSignal.verdict, "pass");
      assert.deepEqual(flight.pendingSignal.findings, []);
    } else {
      assert.fail("expected a review signal");
    }
  });

  test("records a rework verdict with findings", async () => {
    const flight = newFlight("i1");
    const tool = makeReportReviewTool(flight);
    await tool.execute(
      "c",
      {
        verdict: "rework",
        findings: ["Test for X is missing", "Error case Y not handled"],
        nextActions: ["Add X test", "Handle Y"],
      },
      noSignal,
      noOp,
      noCtx,
    );
    if (flight.pendingSignal?.kind === "review") {
      assert.equal(flight.pendingSignal.verdict, "rework");
      assert.equal(flight.pendingSignal.findings.length, 2);
      assert.equal(flight.pendingSignal.nextActions.length, 2);
    } else {
      assert.fail("expected a review signal");
    }
  });

  test("rejects rework verdict with empty findings", async () => {
    const flight = newFlight("i1");
    const tool = makeReportReviewTool(flight);
    const result = await tool.execute(
      "c",
      { verdict: "rework", findings: [] },
      noSignal,
      noOp,
      noCtx,
    );
    assert.ok((result.content[0] as any).text.includes("Rejected"));
    assert.equal(flight.pendingSignal, null);
  });
});

describe("ask_orchestrator tool", () => {
  test("records a question signal", async () => {
    const flight = newFlight("i1");
    const tool = makeAskOrchestratorTool(flight, "implementer");
    await tool.execute(
      "c",
      { question: "Should I use approach A or B?", context: "Because X" },
      noSignal,
      noOp,
      noCtx,
    );
    if (flight.pendingSignal?.kind === "question") {
      assert.equal(
        flight.pendingSignal.question,
        "Should I use approach A or B?",
      );
      assert.equal(flight.pendingSignal.context, "Because X");
      assert.equal(flight.pendingSignal.agentRole, "implementer");
    } else {
      assert.fail("expected a question signal");
    }
  });

  test("context is null when omitted", async () => {
    const flight = newFlight("i1");
    const tool = makeAskOrchestratorTool(flight, "reviewer");
    await tool.execute("c", { question: "?" }, noSignal, noOp, noCtx);
    if (flight.pendingSignal?.kind === "question") {
      assert.equal(flight.pendingSignal.context, null);
    }
  });
});

describe("spawn_child_intent tool", () => {
  test("records a spawn-child signal", async () => {
    const flight = newFlight("parent-1");
    const tool = makeSpawnChildIntentTool(flight, "implementer");
    await tool.execute(
      "c",
      {
        description: "Write tests for the JWT module",
        reason:
          "Contract verifies via `npm test -- --grep jwt`, no such tests exist",
      },
      noSignal,
      noOp,
      noCtx,
    );
    if (flight.pendingSignal?.kind === "spawn-child") {
      assert.equal(flight.pendingSignal.parentIntentId, "parent-1");
      assert.equal(
        flight.pendingSignal.description,
        "Write tests for the JWT module",
      );
      assert.ok(flight.pendingSignal.reason.length > 0);
      assert.equal(flight.pendingSignal.agentRole, "implementer");
    } else {
      assert.fail("expected spawn-child signal");
    }
  });
});

describe("protocolToolsForRole", () => {
  test("implementer gets propose_done, ask_orchestrator, spawn_child_intent", () => {
    const tools = protocolToolsForRole(newFlight("i"), "implementer");
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "ask_orchestrator",
      "propose_done",
      "spawn_child_intent",
    ]);
  });

  test("reviewer gets report_review + ask_orchestrator + spawn_child_intent (no propose_done)", () => {
    const tools = protocolToolsForRole(newFlight("i"), "reviewer");
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "ask_orchestrator",
      "report_review",
      "spawn_child_intent",
    ]);
  });

  test("researcher and planner match implementer's tool set", () => {
    const researcher = protocolToolsForRole(newFlight("i"), "researcher");
    const planner = protocolToolsForRole(newFlight("i"), "planner");
    assert.deepEqual(researcher.map((t) => t.name).sort(), [
      "ask_orchestrator",
      "propose_done",
      "spawn_child_intent",
    ]);
    assert.deepEqual(planner.map((t) => t.name).sort(), [
      "ask_orchestrator",
      "propose_done",
      "spawn_child_intent",
    ]);
  });
});
