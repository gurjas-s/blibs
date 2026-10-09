import { useEffect, useRef, useState } from 'react';
import type { Agent, VendorSession } from './types';
import type { Messages } from './messages';
import type { OnboardingProgress } from './onboarding-state';
import { connectedProviders, firstSyncedAgent, onboardingScreen } from './onboarding-state';
import SessionStatus from './SessionStatus';

export default function Onboarding({ progress, agents, sessions, messages, syncUnavailable, onChange, onSignIn, onSync, onSelect }: {
  progress: OnboardingProgress;
  agents: Agent[];
  sessions: VendorSession[];
  messages: Messages;
  syncUnavailable: boolean;
  onChange(progress: OnboardingProgress): void;
  onSignIn(provider: string): Promise<string | undefined>;
  onSync(): void;
  onSelect(id: string): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState('');
  const screen = onboardingScreen(progress, agents, messages);
  const connected = connectedProviders(sessions);
  const synced = firstSyncedAgent(progress, agents, messages);
  const stepIndex = ['welcome', 'connect', 'sync', 'done'].indexOf(screen);
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);
  useEffect(() => { heading.current?.focus(); }, [screen]);

  async function signIn(provider: string) {
    setOpening(provider);
    setError('');
    const problem = await onSignIn(provider);
    if (problem) setError(problem);
    setOpening(null);
  }
  function finish() { onChange({ ...progress, step: 'complete' }); }

  return <dialog ref={dialog} className="onboarding" aria-labelledby="setup-title" onCancel={(event) => { event.preventDefault(); finish(); }}>
    <ol className="setup-steps" aria-label="Setup progress">{['Welcome', 'Connect', 'Sync', 'Done'].map((label, index) =>
      <li key={label} aria-current={index === stepIndex ? 'step' : undefined} className={index <= stepIndex ? 'current' : ''}>{label}</li>)}</ol>
    <h2 id="setup-title" ref={heading} tabIndex={-1}>{screen === 'welcome' ? 'Your agents, together' : screen === 'connect' ? 'Connect your agents' : screen === 'sync' ? 'Sync your first chat' : 'Your first chat is ready'}</h2>
    {screen === 'welcome' && <p>Keep your Muse, Dots, and Grok chats in one place. Connect the agents you use, then read and send messages here.</p>}
    {screen === 'connect' && <>
      <p>Sign in to the agents you use. Saved sign-ins connect automatically. You can add the others later.</p>
      <div className="setup-agents">{agents.map((agent) => {
        const session = sessions.find((item) => item.provider === agent.provider);
        return <div key={agent.id} className="setup-agent">
          <div><strong>{agent.name}</strong><SessionStatus session={session} /><p>{session?.reason || 'Checking your saved sign-in.'}</p></div>
          {session?.state === 'ready' ? <span className="setup-check" aria-label={`${agent.name} connected`}>✓</span>
            : <button className="sign-in" disabled={opening !== null} onClick={() => signIn(agent.provider)}>{opening === agent.provider ? 'Opening…' : `Sign in to ${agent.name}`}</button>}
        </div>;
      })}</div>
      <p className="setup-hint">Complete sign-in and any verification in the window that opens. Your chats will start syncing here.</p>
    </>}
    {screen === 'sync' && <>
      <p>Open a conversation in one of your connected agents. Keep blibs open while your first chat syncs.</p>
      {syncUnavailable && <p className="setup-error" role="alert">Chats could not sync. Select Sync now to try again.</p>}
      <div className="setup-agents">{agents.filter((agent) => progress.providers.includes(agent.provider)).map((agent) => {
        const session = sessions.find((item) => item.provider === agent.provider);
        return <div key={agent.id} className="setup-agent">
          <div><strong>{agent.name}</strong><SessionStatus session={session} /><p>{session?.state === 'ready' ? 'Waiting for a chat to sync…' : session?.reason || 'Checking sign-in…'}</p></div>
          <button className="sign-in" disabled={opening !== null} onClick={() => signIn(agent.provider)}>{session?.state === 'ready' ? `Open ${agent.name}` : `Sign in to ${agent.name}`}</button>
        </div>;
      })}</div>
      <button className="sign-in" onClick={onSync}>Sync now</button>
    </>}
    {screen === 'done' && <p>Your {synced?.name} chat is synced. You can reply here, check delivery beside each message, and connect more agents whenever you need them.</p>}
    {error && <p className="setup-error" role="alert">{error}</p>}
    <div className="setup-actions">
      <button className="setup-later" onClick={finish}>{screen === 'done' ? 'Close setup' : 'Set up later'}</button>
      {screen === 'welcome' && <button className="primary" onClick={() => onChange({ ...progress, step: 'connect' })}>Get started</button>}
      {screen === 'connect' && <button className="primary" disabled={!connected.length} onClick={() => onChange({ step: 'sync', providers: connected })}>Continue with {connected.length || 'an'} agent{connected.length > 1 ? 's' : ''}</button>}
      {screen === 'sync' && <button className="setup-later" onClick={() => onChange({ ...progress, step: 'connect' })}>Back to agents</button>}
      {screen === 'done' && <button className="primary" onClick={() => { if (synced) onSelect(synced.id); finish(); }}>View {synced?.name} chat</button>}
    </div>
  </dialog>;
}
