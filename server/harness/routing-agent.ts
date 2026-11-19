// The blibs routing agent.
//
// One provider (Muse) tags a harness mention at a high level. The routing
// agent does the low-level resolution: it reads the project registry through
// the blibs-router MCP tools, picks one project for the task, and answers
// with one strict line. The relay parses that line, enforces the allowlist,
// and forwards the provider message to the coding session of that project.

/** MCP server name the routing prompt tells the agent to call. */
export const ROUTING_MCP_NAME = 'blibs-router';

/** Length limit for one question the routing agent asks the provider thread. */
export const ROUTING_QUESTION_LIMIT = 300;

export interface RoutingDecision {
  kind: 'forward' | 'ask';
  /** Absolute project path for a forward decision. */
  projectPath?: string;
  /** One short question for an ask decision. */
  question?: string;
}

export function routingPrompt(task: string, threadId: string): string {
  return [
    'You are the blibs routing agent. One Muse task must reach one coding session.',
    `The ${ROUTING_MCP_NAME} MCP server holds the project registry. Call its tools to inspect it.`,
    '- list_projects lists every registered project and candidate.',
    '- get_thread_projects lists the projects this conversation already used.',
    '- resolve_project returns a keyword guess for the task.',
    '- resolve_session returns the coding session of one project, when it exists.',
    '',
    'Pick exactly one project for the task. Do not start the task.',
    'End your reply with exactly one line:',
    `- FORWARD <absolute project path> when you picked a project.`,
    '- ASK <one short question> when the task does not say which project.',
    '',
    `Conversation: ${threadId}`,
    'Task:',
    task.trim(),
  ].join('\n');
}

const FORWARD_LINE = /^forward\s+(\S.*)$/i;
const ASK_LINE = /^ask[:\s]+(\S.*)$/i;

/** Parse the agent's answer. The last decision line wins. Null means no decision. */
export function parseRoutingReply(text: string): RoutingDecision | null {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    const forward = FORWARD_LINE.exec(line);
    if (forward) return { kind: 'forward', projectPath: forward[1].trim() };
    const ask = ASK_LINE.exec(line);
    if (ask) return { kind: 'ask', question: ask[1].trim() };
  }
  return null;
}
