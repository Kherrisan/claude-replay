// @ts-nocheck
import { createIncrementalParser as createClaudeCodeParser } from "./formats/claude-code.mjs";
import { createIncrementalParser as createCodexParser } from "./formats/codex.mjs";
import { createIncrementalParser as createGrokParser } from "./formats/grok.mjs";

const SUPPORTED_FORMATS = new Set(["codex", "claude-code", "grok"]);

const cloneTurns = (turns) => JSON.parse(JSON.stringify(turns));

const firstChangedTurn = (previous, next) => {
  const limit = Math.min(previous.length, next.length);
  for (let index = 0; index < limit; index++) {
    if (JSON.stringify(previous[index]) !== JSON.stringify(next[index])) {
      return index;
    }
  }
  return limit;
};

/**
 * Parse native Codex, Claude Code, or Grok Build JSONL as chunks arrive.
 *
 * The existing format parsers remain the source of truth for transcript
 * semantics. This wrapper adds stream framing and a stable changedFrom index
 * for incremental consumers such as React.
 */
export function createAgentStreamParser({ format }) {
  if (!SUPPORTED_FORMATS.has(format)) {
    throw new Error(`Unsupported agent stream format: ${format}`);
  }

  const state =
    format === "codex"
      ? createCodexParser()
      : format === "grok"
        ? createGrokParser()
        : createClaudeCodeParser();
  let pendingLine = "";
  let turns = [];
  let warningCount = 0;
  let promptEvents = [];

  const mergePromptEvents = (nativeTurns) => {
    const merged = cloneTurns(nativeTurns);
    for (const prompt of promptEvents) {
      const text = typeof prompt.text === "string" ? prompt.text : "";
      if (!text.trim()) continue;
      const requestedIndex = Number.isInteger(prompt.turnIndex) && prompt.turnIndex > 0
        ? prompt.turnIndex - 1
        : merged.length;
      const turnIndex = Math.min(requestedIndex, merged.length);
      if (!merged[turnIndex]) {
        merged.push({
          index: merged.length + 1,
          user_text: text,
          blocks: [],
          timestamp: prompt.timestamp || "",
        });
        continue;
      }
      merged[turnIndex] = {
        ...merged[turnIndex],
        user_text: text,
        timestamp: merged[turnIndex].timestamp || prompt.timestamp || "",
      };
    }
    return merged;
  };

  const result = (nextTurns, changedFrom = firstChangedTurn(turns, nextTurns)) => {
    turns = cloneTurns(nextTurns);
    return {
      turns: cloneTurns(turns),
      changedFrom,
      warningCount,
    };
  };

  const mergedSnapshot = () => mergePromptEvents(state.snapshot());

  const processLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      state.push(JSON.parse(trimmed));
    } catch {
      warningCount += 1;
    }
  };

  return {
    push(chunk) {
      if (typeof chunk !== "string" || chunk.length === 0) {
        return result(turns, turns.length);
      }

      pendingLine += chunk;
      const lines = pendingLine.split("\n");
      pendingLine = lines.pop() ?? "";
      if (lines.length === 0) {
        return result(turns, turns.length);
      }
      for (const line of lines) processLine(line);
      return result(mergedSnapshot());
    },

    pushPrompt(prompt) {
      if (!prompt || typeof prompt !== "object") {
        return result(mergedSnapshot(), turns.length);
      }
      const promptId = typeof prompt.promptId === "string" ? prompt.promptId : "";
      if (promptId && promptEvents.some((event) => event.promptId === promptId)) {
        return result(mergedSnapshot(), turns.length);
      }
      promptEvents.push({ ...prompt });
      promptEvents.sort((left, right) => {
        const leftIndex = Number.isInteger(left.turnIndex) ? left.turnIndex : Number.MAX_SAFE_INTEGER;
        const rightIndex = Number.isInteger(right.turnIndex) ? right.turnIndex : Number.MAX_SAFE_INTEGER;
        return leftIndex - rightIndex;
      });
      return result(mergedSnapshot());
    },

    reset() {
      pendingLine = "";
      warningCount = 0;
      promptEvents = [];
      state.reset();
      return result([], 0);
    },

    finish() {
      if (pendingLine) {
        processLine(pendingLine);
        pendingLine = "";
      }
      return result(mergedSnapshot());
    },
  };
}
