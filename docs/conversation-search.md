# Search imported conversations

Select **Search all conversations** in the sidebar. Search retained messages across providers, or filter by provider, thread ID/URL, and observation date. Each result shows the source, role, date, and nearby messages. **View message** opens the stored message. **Open thread** opens the vendor thread in its persistent login session.

Keyword search works without models. Optional local embeddings add semantic search. **Ask locally** uses an optional local model to select quotations from the results. Answers are experimental: an exact quote can still be irrelevant or incomplete. Check the source messages.

Search does not queue replies. Model URLs must use `http://127.0.0.1` without credentials. Remote URLs and redirects are rejected. Imported conversation text is treated as data; the answer model has no tools or send access.

## Storage and migration

The backend requires Node.js 24. Electron 34's built-in Node runtime cannot run this SQLite backend. Put Node.js 24 on PATH, or set `BLIBS_NODE_PATH` to its executable.

History is stored in `<Electron userData>/history`. `BLIBS_DATA_DIR` overrides this directory. On startup, the backend copies retained `imports.json` and `outbox.json` from the old compiled backend directory if the destination files do not exist. `BLIBS_LEGACY_DIR` overrides the old directory. Original files and session credentials stay in place.

Migration preserves a byte-for-byte `imports.pre-sqlite.json` backup and imports valid rows in a transaction. It reports skipped rows. Invalid JSON or a failed import leaves migration pending for repair and retry. A newer database schema is rejected without changing it.

The old store discarded rows beyond its 2,000-row limit and combined some messages with equal text. Migration cannot recover that data. The new database retains all imports; the chat panel still loads the latest 500 messages.

Back up the full history directory while the app is stopped. Older app versions cannot read SQLite. Export new SQLite-only messages before returning to a JSON-only version.

## Source identity and search limits

- Vendor message IDs and roles identify a source within its provider and thread. Re-importing that source updates its text and clears its old vectors. Its first observation time stays unchanged.
- Without a vendor ID, collection uses rendered position and a content hash. Scrolling or streaming can create duplicate observations or partial messages. The result shows this fallback identity.
- Legacy JSON rows use provider, thread, role, timestamp, and text. Migration keeps repeated stored rows separate.
- Collection sees only the last 100 rendered nodes. It cannot fetch unseen vendor threads. Dates are first observation times, not vendor send times.
- Source links keep approved HTTPS vendor hosts and remove query strings and fragments. Local citations identify the retained message.

Search splits text into chunks of up to 1,000 characters with 150-character overlap. Keyword and semantic ranks combine by message ID. Semantic search scans stored vectors on the CPU; its cost grows with history size. Dense Unicode text can exceed the embedding model's token limit and leave a chunk pending.

**Pause indexing** stops work and saves the pause state across imports and app restarts. **Resume indexing** continues saved work. **Rebuild vectors** clears vectors and starts indexing again. Neither action removes history. Changing search inputs clears old results and resets paging.

## Optional local models

The supported setup uses llama.cpp b11598, BGE small English v1.5 Q8_0 embeddings (384 dimensions), and Qwen2.5 1.5B Instruct Q4_K_M for answers. Model files are external downloads; they are not included in the app. The Windows helper uses two CPU threads per model.

Download these pinned files into the paths below. Create the directories first. Extract the Windows runtime ZIP into `.local-models/runtime`.

| File | Download | SHA-256 |
| --- | --- | --- |
| `.local-models/runtime.zip` | [llama.cpp b11598 Windows CPU x64](https://github.com/ggml-org/llama.cpp/releases/download/b11598/llama-b11598-bin-win-cpu-x64.zip) (MIT) | `2f34ffb67e80c10a3f92e17eb26272572bc8e0f7304731a46c90920f2442c179` |
| `.local-models/embedding/bge-small-en-v1.5-q8_0.gguf` | [BGE revision f2068edd](https://huggingface.co/ggml-org/bge-small-en-v1.5-Q8_0-GGUF/resolve/f2068edd9b54f2a369549ccc71f70ed273a2a801/bge-small-en-v1.5-q8_0.gguf) (MIT) | `f046db1dc724cf4f6f0a0c5917e922823b73eb1d27b8f9a9c2797f7866974804` |
| `.local-models/generation/qwen2.5-1.5b-instruct-q4_k_m.gguf` | [Qwen revision 91cad511](https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/91cad51170dc346986eccefdc2dd33a9da36ead9/qwen2.5-1.5b-instruct-q4_k_m.gguf) (Apache 2.0) | `6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e` |

Use `Get-FileHash -Algorithm SHA256` to check the runtime ZIP before extraction. The helper checks both model files before starting them.

From PowerShell in the repository root:

```powershell
./scripts/local-models.ps1 Start
$env:BLIBS_EMBEDDING_URL = 'http://127.0.0.1:4322'
$env:BLIBS_GENERATION_URL = 'http://127.0.0.1:4323'
$env:BLIBS_EMBEDDING_MODEL = 'bge-small-en-v1.5-q8_0:f046db1dc724cf4f6f0a0c5917e922823b73eb1d27b8f9a9c2797f7866974804'
$env:BLIBS_GENERATION_MODEL = 'qwen2.5-1.5b-instruct-q4_k_m:6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e'
npm start
# After closing the app:
./scripts/local-models.ps1 Stop
```

For Linux or macOS, use the matching llama.cpp release binary and the same models. Start the embedding server with `--embedding --pooling cls --host 127.0.0.1 --port 4322 -t 2 -c 512 -np 1 --ubatch-size 512`. Start the answer server with `--host 127.0.0.1 --port 4323 -t 2 -c 4096 -np 1`. These platforms need separate validation.

Changing the embedding model label makes old vectors pending. Missing or failed embeddings fall back to keyword search. Missing generation produces no answer; generation errors are shown in the panel.

## Verification and troubleshooting

Run `npm test`, `npm run lint`, and `npm run verify:clean-build`. After building, run `npm run test:desktop` on a machine with a display. The desktop check uses temporary history, a separate profile, and separate ports. It tests search, filters, paging, delayed echoes, and exact source citations. A fixed local model response tests the citation flow; it does not measure answer quality. It writes no reports to the repository.

For manual testing, import a conversation from a signed-in vendor session. Search a distinctive phrase, change filters, inspect a source, and reopen the app to check retention. With local models enabled, check a paraphrase, pause and resume indexing, and inspect an answer's quotations.

| Problem | Check |
| --- | --- |
| Backend does not start | Use Node.js 24; check `BLIBS_NODE_PATH` and terminal output. |
| No search results | Only rendered messages can be imported. Check filters and the vendor session. |
| Index count does not increase | Check the pause state, model process, endpoint, and index error. |
| Local model ports are occupied | Stop the earlier model processes before starting the helper again. |
| Keyword search works but answers fail | Check the generation process and URL. The small model can also fail to find a useful quote. |
