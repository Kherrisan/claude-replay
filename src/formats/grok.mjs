/**
 * Grok Build (xAI) transcript parser.
 *
 * Primary source: ~/.grok/sessions/<urlencoded-cwd>/<session-id>/chat_history.jsonl
 *
 * chat_history.jsonl is a JSONL log of conversation items:
 *   - system: session system prompt (skipped)
 *   - user: array of { type: "text", text } parts, often wrapped in
 *     <user_query>, <user_info>, <system-reminder>, etc.
 *   - reasoning: thinking summaries (encrypted_content is skipped)
 *   - assistant: string content plus optional tool_calls
 *   - tool_result: { tool_call_id, content }
 *
 * events.jsonl in the same directory is telemetry (turn_started, tool_started,
 * phase_changed, …) and does not contain conversation text. Detection accepts
 * it so the CLI can identify Grok sessions; parse() yields no turns unless the
 * file is chat_history (or parseTranscript() rewrites events.jsonl to the
 * sibling chat_history.jsonl).
 *
 * Tool names are mapped to Claude Code equivalents (read_file → Read,
 * run_terminal_command → Bash, search_replace → Edit, …).
 */

import { cleanSystemTags, filterEmptyTurns } from "./shared.mjs";

export const name = "grok";

const TOOL_MAP = {
  run_terminal_command: "Bash",
  bash: "Bash",
  execute: "Bash",
  command: "Bash",
  read_file: "Read",
  read: "Read",
  write_file: "Write",
  write: "Write",
  search_replace: "Edit",
  str_replace: "Edit",
  list_dir: "Glob",
  glob: "Glob",
  grep: "Grep",
  web_search: "WebSearch",
  web_fetch: "WebFetch",
  webfetch: "WebFetch",
  todo_write: "TodoWrite",
};

const TELEMETRY_TYPES = new Set([
  "turn_started",
  "turn_ended",
  "phase_changed",
  "loop_started",
  "first_token",
  "tool_started",
  "tool_completed",
  "permission_requested",
  "permission_resolved",
  "yolo_toggled",
  "interjected",
]);

/**
 * Detect Grok Build chat_history.jsonl or events.jsonl lines.
 * Must be more specific than Claude Code (`type: user|assistant`).
 */
export function detect(firstObj) {
  if (!firstObj || typeof firstObj !== "object") return false;
  const type = firstObj.type;

  if (type === "reasoning" && (Array.isArray(firstObj.summary) || typeof firstObj.encrypted_content === "string")) {
    return true;
  }
  if (type === "assistant" && typeof firstObj.model_id === "string" && /grok/i.test(firstObj.model_id)) {
    return true;
  }
  if (type === "system" && typeof firstObj.content === "string" && /\bGrok\b/.test(firstObj.content)) {
    return true;
  }
  // chat_history user lines have top-level `content` and no `message` wrapper.
  if (type === "user" && firstObj.message == null && firstObj.content != null) {
    return Array.isArray(firstObj.content) || typeof firstObj.prompt_index === "number";
  }
  if (type === "turn_started" && firstObj.session_id && firstObj.schema_version) {
    return true;
  }
  if (type === "phase_changed" && typeof firstObj.phase === "string") {
    return true;
  }
  if (type === "yolo_toggled" && typeof firstObj.enabled === "boolean") {
    return true;
  }
  return false;
}

function stripGrokContext(text) {
  return text
    .replace(/<user_info>[\s\S]*?<\/user_info>\s*/g, "")
    .replace(/<git_status>[\s\S]*?<\/git_status>\s*/g, "")
    .replace(/<rules>[\s\S]*?<\/rules>\s*/g, "")
    .replace(/<always_applied_workspace_rules>[\s\S]*?<\/always_applied_workspace_rules>\s*/g, "")
    .replace(/<user_rules>[\s\S]*?<\/user_rules>\s*/g, "")
    .replace(/<agent_transcripts>[\s\S]*?<\/agent_transcripts>\s*/g, "")
    .replace(/<open_and_recently_viewed_files>[\s\S]*?<\/open_and_recently_viewed_files>\s*/g, "");
}

function extractUserText(content) {
  let raw = "";
  if (typeof content === "string") {
    raw = content;
  } else if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      if (block && block.type === "text" && typeof block.text === "string") {
        parts.push(block.text);
      }
    }
    raw = parts.join("\n");
  }
  return cleanSystemTags(stripGrokContext(raw));
}

function reasoningText(entry) {
  const parts = [];
  if (Array.isArray(entry.summary)) {
    for (const item of entry.summary) {
      if (item && item.type === "summary_text" && typeof item.text === "string") {
        const text = item.text.trim();
        if (text) parts.push(text);
      }
    }
  }
  return parts.join("\n");
}

function parseArguments(raw) {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return { ...raw };
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch { /* keep empty */ }
  }
  return {};
}

