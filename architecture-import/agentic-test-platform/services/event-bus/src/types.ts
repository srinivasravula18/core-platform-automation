/** Agent-to-agent communication primitives. */

/** Capability manifest per agent — A2A "Agent Card" idea, used internally for discovery/routing. */
export interface AgentCard {
  name: string;
  description: string;
  /** what this agent can do, for discovery + the manager's routing decisions */
  skills: string[];
}

export type MessageKind = "request" | "reply" | "notify" | "publish";

export interface A2AMessage {
  id: string;
  kind: MessageKind;
  from: string;
  /** target agent (request/reply/notify) or topic (publish) */
  to: string;
  /** ties a reply to its request, and groups a whole exchange under the root request */
  correlationId: string;
  content: unknown;
  /** call depth, for loop detection */
  depth: number;
  seq: number;
}

/** Context handed to an agent handler so it can talk to other agents (A2A) from inside its turn. */
export interface AgentContext {
  self: string;
  correlationId: string;
  depth: number;
  /** call another agent and await its reply (agent-to-agent request/reply) */
  request: (to: string, content: unknown) => Promise<unknown>;
  /** fire-and-forget a message into another agent's inbox */
  notify: (to: string, content: unknown) => void;
  /** publish to a topic (pub/sub fan-out) */
  publish: (topic: string, content: unknown) => void;
  /** discover registered agents */
  cards: () => AgentCard[];
}

export type AgentHandler = (content: unknown, ctx: AgentContext) => Promise<unknown>;

/** An agent exposed as a callable tool (manager / agents-as-tools = internal tool calling). */
export interface AgentTool {
  name: string;
  description: string;
  call: (input: unknown, from?: string) => Promise<unknown>;
}
