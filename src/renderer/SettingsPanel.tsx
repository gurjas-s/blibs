import { useEffect, useState } from 'react';
import { fetchIndexStatus, updateIndex } from './client';
import type { IndexStatus } from './client';
import type { SearchDefaults } from './search';
import type { ThemePreference } from './theme';
import { Button } from './components/Button';
import { Card } from './components/Card';
import { SelectField } from './components/SelectField';
import { TextField } from './components/TextField';

export interface SettingsPanelProps {
  theme: ThemePreference;
  onThemeChange: (theme: ThemePreference) => void;
  defaults: SearchDefaults;
  onDefaultsChange: (defaults: SearchDefaults) => void;
  /** True when the topbar has query text to send to the local answer path. */
  canAsk: boolean;
  onAsk: () => void;
  onBack: () => void;
}

/** Settings view for search defaults, the local index, answers, and theme. */
export default function SettingsPanel({
  theme,
  onThemeChange,
  defaults,
  onDefaultsChange,
  canAsk,
  onAsk,
  onBack,
}: SettingsPanelProps) {
  const [status, setStatus] = useState<IndexStatus | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const load = () => { void fetchIndexStatus().then(setStatus).catch(() => {}); };
    load();
    const timer = setInterval(load, 2500);
    return () => clearInterval(timer);
  }, []);

  async function index(action: 'resume' | 'cancel' | 'rebuild') {
    try { setStatus(await updateIndex(action)); } catch (err) { setError(String(err)); }
  }

  function change<K extends keyof SearchDefaults>(key: K, value: SearchDefaults[K]): void {
    onDefaultsChange({ ...defaults, [key]: value });
  }

  const notice = error || status?.error || status?.migrationWarning;
  return <div className="settings-screen">
    <div className="thread-head">
      <div><h1>Settings</h1></div>
      <Button variant="secondary" onClick={onBack}>Back</Button>
    </div>

    <div className="settings-body">
      <Card className="settings-card">
        <h2>Search defaults</h2>
        <div className="settings-fields">
          <TextField
            label="Thread URL or ID"
            value={defaults.threadId}
            onChange={(e) => change('threadId', e.target.value)}
            placeholder="Any thread"
          />
          <TextField
            label="From"
            type="date"
            value={defaults.from}
            onChange={(e) => change('from', e.target.value)}
          />
          <TextField
            label="To"
            type="date"
            value={defaults.to}
            onChange={(e) => change('to', e.target.value)}
          />
        </div>
      </Card>

      <Card className="settings-card">
        <h2>Index and answers</h2>
        <div className="settings-status" aria-live="polite">
          <span>{status ? `${status.indexed || 0}/${status.total} passages indexed${status.paused ? ' · paused' : status.running ? ' · indexing…' : ''}` : 'Connecting to history…'}</span>
          <span>{status?.embeddingConfigured ? 'Local semantic search' : 'Keyword search available'}</span>
          <span>{status?.generationConfigured ? 'Experimental local answers' : 'Configure a local model to ask'}</span>
        </div>
        <div className="settings-actions">
          <Button
            variant="secondary"
            size="sm"
            disabled={!status?.embeddingConfigured}
            onClick={() => void index(status?.paused ? 'resume' : 'cancel')}
          >
            {status?.paused ? 'Resume indexing' : 'Pause indexing'}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={!status?.embeddingConfigured}
            onClick={() => void index('rebuild')}
          >
            Rebuild vectors
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={!canAsk || !status?.generationConfigured}
            title={!canAsk
              ? 'Type a search query in the topbar first.'
              : !status?.generationConfigured
                ? 'Configure a local model to ask.'
                : undefined}
            onClick={onAsk}
          >
            Ask locally
          </Button>
        </div>
        {notice && <p role="status" className="history-notice">{notice}</p>}
      </Card>

      <Card className="settings-card">
        <h2>Theme</h2>
        <SelectField
          hideLabel
          label="Theme"
          value={theme}
          onChange={(e) => onThemeChange(e.target.value as ThemePreference)}
        >
          <option value="system">System</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </SelectField>
      </Card>
    </div>
  </div>;
}
