import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { createAgentStreamParser } from "../src/agent-stream.mjs";
import { parseTranscriptFromText } from "../src/parser.mjs";

const CODEX_FIXTURE = readFileSync(new URL("./fixture-codex.jsonl", import.meta.url), "utf8");
const CLAUDE_FIXTURE = readFileSync(new URL("./fixture.jsonl", import.meta.url), "utf8");
const GROK_FIXTURE = readFileSync(new URL("./fixture-grok.jsonl", import.meta.url), "utf8");

const feedInChunks = (text, chunkSize, format = "codex") => {
  const parser = createAgentStreamParser({ format });
  let result = parser.reset();
  for (let offset = 0; offset < text.length; offset += chunkSize) {
    result = parser.push(text.slice(offset, offset + chunkSize));
  }
  return result;
};

describe("AgentStream parser", () => {
  it("matches batch parsing when Codex JSONL arrives in arbitrary chunks", () => {
    const result = feedInChunks(CODEX_FIXTURE, 17);
    assert.deepEqual(result.turns, parseTranscriptFromText(CODEX_FIXTURE));
    assert.equal(result.warningCount, 0);
  });

  it("matches batch parsing when Claude Code JSONL arrives in arbitrary chunks", () => {
    const result = feedInChunks(CLAUDE_FIXTURE, 13, "claude-code");
    assert.deepEqual(result.turns, parseTranscriptFromText(CLAUDE_FIXTURE));
    assert.equal(result.warningCount, 0);
  });

  it("matches batch parsing when Grok chat_history arrives in arbitrary chunks", () => {
    const result = feedInChunks(GROK_FIXTURE, 19, "grok");
    assert.deepEqual(result.turns, parseTranscriptFromText(GROK_FIXTURE));
    assert.equal(result.warningCount, 0);
  });

  it("does not parse an incomplete JSONL line until the next chunk", () => {
    const parser = createAgentStreamParser({ format: "claude-code" });
    const line = CLAUDE_FIXTURE.split("\n", 1)[0];
    const partial = parser.push(line.slice(0, -2));

    assert.deepEqual(partial.turns, []);
    assert.equal(partial.warningCount, 0);

    const complete = parser.push(`${line.slice(-2)}\n`);
    assert.equal(complete.warningCount, 0);
  });

  it("reports the first changed turn when an appended chunk updates the tail", () => {
    const parser = createAgentStreamParser({ format: "claude-code" });
    parser.push(CLAUDE_FIXTURE);
    const result = parser.push(
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "A final question" },
        timestamp: "2025-06-01T10:03:00Z",
      }) + "\n",
    );

    assert.equal(result.changedFrom, result.turns.length - 1);
  });

  it("resets the accumulated transcript", () => {
    const parser = createAgentStreamParser({ format: "codex" });
    parser.push(CODEX_FIXTURE);

    assert.deepEqual(parser.reset().turns, []);
    assert.deepEqual(parser.push(CODEX_FIXTURE.split("\n", 1)[0] + "\n").turns, []);
  });

  it("adds driver prompts as user turns and ignores duplicate prompt events", () => {
    const parser = createAgentStreamParser({ format: "codex" });

    parser.pushPrompt({
      promptId: "prompt-1",
      taskId: "task-1",
      sessionId: "thread-1",
      turnIndex: 1,
      timestamp: "2025-06-01T10:00:00Z",
      text: "Inspect the repository",
    });
    const first = parser.pushPrompt({
      promptId: "prompt-1",
      taskId: "task-1",
      sessionId: "thread-1",
      turnIndex: 1,
      timestamp: "2025-06-01T10:00:00Z",
      text: "Inspect the repository",
    });

    assert.equal(first.turns.length, 1);
    assert.equal(first.turns[0].user_text, "Inspect the repository");

    const next = parser.pushPrompt({
      promptId: "prompt-2",
      taskId: "task-2",
      sessionId: "thread-1",
      turnIndex: 2,
      timestamp: "2025-06-01T10:01:00Z",
      text: "Continue with the next surface",
    });
    assert.deepEqual(next.turns.map((turn) => turn.user_text), [
      "Inspect the repository",
      "Continue with the next surface",
    ]);
  });

  it("lets a native transcript replace a synthetic prompt turn without duplicating it", () => {
    const parser = createAgentStreamParser({ format: "claude-code" });
    parser.pushPrompt({
      promptId: "prompt-1",
      taskId: "task-1",
      sessionId: "thread-1",
      turnIndex: 1,
      timestamp: "2025-06-01T10:00:00Z",
      text: "The canonical prompt",
    });

    const result = parser.push(
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "The native prompt" },
        timestamp: "2025-06-01T10:00:01Z",
      }) + "\n",
    );

    assert.equal(result.turns.length, 1);
    assert.equal(result.turns[0].user_text, "The canonical prompt");
  });

  it("counts malformed complete lines without failing the stream", () => {
    const parser = createAgentStreamParser({ format: "codex" });
    const result = parser.push("not-json\n" + CODEX_FIXTURE);

    assert.equal(result.warningCount, 1);
    assert.deepEqual(result.turns, parseTranscriptFromText(CODEX_FIXTURE));
  });

  it("parses the final line without a newline only when finish is called", () => {
    const parser = createAgentStreamParser({ format: "claude-code" });
    const line = JSON.stringify({
      type: "user",
      message: { role: "user", content: "Final line" },
      timestamp: "2025-06-01T10:04:00Z",
    });

    assert.deepEqual(parser.push(line).turns, []);
    assert.equal(parser.finish().turns[0].user_text, "Final line");
  });
});
