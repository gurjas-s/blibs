import { useEffect, useState } from 'react';
import { fetchIndexStatus, updateIndex } from './client';
import type { IndexStatus, RelayStatus } from './client';
import type { SearchDefaults } from './search';
import type { ThemePreference } from './theme';
import { Button } from './components/Button';
import { Card } from './components/Card';
import { CheckboxField } from './components/CheckboxField';
import { SelectField } from './components/SelectField';
import { TextField } from './components/TextField';

export interface SettingsPanelProps {
  theme: ThemePreference;
  onThemeChange: (theme: ThemePreference) => void;
  defaults: SearchDefaults;
  onDefaultsChange: (defaults: SearchDefaults) => void;
  /** True when auto-sync pulls new messages on a timer. */
  autoPull: boolean;
  onAutoPullChange: (enabled: boolean) => void;
  /** Auto-sync interval in seconds. */
  pullSecs: number;
  onPullSecsChange: (seconds: number) => void;
  /** True when the topbar has query text to send to the local answer path. */
  canAsk: boolean;
  onAsk: () => void;
  modelDefaults: RelayStatus['modelDefaults'];
  savingModels: boolean;
  modelError: string;
  onSaveModel: (harnessId: string, model: string | null) => Promise<boolean>;
  onBack: () => void;
}

/** Settings view for sync, search defaults, the local index, answers, and theme. */
export default function SettingsPanel({
  theme,
  onThemeChange,
  defaults,
  onDefaultsChange,
  autoPull,
  onAutoPullChange,
  pullSecs,
  onPullSecsChange,
  canAsk,
  onAsk,
  modelDefaults,
  savingModels,
  modelError,
  onSaveModel,
  onBack,
}: SettingsPanelProps) {
  const [status, setStatus] = useState<IndexStatus | null>(null);
  const [modelNotice, setModelNotice] = useState('');
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
      {modelDefaults.length > 0 && <Card className="settings-card">
        <h2>Harness models</h2>
        <p className="settings-model-help">Leave a model ID blank to use the harness default.</p>
        {modelDefaults.map(({ id, name, model }) => (
          <form className="settings-model-form" key={`${id}:${model ?? ''}`} onSubmit={(event) => {
            event.preventDefault();
            const value = String(new FormData(event.currentTarget).get('model') ?? '').trim();
            setModelNotice('');
            void onSaveModel(id, value || null).then((saved) => {
              if (saved) setModelNotice(`${name} default saved.`);
            });
          }}>
            <TextField label={`${name} default model`} name="model" defaultValue={model ?? ''}
              placeholder="Harness default" maxLength={200} disabled={savingModels} />
            <div className="settings-actions">
              <Button type="submit" variant="secondary" disabled={savingModels}>Save {name} default</Button>
            </div>
          </form>
        ))}
        <div role="status">{modelError || modelNotice}</div>
      </Card>}
      <Card className="settings-card">
        <h2>Sync</h2>
        <div className="settings-sync">
          <CheckboxField
            label="Auto-sync"
            checked={autoPull}
            onChange={(event) => onAutoPullChange(event.target.checked)}
          />
          <SelectField
            hideLabel
            label="Auto-sync interval"
            value={pullSecs}
            onChange={(event) => onPullSecsChange(Number(event.target.value))}
          >
            <option value={15}>15s</option>
            <option value={30}>30s</option>
            <option value={60}>1m</option>
            <option value={300}>5m</option>
          </SelectField>
        </div>
      </Card>

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
