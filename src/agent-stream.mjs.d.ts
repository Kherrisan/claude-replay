export type AgentStreamFormat = "codex" | "claude-code";

export type AgentStreamToolCall = {
	tool_use_id: string;
	name: string;
	input: Record<string, unknown>;
	result: string | null;
	resultTimestamp: string | null;
	is_error: boolean;
};

export type AgentStreamBlock = {
	kind: string;
	text: string;
	tool_call: AgentStreamToolCall | null;
	timestamp: string | null;
};

export type AgentStreamTurn = {
	index: number;
	user_text: string;
	blocks: AgentStreamBlock[];
	timestamp: string;
};

export type AgentStreamPrompt = {
	promptId: string;
	taskId: string | null;
	sessionId: string | null;
	turnIndex: number;
	timestamp: string;
	text: string;
	offset?: number;
};

export type AgentStreamParser = {
	push(chunk: string): {
		turns: AgentStreamTurn[];
		changedFrom: number;
		warningCount: number;
	};
	pushPrompt(prompt: AgentStreamPrompt): {
		turns: AgentStreamTurn[];
		changedFrom: number;
		warningCount: number;
	};
	reset(): {
		turns: AgentStreamTurn[];
		changedFrom: number;
		warningCount: number;
	};
	finish(): {
		turns: AgentStreamTurn[];
		changedFrom: number;
		warningCount: number;
	};
};

export function createAgentStreamParser(input: {
	format: AgentStreamFormat;
}): AgentStreamParser;
