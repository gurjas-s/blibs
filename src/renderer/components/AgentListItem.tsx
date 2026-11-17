import type { Agent } from '../types';
import { Avatar } from './Avatar';
import { LinkButton } from './LinkButton';
import { cx } from './cx';

export interface AgentListItemProps {
  agent: Agent;
  active: boolean;
  syncLabel: string;
  onSelect: (agentId: string) => void;
}

/** Sidebar agent row with a select button and a link to the vendor site. */
export function AgentListItem({ agent, active, syncLabel, onSelect }: AgentListItemProps) {
  return (
    <div className={cx('agent', active && 'active')}>
      <button
        type="button"
        className="agent-main"
        aria-current={active ? 'page' : undefined}
        onClick={() => onSelect(agent.id)}
      >
        <Avatar name={agent.name} active={active} />
        <span className="ameta">
          <span className="aname">{agent.name}</span>
          <span className="avendor">{agent.vendor}</span>
          <span className={cx('async', agent.lastSyncAt !== null && 'live')}>
            <span className="ui-status-pill__dot" aria-hidden="true" />
            {syncLabel}
          </span>
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
