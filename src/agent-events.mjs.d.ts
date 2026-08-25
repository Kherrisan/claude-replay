export type AgentEventFormat = "codex" | "claude-code";

export type NormalizedAgentEvent =
	| { kind: "thinking"; text: string }
	| { kind: "text"; text: string }
	| { kind: "plan"; entries: unknown[] }
	| {
			kind: "tool";
			tool_call: {
				tool_use_id: string;
				name: string;
				input: Record<string, unknown>;
				status: string;
				is_error: boolean;
			};
	  }
	| { kind: "usage"; used: number; size?: number }
	| {
			kind: "goal";
			goal: {
				objective: string;
				status: string;
				controlMethod: "_session/goal";
				[key: string]: unknown;
			} | null;
	  }
	| { kind: "turn"; status: "completed" };

export type AgentSessionNotification = {
	sessionId?: string;
	update?: Record<string, unknown>;
};

export function createAgentEventNormalizer(input: {
	format: AgentEventFormat;
}): {
	push(notification: AgentSessionNotification): NormalizedAgentEvent[];
	reset(): void;
};

