import type { AssistantSetup } from '../connections';
import type { Agent } from '../types';
import { Avatar } from './Avatar';
import { LinkButton } from './LinkButton';
import { cx } from './cx';

export interface AgentListItemProps {
  agent: Agent;
  active: boolean;
  /** Derived connection state from the connection module. */
  setup: AssistantSetup;
  /** Short state text, such as a sync time or `Setup`. */
  stateLabel: string;
  /** Last activity summary, or an honest empty label. */
  detail: string;
  onSelect: (agentId: string) => void;
}

/** Sidebar assistant row with its connection state and last activity. */
export function AgentListItem({
  agent,
  active,
  setup,
  stateLabel,
  detail,
  onSelect,
}: AgentListItemProps) {
  const connected = setup === 'connected';
  return (
    <div className={cx('agent', active && 'active', !connected && 'agent--setup')}>
      <button
        type="button"
        className="agent-main"
        aria-current={active ? 'page' : undefined}
        aria-label={`${agent.name}, ${connected ? 'connected' : 'setup'}`}
        onClick={() => onSelect(agent.id)}
      >
        <Avatar name={agent.name} active={active} />
        <span className="ameta">
          <span className="atop">
            <span className="aname">{agent.name}</span>
            <span className={cx('astate', !connected && 'astate--setup')}>
              <span className="ui-status-pill__dot" aria-hidden="true" />
              {stateLabel}
            </span>
          </span>
          <span className="adetail">{detail}</span>
        </span>
      </button>
      <LinkButton
        href={agent.site}
        target="_blank"
        rel="noreferrer"
        title={`Open ${agent.name} in a new tab`}
        aria-label={`Open ${agent.name} in a new tab`}
        className="open-tab"
      >
        ↗
      </LinkButton>
    </div>
  );
}
