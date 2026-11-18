import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { ConnectionState, HarnessMeta } from './connections';
import { connectionFor } from './connections';
import type { HarnessId, ProviderMeta } from './types';
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
  state: ConnectionState;
  onToggleHarness: (assistantId: string, harnessId: HarnessId, enabled: boolean) => void;
  onChangeFolder: (folder: string) => void;
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
  state,
  onToggleHarness,
  onChangeFolder,
  onConnectAnother,
  onStart,
  onBack,
}: OnboardingProps) {
  const [editingFolder, setEditingFolder] = useState(false);
  const [folderDraft, setFolderDraft] = useState(state.folder);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      if (editingFolder) {
        setEditingFolder(false);
        return;
      }
      if (onBack) onBack();
      else onStart();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [editingFolder, onBack, onStart]);

  function startFolderEdit(): void {
    setFolderDraft(state.folder);
    setEditingFolder(true);
  }

  function saveFolder(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!folderDraft.trim()) return;
    onChangeFolder(folderDraft);
    setEditingFolder(false);
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
          <p>Turn on the coding tools each assistant can use.</p>
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
                    {assistants.map((assistant) => {
                      const connection = connectionFor(state, assistant.id);
                      return (
                        <td key={assistant.id}>
                          <CheckboxField
                            variant="switch"
                            checked={connection.harnesses[harness.id]}
                            label={`${harness.name} for ${assistant.product}`}
                            onChange={(event) =>
                              onToggleHarness(assistant.id, harness.id, event.target.checked)
                            }
                          />
                        </td>
                      );
                    })}
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
                <Button variant="primary" type="submit" disabled={!folderDraft.trim()}>
                  Save
                </Button>
                <Button variant="ghost" onClick={() => setEditingFolder(false)}>
                  Cancel
                </Button>
              </form>
            ) : (
              <>
                <span className="connections-folder-label">Shared folder</span>
                <code className="connections-folder-path">{state.folder}</code>
                <Button variant="ghost" size="sm" onClick={startFolderEdit}>
                  Change folder
                </Button>
              </>
            )}
          </div>
          <Button variant="secondary" onClick={onConnectAnother}>
            Connect another assistant
          </Button>
        </div>
      </main>
    </div>
  );
}
