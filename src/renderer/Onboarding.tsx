import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { RelayStatus } from './client';
import type { HarnessMeta } from './connections';
import type { ProviderMeta } from './types';
import { Avatar } from './components/Avatar';
import { Button } from './components/Button';
import { Card } from './components/Card';
import { CheckboxField } from './components/CheckboxField';
import { TextField } from './components/TextField';

export interface OnboardingProps {
  /** Personal assistants, in display order. */
  assistants: ProviderMeta[];
  /** Local coding harnesses, in display order. */
  harnesses: HarnessMeta[];
  relay?: RelayStatus;
  saving: boolean;
  error: string;
  onToggleHarness: (enabled: boolean) => void;
  onChangeFolder: (folder: string) => Promise<boolean>;
  /** Open the agents screen to sign in to another assistant. */
  onConnectAnother: () => void;
  /** Leave the connections screen and open the chat. */
  onStart: () => void;
  /** Return to the chat when the user opens Connections from the shell. */
  onBack?: () => void;
}

/**
 * First-run connections screen. It replaces the old four-step dialog.
 * The user enables harnesses for each assistant, sets the shared folder, and
 * starts a chat. The screen has no chat sidebar.
 */
export default function Onboarding({
  assistants,
  harnesses,
  relay,
  saving,
  error,
  onToggleHarness,
  onChangeFolder,
  onConnectAnother,
  onStart,
  onBack,
}: OnboardingProps) {
  const [editingFolder, setEditingFolder] = useState(false);
  const [folderDraft, setFolderDraft] = useState('');

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      if (editingFolder) {
        if (saving) return;
        setEditingFolder(false);
        return;
      }
      if (onBack) onBack();
      else onStart();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [editingFolder, onBack, onStart, saving]);

  function startFolderEdit(): void {
    setFolderDraft(relay?.discoveryRoot ?? '');
    setEditingFolder(true);
  }

  async function saveFolder(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!folderDraft.trim() || saving) return;
    if (await onChangeFolder(folderDraft)) setEditingFolder(false);
  }

  const headingId = 'onboarding-title';

  return (
    <div className="onboarding-screen connections-screen" data-onboarding>
      <header className="connections-top">
        <div className="onboarding-brand">
          <span className="mark" aria-hidden="true">b</span>
          <strong>blibs</strong>
        </div>
        <div className="connections-top-actions">
          {onBack && (
            <Button variant="ghost" onClick={onBack}>
              Back to chats
            </Button>
          )}
          <Button variant="primary" size="lg" onClick={onStart}>
            Start chatting
          </Button>
        </div>
      </header>

      <main className="connections-center">
        <div className="connections-hero">
          <h1 id={headingId}>Connect your AI assistants to this Mac</h1>
          {relay && !relay.enabled && <p>The relay is off.</p>}
        </div>

        <Card className="connections-matrix">
          <div className="matrix-scroll">
            <table>
              <caption className="sr-only">
                Coding harnesses for each personal assistant
              </caption>
              <thead>
                <tr>
                  <th scope="col">Tools on this computer</th>
                  {assistants.map((assistant) => (
                    <th scope="col" key={assistant.id}>
                      <span className="matrix-head">
                        <Avatar name={assistant.product} />
                        {assistant.product}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {harnesses.map((harness) => (
                  <tr key={harness.id}>
                    <th scope="row">{harness.name}</th>
                    {assistants.map((assistant) => (
                      <td key={assistant.id}>
                        {relay?.provider === assistant.id && relay.harness.id === harness.id ? (
                          <CheckboxField
                            variant="switch"
                            checked={relay.harnesses[0]?.enabled ?? false}
                            disabled={!relay.enabled || saving}
                            label={`${harness.name} for ${assistant.product}`}
                            onChange={(event) => onToggleHarness(event.target.checked)}
                          />
                        ) : relay ? 'Unsupported' : 'Unavailable'}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <div className="connections-foot">
          <div className="connections-folder">
            {editingFolder ? (
              <form className="connections-folder-form" onSubmit={saveFolder}>
                <TextField
                  label="Shared folder path"
                  value={folderDraft}
                  onChange={(event) => setFolderDraft(event.target.value)}
                  placeholder="~/Projects"
                  autoComplete="off"
                  spellCheck={false}
                />
                <Button variant="primary" type="submit" disabled={saving || !folderDraft.trim()}>
                  Save
                </Button>
                <Button variant="ghost" disabled={saving} onClick={() => setEditingFolder(false)}>
                  Cancel
                </Button>
              </form>
            ) : (
              <>
                <span className="connections-folder-label">Shared folder</span>
                <code className="connections-folder-path">{relay?.discoveryRoot ?? 'Unavailable'}</code>
                <Button variant="ghost" size="sm" disabled={!relay || saving} onClick={startFolderEdit}>
                  Change folder
                </Button>
              </>
            )}
            {error && <p role="alert">{error}</p>}
          </div>
          <Button variant="secondary" onClick={onConnectAnother}>
            Connect another assistant
          </Button>
        </div>
      </main>
    </div>
  );
}
