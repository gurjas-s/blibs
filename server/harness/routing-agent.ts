// The blibs router.
//
// A provider chat tags a harness mention at a high level. The router does the
// low-level resolution: it reads the project registry through the
// blibs-router MCP tools, picks one project for the message, and answers with
// one strict line. The relay parses that line, enforces the allowlist, and
// forwards the provider message unchanged to the coding session of that
// project. The project session owns the work and its reply. The router never
// answers the task.

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

export interface RoutingPromptOptions {
  /** Projects found by the home-folder search for a `$find-project` request. */
  discovered?: string[];
}

export function routingPrompt(task: string, threadId: string, options: RoutingPromptOptions = {}): string {
  const lines = [
    'You are the blibs routing agent. One provider message must reach one project session.',
    `The ${ROUTING_MCP_NAME} MCP server holds the project registry. Call its tools to inspect it.`,
    '- list_projects lists every registered project and candidate.',
    '- get_thread_projects lists the projects this conversation already used.',
    '- resolve_project returns a keyword guess for the message.',
    '- resolve_session returns the coding session of one project, when it exists.',
    '- search_projects searches the user home folder for projects outside the registry.',
    '',
  ];
  if (options.discovered?.length) {
    lines.push(
      'The relay searched the user home folder for this request. These projects are allowed for this message:',
      ...options.discovered.map((dir) => `- ${dir}`),
      '',
    );
  }
  lines.push(
    'Pick exactly one project for the message. Your only job is to choose the project.',
    'Do not answer the message, do not edit the message, and do not send a work response.',
    'The project session receives the message unchanged and replies to blibs.',
    'End your reply with exactly one line:',
    '- FORWARD <absolute project path> when you picked a project.',
    '- ASK <one short question> when the message does not say which project.',
    '',
    `Provider conversation: ${threadId}`,
    'Message:',
    task.trim(),
  );
  return lines.join('\n');
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
