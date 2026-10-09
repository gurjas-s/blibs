import type { Agent, VendorSession } from './types';
import type { Messages } from './messages';

export interface OnboardingProgress {
  step: 'welcome' | 'connect' | 'sync' | 'complete';
  providers: string[];
}
export const ONBOARDING_KEY = 'blibs-onboarding-v1';

export function readOnboarding(value: unknown): OnboardingProgress {
  if (!value || typeof value !== 'object') return { step: 'welcome', providers: [] };
  const progress = value as Partial<OnboardingProgress>;
  if (!['welcome', 'connect', 'sync', 'complete'].includes(progress.step || '') || !Array.isArray(progress.providers)) {
    return { step: 'welcome', providers: [] };
  }
  return { step: progress.step!, providers: progress.providers.filter((provider) => ['muse', 'dots', 'grok'].includes(provider)) };
}

export function connectedProviders(sessions: VendorSession[]): string[] {
  return sessions.filter((session) => session.state === 'ready').map((session) => session.provider);
}

export function firstSyncedAgent(progress: OnboardingProgress, agents: Agent[], messages: Messages): Agent | undefined {
  return agents.find((agent) => progress.providers.includes(agent.provider) &&
    (messages[agent.id] || []).some((message) => message.source === 'desktop' && !message.via));
}

export function onboardingScreen(progress: OnboardingProgress, agents: Agent[], messages: Messages) {
  return progress.step === 'sync' && firstSyncedAgent(progress, agents, messages) ? 'done' : progress.step;
}
