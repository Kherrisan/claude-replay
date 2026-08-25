/**
 * Codex CLI format parser.
 *
 * Supports two format variants:
 * - Legacy: event_msg with task_started/task_complete boundaries + response_item payloads
 * - New: thread.started/item.completed with nested item objects
 *
 * Both use apply_patch for file edits and exec_command for shell commands.
 */

import { filterEmptyTurns } from "./shared.mjs";

export const name = "codex";

/**
 * Detect if JSONL lines contain Codex format entries.
 */
export function detect(firstObj) {
  if (firstObj.type === "session_meta") return true;
  if (firstObj.type === "thread.started") return true;
  if (firstObj.type === "item.completed" && firstObj.item) return true;
  return false;
}

/**
 * Extract the actual user request from Codex user messages.
 * Codex prepends IDE context; the real text follows "## My request for Codex:".
 */
function extractCodexUserText(text) {
  const marker = "## My request for Codex:";
  const idx = text.indexOf(marker);
  if (idx !== -1) return text.slice(idx + marker.length).trim();
  const marker2 = "## My request for Codex";
  const idx2 = text.indexOf(marker2);
  if (idx2 !== -1) {
    const after = text.slice(idx2 + marker2.length);
    return after.replace(/^:?\s*/, "").trim();
  }
  return text.trim();
}

/**
 * Parse a Codex apply_patch string into Edit/Write-compatible input.
 */
function parseCodexPatch(patchStr) {
  const lines = patchStr.split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  let filePath = "";
  let isNew = false;
  const oldLines = [];
  const newLines = [];

  for (const line of lines) {
    if (line.startsWith("*** Begin Patch") || line.startsWith("*** End Patch")) continue;
    if (line.startsWith("*** Add File:")) {
      filePath = line.replace("*** Add File:", "").trim();
      isNew = true;
      continue;
    }
    if (line.startsWith("*** Update File:")) {
      filePath = line.replace("*** Update File:", "").trim();
      isNew = false;
      continue;
    }
    if (line.startsWith("@@")) continue;
    if (line.startsWith("+")) {
      newLines.push(line.slice(1));
    } else if (line.startsWith("-")) {
      oldLines.push(line.slice(1));
    } else {
      oldLines.push(line);
      newLines.push(line);
    }
  }

  if (isNew) {
    return { file_path: filePath, content: newLines.join("\n"), isNew: true };
  }
  return { file_path: filePath, old_string: oldLines.join("\n"), new_string: newLines.join("\n"), isNew: false };
}

