import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAgentEventNormalizer } from "../src/agent-events.mjs";

describe("ACP agent event normalization", () => {
  it("normalizes Codex tool calls using replay tool conventions", () => {
    const normalizer = createAgentEventNormalizer({ format: "codex" });

    const started = normalizer.push({
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call-1",
        title: "Execute command",
        kind: "execute",
        rawInput: { cmd: "pnpm test", workdir: "/workspace" },
        status: "in_progress",
      },
    });
    const completed = normalizer.push({
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-1",
        status: "completed",
      },
    });

    assert.deepEqual(started, [{
      kind: "tool",
      tool_call: {
        tool_use_id: "call-1",
        name: "Bash",
        input: { command: "cd /workspace && pnpm test" },
        status: "in_progress",
        is_error: false,
      },
    }]);
    assert.deepEqual(completed, [{
      kind: "tool",
      tool_call: {
        tool_use_id: "call-1",
        name: "Bash",
        input: { command: "cd /workspace && pnpm test" },
        status: "completed",
        is_error: false,
      },
    }]);
  });

  it("normalizes Claude tool names and thought chunks", () => {
    const normalizer = createAgentEventNormalizer({ format: "claude-code" });

    assert.deepEqual(normalizer.push({
      sessionId: "session-2",
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "Inspecting the repository" },
      },
    }), [{ kind: "thinking", text: "Inspecting the repository" }]);

    assert.deepEqual(normalizer.push({
      sessionId: "session-2",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call-2",
        title: "Edit",
        rawInput: { file_path: "/workspace/src/app.ts" },
        status: "pending",
      },
    }), [{
      kind: "tool",
      tool_call: {
        tool_use_id: "call-2",
        name: "Edit",
        input: { file_path: "/workspace/src/app.ts" },
        status: "pending",
        is_error: false,
      },
    }]);
  });

  it("normalizes plan and usage updates and ignores unknown updates", () => {
    const normalizer = createAgentEventNormalizer({ format: "codex" });

    assert.deepEqual(normalizer.push({
      sessionId: "session-3",
      update: {
        sessionUpdate: "plan",
        entries: [{ content: "Read code", status: "in_progress" }],
      },
    }), [{
      kind: "plan",
      entries: [{ content: "Read code", status: "in_progress" }],
    }]);
    assert.deepEqual(normalizer.push({
      sessionId: "session-3",
      update: { sessionUpdate: "usage_update", used: 1250, size: 200000 },
    }), [{ kind: "usage", used: 1250, size: 200000 }]);
    assert.deepEqual(normalizer.push({
      sessionId: "session-3",
      update: { sessionUpdate: "available_commands_update", commands: [] },
    }), []);
  });

  it("normalizes Codex and Claude goal updates, including clear", () => {
    for (const format of ["codex", "claude-code"]) {
      const normalizer = createAgentEventNormalizer({ format });
      assert.deepEqual(normalizer.push({
        update: {
          sessionUpdate: "session_info_update",
          _meta: {
            goal: {
              objective: "Audit the selected attack surface",
              status: "active",
              iterations: 2,
              lastReason: "continue",
              tokenBudget: 1000,
              tokensUsed: 42,
              timeUsedSeconds: 3,
              controlMethod: "_session/goal",
            },
          },
        },
      }), [{
        kind: "goal",
        goal: {
          objective: "Audit the selected attack surface",
          status: "active",
          iterations: 2,
          lastReason: "continue",
          tokenBudget: 1000,
          tokensUsed: 42,
          timeUsedSeconds: 3,
          controlMethod: "_session/goal",
        },
      }]);
      assert.deepEqual(normalizer.push({
        update: {
          sessionUpdate: "session_info_update",
          _meta: { goal: null },
        },
      }), [{ kind: "goal", goal: null }]);
    }
  });

  it("normalizes turn completed updates after or beside a goal", () => {
    const normalizer = createAgentEventNormalizer({ format: "codex" });
    assert.deepEqual(normalizer.push({
      update: {
        sessionUpdate: "session_info_update",
        _meta: { turn: { status: "completed" } },
      },
    }), [{ kind: "turn", status: "completed" }]);
    assert.deepEqual(normalizer.push({
      update: {
        sessionUpdate: "session_info_update",
        _meta: {
          goal: {
            objective: "Audit the selected attack surface",
            status: "complete",
            controlMethod: "_session/goal",
          },
          turn: { status: "completed" },
        },
      },
    }), [
      {
        kind: "goal",
        goal: {
          objective: "Audit the selected attack surface",
          status: "complete",
          controlMethod: "_session/goal",
        },
      },
      { kind: "turn", status: "completed" },
    ]);
    assert.deepEqual(normalizer.push({
      update: {
        sessionUpdate: "session_info_update",
        _meta: { turn: { status: "started" } },
      },
    }), []);
  });

  it("rejects malformed goals and unrelated session info updates", () => {
    const normalizer = createAgentEventNormalizer({ format: "codex" });
    assert.deepEqual(normalizer.push({
      update: {
        sessionUpdate: "session_info_update",
        _meta: { title: "Only a title" },
      },
    }), []);
    assert.deepEqual(normalizer.push({
      update: {
        sessionUpdate: "session_info_update",
        _meta: {
          goal: {
            objective: "Invalid status",
            status: "done",
            controlMethod: "_session/goal",
          },
        },
      },
    }), []);
  });

  it("clears pending tool state on reset", () => {
    const normalizer = createAgentEventNormalizer({ format: "codex" });
    normalizer.push({
      sessionId: "session-4",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call-4",
        title: "Read file",
        kind: "read",
        rawInput: { path: "/workspace/README.md" },
      },
    });

    normalizer.reset();

    assert.deepEqual(normalizer.push({
      sessionId: "session-4",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-4",
        status: "completed",
      },
    }), []);
  });
});
