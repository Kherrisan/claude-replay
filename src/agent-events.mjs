const SUPPORTED_FORMATS = new Set(["codex", "claude-code"]);
const GOAL_STATUSES = new Set(["active", "paused", "blocked", "limited", "complete"]);
const GOAL_CONTROL_METHOD = "_session/goal";

const mapGoalStatus = (status) => {
	if (typeof status !== "string") return null;
	if (GOAL_STATUSES.has(status)) return status;
	if (status === "completed") return "complete";
	return null;
};

const asRecord = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};

const TOOL_ALIASES = new Map([
  ["bash", "Bash"],
  ["execute", "Bash"],
  ["command", "Bash"],
  ["exec_command", "Bash"],
  ["read", "Read"],
  ["read_file", "Read"],
  ["write", "Write"],
  ["write_file", "Write"],
  ["edit", "Edit"],
  ["apply_patch", "Edit"],
  ["glob", "Glob"],
  ["grep", "Grep"],
  ["search", "Grep"],
  ["websearch", "WebSearch"],
  ["web_search", "WebSearch"],
  ["webfetch", "WebFetch"],
  ["web_fetch", "WebFetch"],
  ["fetch", "WebFetch"],
]);

const normalizeToolName = (update) => {
  const title = typeof update.title === "string" ? update.title.trim() : "";
  const kind = typeof update.kind === "string" ? update.kind.trim() : "";
  const rawName = typeof update.name === "string" ? update.name.trim() : "";
  const candidate = rawName || title.split(/[\s:(]/, 1)[0] || kind || "Tool";
  return TOOL_ALIASES.get(candidate.toLowerCase())
    || TOOL_ALIASES.get(kind.toLowerCase())
    || candidate;
};

const normalizeToolInput = (name, value) => {
  const input = { ...asRecord(value) };
  if (name === "Bash") {
    const command = input.command ?? input.cmd ?? input.input;
    if (typeof command === "string") {
      return {
        command: typeof input.workdir === "string" && input.workdir
          ? `cd ${input.workdir} && ${command}`
          : command,
      };
    }
  }
  if (["Read", "Write", "Edit"].includes(name) && !input.file_path) {
    const filePath = input.path ?? input.filePath;
    if (typeof filePath === "string") input.file_path = filePath;
    delete input.path;
    delete input.filePath;
  }
  return input;
};

const contentText = (content) => {
  if (typeof content === "string") return content;
  const record = asRecord(content);
  return typeof record.text === "string" ? record.text : "";
};

const isErrorStatus = (status) =>
  status === "failed" || status === "rejected" || status === "cancelled";

const normalizeGoal = (value) => {
  if (value === null) return { valid: true, goal: null };
  const goal = asRecord(value);
  if (
    !goal.objective ||
    typeof goal.objective !== "string" ||
    !GOAL_STATUSES.has(goal.status) ||
    goal.controlMethod !== GOAL_CONTROL_METHOD
  ) {
    return { valid: false, goal: null };
  }

  const snapshot = {
    objective: goal.objective.trim(),
    status: goal.status,
    controlMethod: GOAL_CONTROL_METHOD,
  };
  if (!snapshot.objective) return { valid: false, goal: null };
  for (const key of ["iterations", "createdAt", "updatedAt", "tokensUsed", "timeUsedSeconds"]) {
    if (goal[key] !== undefined) {
      if (typeof goal[key] !== "number" || !Number.isFinite(goal[key])) {
        return { valid: false, goal: null };
      }
      snapshot[key] = goal[key];
    }
  }
  if (goal.tokenBudget !== undefined) {
    if (goal.tokenBudget !== null && (typeof goal.tokenBudget !== "number" || !Number.isFinite(goal.tokenBudget))) {
      return { valid: false, goal: null };
    }
    snapshot.tokenBudget = goal.tokenBudget;
  }
  if (goal.lastReason !== undefined) {
    if (goal.lastReason !== null && typeof goal.lastReason !== "string") {
      return { valid: false, goal: null };
    }
    snapshot.lastReason = goal.lastReason;
  }
  return { valid: true, goal: snapshot };
};

export function createAgentEventNormalizer({ format }) {
  if (!SUPPORTED_FORMATS.has(format)) {
    throw new Error(`Unsupported agent event format: ${format}`);
  }

  const toolCalls = new Map();

  return {
    push(notification) {
      const update = asRecord(asRecord(notification).update);
      const type = update.sessionUpdate;

      if (type === "agent_thought_chunk") {
        const text = contentText(update.content);
        return text ? [{ kind: "thinking", text }] : [];
      }
      if (type === "agent_message_chunk") {
        const text = contentText(update.content);
        return text ? [{ kind: "text", text }] : [];
      }
      if (type === "plan") {
        return [{ kind: "plan", entries: Array.isArray(update.entries) ? update.entries : [] }];
      }
      if (type === "usage_update") {
        if (typeof update.used !== "number") return [];
        return [{
          kind: "usage",
          used: update.used,
          ...(typeof update.size === "number" ? { size: update.size } : {}),
        }];
      }
      if (type === "session_info_update") {
        const meta = asRecord(update._meta);
        const events = [];
        if (Object.prototype.hasOwnProperty.call(meta, "goal")) {
          const normalized = normalizeGoal(meta.goal);
          if (normalized.valid) events.push({ kind: "goal", goal: normalized.goal });
        }
        const turn = asRecord(meta.turn);
        if (turn.status === "completed") {
          events.push({ kind: "turn", status: "completed" });
        }
        const task = asRecord(meta.task);
        if (task.status === "completed") {
          events.push({ kind: "task", status: "completed" });
        }
        return events;
      }
      if (type === "goal_updated") {
        const status = mapGoalStatus(update.status);
        const objective = typeof update.objective === "string" ? update.objective.trim() : "";
        if (!status || !objective) return [];
        return [{
          kind: "goal",
          goal: {
            objective,
            status,
            controlMethod: GOAL_CONTROL_METHOD,
          },
        }];
      }
      if (type === "turn_completed") {
        return [{ kind: "turn", status: "completed" }];
      }
      if (type === "tool_call") {
        if (typeof update.toolCallId !== "string" || !update.toolCallId) return [];
        const name = normalizeToolName(update);
        const toolCall = {
          tool_use_id: update.toolCallId,
          name,
          input: normalizeToolInput(name, update.rawInput),
          status: typeof update.status === "string" ? update.status : "pending",
          is_error: isErrorStatus(update.status),
        };
        toolCalls.set(update.toolCallId, toolCall);
        return [{ kind: "tool", tool_call: { ...toolCall } }];
      }
      if (type === "tool_call_update") {
        if (typeof update.toolCallId !== "string") return [];
        const previous = toolCalls.get(update.toolCallId);
        if (!previous) return [];
        const status = typeof update.status === "string" ? update.status : previous.status;
        const toolCall = {
          ...previous,
          status,
          is_error: isErrorStatus(status),
        };
        toolCalls.set(update.toolCallId, toolCall);
        return [{ kind: "tool", tool_call: { ...toolCall } }];
      }
      return [];
    },

    reset() {
      toolCalls.clear();
    },
  };
}