/** Create the stateful parser shared by batch parsing and AgentStream. */
export function createIncrementalParser() {
  let mode = "unknown";
  let turns = [];
  let currentTurn = null;
  let pendingCalls = new Map();

  const startTurn = (timestamp = "") => {
    currentTurn = {
      index: turns.length + 1,
      user_text: "",
      blocks: [],
      timestamp,
    };
    pendingCalls = new Map();
  };

  const ensureNewFormatTurn = () => {
    if (!currentTurn) startTurn("");
    return currentTurn;
  };

  const appendNewFormatItem = (evt) => {
    if (evt.type !== "item.completed" || !evt.item || typeof evt.item !== "object") return;
    const turn = ensureNewFormatTurn();
    const item = evt.item;
    const itemType = item.type ?? "";
    const timestamp = evt.timestamp ?? null;

    if (itemType === "command_execution") {
      const command = typeof item.command === "string" ? item.command : String(item.command ?? "");
      const cleanCommand = command
        .replace(/^\/bin\/bash\s+-lc\s+/, "")
        .replace(/^'(.*)'$/, "$1")
        .replace(/^"(.*)"$/, "$1");
      turn.blocks.push({
        kind: "tool_use",
        text: "",
        tool_call: {
          tool_use_id: item.id ?? "",
          name: "Bash",
          input: { command: cleanCommand },
          result: (item.aggregated_output ?? "").trim(),
          resultTimestamp: timestamp,
          is_error: item.exit_code != null && item.exit_code !== 0,
        },
        timestamp,
      });
      return;
    }
    if (itemType === "reasoning" || itemType === "agent_message") {
      const text = item.text ?? "";
      if (text.trim()) {
        turn.blocks.push({
          kind: itemType === "reasoning" ? "thinking" : "text",
          text,
          tool_call: null,
          timestamp,
        });
      }
      return;
    }
    if (itemType === "function_call") {
      const name = item.name ?? "unknown";
      let input = {};
      try { input = JSON.parse(item.arguments ?? "{}"); } catch { input = { raw: item.arguments }; }
      let mappedName = name;
      if (name === "exec_command") {
        if (input.cmd) {
          input = { command: input.workdir ? `cd ${input.workdir} && ${input.cmd}` : input.cmd };
        }
        mappedName = "Bash";
      } else if (name === "apply_patch") {
        const parsed = parseCodexPatch(item.arguments ?? input.raw ?? "");
        mappedName = parsed.isNew ? "Write" : "Edit";
        input = parsed;
      }
      turn.blocks.push({
        kind: "tool_use",
        text: "",
        tool_call: {
          tool_use_id: item.id ?? "",
          name: mappedName,
          input,
          result: (item.output ?? "").trim() || null,
          resultTimestamp: timestamp,
          is_error: item.status === "failed",
        },
        timestamp,
      });
      return;
    }
    if (itemType === "message" && item.role === "user") {
      const content = item.content ?? [];
      if (Array.isArray(content)) {
        turn.user_text = extractCodexUserText(
          content
            .filter((block) => block.type === "input_text")
            .map((block) => block.text ?? "")
            .join("\n"),
        );
      }
    }
  };

  const appendLegacyEvent = (evt) => {
    const type = evt.type;
    const payload = evt.payload ?? {};
    const timestamp = evt.timestamp ?? null;

    if (type === "event_msg" && payload.type === "task_started") {
      startTurn(timestamp ?? "");
      return;
    }
    if (type === "event_msg" && payload.type === "task_complete") {
      if (currentTurn) turns.push(currentTurn);
      currentTurn = null;
      pendingCalls = new Map();
      return;
    }
    if (!currentTurn) return;
    if (type === "event_msg" && payload.type === "user_message") {
      currentTurn.user_text = extractCodexUserText(payload.message ?? "");
      if (timestamp) currentTurn.timestamp = timestamp;
      return;
    }
    if (type !== "response_item") return;

    const payloadType = payload.type;
    const role = payload.role ?? "";
    if (payloadType === "message" && role === "user") {
      const content = payload.content ?? [];
      if (Array.isArray(content)) {
        const extracted = extractCodexUserText(
          content
            .filter((block) => block.type === "input_text")
            .map((block) => block.text ?? "")
            .join("\n"),
        );
        if (extracted && !currentTurn.user_text) currentTurn.user_text = extracted;
      }
      return;
    }
    if (payloadType === "message" && role === "developer") return;
    if (payloadType === "message" && role === "assistant") {
      const content = payload.content ?? [];
      const text = Array.isArray(content)
        ? content
            .filter((block) => block.type === "output_text")
            .map((block) => block.text ?? "")
            .join("\n")
            .trim()
        : "";
      if (text) {
        currentTurn.blocks.push({
          kind: payload.phase === "commentary" ? "thinking" : "text",
          text,
          tool_call: null,
          timestamp,
        });
      }
      return;
    }
    if (payloadType === "reasoning") return;
    if (payloadType === "function_call") {
      const callId = payload.call_id ?? "";
      const functionName = payload.name ?? "unknown";
      let input = {};
      try { input = JSON.parse(payload.arguments ?? "{}"); } catch { input = { raw: payload.arguments }; }
      if (functionName === "exec_command" && input.cmd) {
        input = { command: input.workdir ? `cd ${input.workdir} && ${input.cmd}` : input.cmd };
      }
      const toolCall = {
        tool_use_id: callId,
        name: functionName === "exec_command" ? "Bash" : functionName,
        input,
        result: null,
        resultTimestamp: null,
        is_error: false,
      };
      currentTurn.blocks.push({ kind: "tool_use", text: "", tool_call: toolCall, timestamp });
      pendingCalls.set(callId, toolCall);
      return;
    }
    if (payloadType === "function_call_output") {
      const callId = payload.call_id ?? "";
      const output = payload.output ?? "";
      const toolCall = pendingCalls.get(callId);
      if (toolCall) {
        toolCall.result = output
          .replace(/^Chunk ID:.*\n?/m, "")
          .replace(/^Wall time:.*\n?/m, "")
          .replace(/^Process exited with code \d+\n?/m, "")
          .replace(/^Original token count:.*\n?/m, "")
          .replace(/^Output:\n?/m, "")
          .trim();
        toolCall.resultTimestamp = timestamp;
        toolCall.is_error = output.includes("Process exited with code") && !output.includes("code 0");
        pendingCalls.delete(callId);
      }
      return;
    }
    if (payloadType === "custom_tool_call") {
      const callId = payload.call_id ?? "";
      const toolName = payload.name ?? "unknown";
      const parsed = toolName === "apply_patch" ? parseCodexPatch(payload.input ?? "") : null;
      const toolCall = {
        tool_use_id: callId,
        name: parsed ? (parsed.isNew ? "Write" : "Edit") : toolName,
        input: parsed ?? { raw: payload.input ?? "" },
        result: null,
        resultTimestamp: null,
        is_error: false,
      };
      currentTurn.blocks.push({ kind: "tool_use", text: "", tool_call: toolCall, timestamp });
      pendingCalls.set(callId, toolCall);
      return;
    }
    if (payloadType === "custom_tool_call_output") {
      const callId = payload.call_id ?? "";
      const toolCall = pendingCalls.get(callId);
      if (!toolCall) return;
      const output = typeof payload.output === "string"
        ? payload.output
        : payload.output?.output ?? "";
      toolCall.result = output.trim();
      toolCall.resultTimestamp = timestamp;
      toolCall.is_error = typeof payload.output === "object" && payload.output?.metadata?.exit_code !== 0;
      pendingCalls.delete(callId);
    }
  };

  return {
    push(event) {
      if (!event || typeof event !== "object") return;
      if (event.type === "thread.started" || event.type === "item.completed") {
        mode = "new";
      } else if (mode === "unknown" && (event.type === "event_msg" || event.type === "response_item")) {
        mode = "legacy";
      }
      if (mode === "new") appendNewFormatItem(event);
      else if (mode === "legacy") appendLegacyEvent(event);
    },

    snapshot() {
      const snapshotTurns = [...turns];
      if (currentTurn && (currentTurn.user_text || currentTurn.blocks.length)) {
        if (mode !== "new" || currentTurn.blocks.length) {
          snapshotTurns.push(
            mode === "new" && !currentTurn.user_text
              ? { ...currentTurn, user_text: "Task" }
              : currentTurn,
          );
        }
      }
      return filterEmptyTurns(JSON.parse(JSON.stringify(snapshotTurns)));
    },

    reset() {
      mode = "unknown";
      turns = [];
      currentTurn = null;
      pendingCalls = new Map();
    },
  };
}

/** Parse Codex CLI JSONL text into Turn[]. */
export function parse(text) {
  const parser = createIncrementalParser();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { parser.push(JSON.parse(trimmed)); } catch { /* ignore malformed lines */ }
  }
  return parser.snapshot();
}