function mapToolName(rawName) {
  const key = typeof rawName === "string" ? rawName : "";
  return TOOL_MAP[key] || TOOL_MAP[key.toLowerCase()] || (key || "Tool");
}

function normalizeInput(mappedName, input) {
  const next = { ...input };
  if ((mappedName === "Read" || mappedName === "Write" || mappedName === "Edit") && !next.file_path) {
    const filePath = next.target_file || next.path || next.filePath;
    if (typeof filePath === "string") next.file_path = filePath;
    delete next.target_file;
    delete next.path;
    delete next.filePath;
  }
  if (mappedName === "Glob" && !next.path && typeof next.target_directory === "string") {
    next.path = next.target_directory;
    delete next.target_directory;
  }
  if (mappedName === "Bash" && !next.command) {
    const command = next.cmd || next.input;
    if (typeof command === "string") next.command = command;
  }
  return next;
}

function isToolError(content) {
  if (typeof content !== "string") return false;
  const match = content.match(/^exit:\s*(-?\d+)/);
  if (match) return match[1] !== "0";
  return false;
}

function assistantText(content) {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      if (typeof block === "string") {
        parts.push(block);
      } else if (block && block.type === "text" && typeof block.text === "string") {
        parts.push(block.text);
      }
    }
    return parts.join("\n").trim();
  }
  return "";
}

function newTurn(userText = "") {
  return {
    index: 0,
    user_text: userText,
    blocks: [],
    timestamp: "",
  };
}

/**
 * Parse already-decoded Grok chat_history / events objects into Turn[].
 * @param {object[]} entries
 * @returns {import("./shared.mjs").Turn[]}
 */
function parseEntries(entries) {
  const turns = [];
  let current = null;
  let pending = new Map();

  const ensureTurn = () => {
    if (!current) {
      current = newTurn("");
      turns.push(current);
      pending = new Map();
    }
    return current;
  };

  for (const entry of entries) {
    const type = entry.type;
    if (!type || TELEMETRY_TYPES.has(type) || type === "system") continue;

    if (type === "user") {
      const userText = extractUserText(entry.content);
      if (!userText) continue;
      current = newTurn(userText);
      turns.push(current);
      pending = new Map();
      continue;
    }

    if (type === "reasoning") {
      const textContent = reasoningText(entry);
      if (!textContent) continue;
      ensureTurn().blocks.push({
        kind: "thinking",
        text: textContent,
        tool_call: null,
        timestamp: null,
      });
      continue;
    }

    if (type === "assistant") {
      const turn = ensureTurn();
      const textContent = assistantText(entry.content);
      if (textContent) {
        turn.blocks.push({
          kind: "text",
          text: textContent,
          tool_call: null,
          timestamp: null,
        });
      }
      const calls = Array.isArray(entry.tool_calls) ? entry.tool_calls : [];
      for (const call of calls) {
        const id = typeof call.id === "string" ? call.id : "";
        const mappedName = mapToolName(call.name);
        const toolCall = {
          tool_use_id: id,
          name: mappedName,
          input: normalizeInput(mappedName, parseArguments(call.arguments)),
          result: null,
          resultTimestamp: null,
          is_error: false,
        };
        if (id) pending.set(id, toolCall);
        turn.blocks.push({
          kind: "tool_use",
          text: "",
          tool_call: toolCall,
          timestamp: null,
        });
      }
      continue;
    }

    if (type === "tool_result") {
      const id = typeof entry.tool_call_id === "string" ? entry.tool_call_id : "";
      const toolCall = pending.get(id);
      if (!toolCall) continue;
      const content = typeof entry.content === "string"
        ? entry.content
        : entry.content == null ? null : JSON.stringify(entry.content);
      toolCall.result = content;
      toolCall.is_error = isToolError(content ?? "");
    }
  }

  return filterEmptyTurns(turns);
}

/**
 * Parse Grok Build chat_history.jsonl (or events.jsonl telemetry) into Turn[].
 * @param {string} text
 * @returns {import("./shared.mjs").Turn[]}
 */
export function parse(text) {
  const entries = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch { /* skip malformed */ }
  }
  return parseEntries(entries);
}

/** Stateful parser used by AgentStream (`push` one JSON object at a time). */
export function createIncrementalParser() {
  const entries = [];
  return {
    push(obj) {
      if (obj && typeof obj === "object") entries.push(obj);
    },
    snapshot() {
      return parseEntries(entries);
    },
    reset() {
      entries.length = 0;
    },
  };
}

/**
 * Best-effort title from the first user query in a Grok transcript.
 * @param {string} text
 * @returns {string|null}
 */
export function extractTitle(text) {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try { obj = JSON.parse(trimmed); } catch { continue; }
    if (obj.type !== "user") continue;
    const userText = extractUserText(obj.content);
    if (!userText) continue;
    const firstLine = userText.split("\n").find((part) => part.trim()) || userText;
    const title = firstLine.trim();
    return title.length > 80 ? `${title.slice(0, 77)}...` : title;
  }
  return null;
}
