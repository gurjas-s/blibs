import type { Agent, ChatMessage } from './types';
import { cleanImportText, normalizeMessageText } from './text';

export interface ImportedMessage { provider: string; role: string; text: string; ts: number }
export type Messages = Record<string, ChatMessage[]>;

export function mergeImports(current: Messages, agents: Pick<Agent, 'id' | 'provider'>[], imports: ImportedMessage[]): Messages {
  let next = current;
  for (const item of imports) {
    const target = agents.find((agent) => agent.provider === item.provider)?.id;
    const text = cleanImportText(item.text || '');
    if (!target || !text) continue;
    const role = item.role === 'agent' ? 'agent' : 'user';
    const normalized = normalizeMessageText(text);
    if ((next[target] || []).some((message) => message.role === role && normalizeMessageText(message.text) === normalized)) continue;
    if (next === current) next = { ...current };
    next[target] = [...(next[target] || []), {
      id: crypto.randomUUID(), agentId: target, role, text, ts: Number(item.ts) || Date.now(), source: 'desktop',
    }];
  }
  return next;
}

export function groupMessages(messages: ChatMessage[]): ChatMessage[][] {
  const groups: ChatMessage[][] = [];
  for (const message of messages) {
    const group = groups.at(-1);
    const previous = group?.at(-1);
    const sameDay = previous && new Date(previous.ts).toDateString() === new Date(message.ts).toDateString();
    if (previous && sameDay && previous.role === message.role && message.ts - previous.ts < 5 * 60 * 1000) group!.push(message);
    else groups.push([message]);
  }
  return groups;
}
