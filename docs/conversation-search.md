# Search imported conversations

Use **Search all conversations** in the sidebar. Search retained history across providers or filter by provider, thread ID/URL, and observation date. Each result shows its provider, thread, role, date, source snippet, and nearby messages. **View message** opens the exact stored message. **Open thread** opens an allowed vendor URL in the existing persistent login partition.

Keyword search works without models. Local semantic search adds paraphrase matching when its model is configured and indexing is complete. Search never sends an outbox message. The expanded archive API accepts the local panel/backend origins and rejects external origins and hosts.

**Ask locally is experimental.** A small local generation model selects a verbatim sentence that answers the question, or two sentences for an explicit conflict question. The backend checks the quote and message ID and displays an inspectable citation. This is extractive answering, not free-form synthesis. A true quote can still be irrelevant, and a small model may miss evidence or choose an incomplete answer. Check the sources. The synthetic evaluation measures those failures separately from quote validity. No model-training claim is made.

Conversations remain local. Model endpoints must use `http://127.0.0.1`; redirects, credentials, and remote model URLs are rejected. No hosted model call, paid API, or consumer chat-history API is part of this feature. Source conversations are untrusted data. The generation path has no tools, no agent-send interface, and no executable output.

## Storage and migration

Electron launches the backend with Node.js 24. Set `BLIBS_NODE_PATH` to its executable if `node` is not on PATH. Electron 34's embedded Node runtime is too old for the backend's `node:sqlite` API. The existing main/preload CommonJS markers and ESM backend remain in place.

The desktop stores new history under `<Electron userData>/history`, outside generated build output. `BLIBS_DATA_DIR` overrides that directory. On the first launch, retained `imports.json` and `outbox.json` files from the previous compiled backend directory are copied when no destination file exists. `BLIBS_LEGACY_DIR` overrides the old directory. Existing session partitions and outbox delivery semantics remain in place.

The SQLite schema uses WAL, foreign keys, a unique `(provider, threadId, sourceId)` constraint, indexed metadata, and FTS5 chunks. Schema 1 is created transactionally; newer schemas are refused before writes. JSON migration copies `imports.pre-sqlite.json`, preserves original JSON bytes, and imports every valid retained row in a transaction. A migration marker makes restarts repeatable. Invalid entries produce a warning; corrupt JSON or a failed import keeps migration pending for repair and retry. The old 2,000-row cap and text deduplication already removed some data; migration cannot recover those messages.

Back up the full data directory while the app is stopped. For rollback to the older JSON-only app, retain `imports.json`/`imports.pre-sqlite.json` and the unchanged outbox JSON. New messages stored only in SQLite need export before rolling back; the old app cannot read SQLite. Do not delete or relabel a newer schema to make an old build accept it.

Source identity follows these rules:

- Vendor message/turn IDs plus role give stable identities. A changed message updates its chunks and invalidates its vector; its first observation timestamp remains.
- IDs are namespaced by provider and normalized thread URL/ID. Identical text in separate messages or threads remains separate.
- Older payloads use timestamp, provider, thread, role, and content. Repeated retained legacy rows receive occurrence numbers during migration.
- Without a stable vendor ID, the scraper uses rendered position plus content hash. Reusing a slot preserves older content. Loading more history or virtualizing the DOM can shift positions and create duplicate observations; streaming can leave partial fragments. The UI identifies this fallback. Text alone cannot resolve these identities reliably.

Dates from DOM collection are first-observed dates, not claimed vendor sent times. The scraper still sees only the last 100 rendered nodes per collection. The database retains all imported messages and paginates them; it cannot fetch unseen provider history. Thread links point to provider threads, while local citations identify the exact retained message. Sanitization removes URL query strings and fragments and rejects unexpected hosts, credentials, and active schemes.

## Local models: free CPU setup

The tested Windows x64 configuration uses Node 24.21, an AMD Ryzen 5 8640HS, and 13.76 GiB of RAM. Both model processes use two CPU threads. The observed working sets were about 50 MiB (52 MB) for embeddings and 1.90 GB for generation; those are process working sets, not a guarantee for every machine or the total OS file cache.

| Component | Source and license | Selected download |
| --- | --- | --- |
| llama.cpp b11598 | [runtime release](https://github.com/ggml-org/llama.cpp/releases/tag/b11598), MIT | Windows CPU x64 zip, 19,514,125 bytes |
| BGE small English v1.5 Q8_0 | [GGUF model](https://huggingface.co/ggml-org/bge-small-en-v1.5-Q8_0-GGUF), [base model](https://huggingface.co/BAAI/bge-small-en-v1.5), MIT | 36,685,152 bytes; 384 dimensions; 512-token context |
| Qwen2.5 1.5B Instruct Q4_K_M | [official GGUF model](https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF), [base model license](https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct/blob/main/LICENSE), Apache 2.0 | about 1.12 GB; demo context 4,096 tokens |

Use the installed `hf` CLI. Download only the files below into the ignored `.local-models` directory; no account or hosted inference is needed. The model repositories are pinned to revisions recorded in `evidence/models.json`. The startup helper verifies both GGUF checksums.

```powershell
$env:HF_HOME = Join-Path (Get-Location) '.local-models/hf-cache'
hf download Qwen/Qwen2.5-1.5B-Instruct-GGUF qwen2.5-1.5b-instruct-q4_k_m.gguf --revision 91cad51170dc346986eccefdc2dd33a9da36ead9 --local-dir .local-models/generation
hf download ggml-org/bge-small-en-v1.5-Q8_0-GGUF bge-small-en-v1.5-q8_0.gguf --revision f2068edd9b54f2a369549ccc71f70ed273a2a801 --local-dir .local-models/embedding
New-Item -ItemType Directory -Force .local-models/runtime | Out-Null
Invoke-WebRequest 'https://github.com/ggml-org/llama.cpp/releases/download/b11598/llama-b11598-bin-win-cpu-x64.zip' -OutFile .local-models/runtime.zip
Expand-Archive -LiteralPath .local-models/runtime.zip -DestinationPath .local-models/runtime
./scripts/local-models.ps1 Start
```

For Linux or macOS, use the corresponding llama.cpp binary from the pinned release and the same GGUF files. Run an embedding server with `--embedding --pooling cls --host 127.0.0.1 --port 4322 -t 2 -c 512 -np 1 --ubatch-size 512` and a generation server with `--host 127.0.0.1 --port 4323 -t 2 -c 4096 -np 1`. Those platforms were not exercised for this contribution. The models are optional external runtime files; they are not bundled into Electron or the repository.

Configure the app or evaluation in its launching shell:

```powershell
$env:BLIBS_EMBEDDING_URL = 'http://127.0.0.1:4322'
$env:BLIBS_GENERATION_URL = 'http://127.0.0.1:4323'
$env:BLIBS_EMBEDDING_MODEL = 'bge-small-en-v1.5-q8_0:f046db1dc724cf4f6f0a0c5917e922823b73eb1d27b8f9a9c2797f7866974804'
$env:BLIBS_GENERATION_MODEL = 'qwen2.5-1.5b-instruct-q4_k_m:6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e'
```

Model/version labels are persisted per vector. Changing the label makes old vectors pending. Resume indexing updates batches of eight chunks; cancel keeps completed work. Each chunk is at most 1,000 characters with 150-character overlap, within the selected English model's token budget for typical prose. Dense Unicode/punctuation can exceed 512 tokens; the runtime then reports an error, leaving those chunks pending. A future tokenizer-aware splitter is appropriate for broad multilingual support. Rebuild clears only vectors, leaving history and keyword search usable.

Vector search scans matching SQLite chunks in batches of 256, picks the best chunk per message, then combines lexical and semantic ranks using reciprocal-rank fusion (`1/(60+rank)`). It uses exact CPU cosine similarity rather than an ANN index. Paging covers retained matching messages; this small-corpus design has linear search cost and needs a larger-history benchmark before scaling claims. Search degrades to keyword results if the embedding runtime is absent. Asking reports a generation error or abstains when generation is unavailable.

## Reproduce the demonstration and evaluation

```powershell
npm ci
npm run build
./scripts/local-models.ps1 Start
./scripts/search-demo.ps1
```

The desktop demo uses port 4312 (backend 4321), a separate `.demo-profile`, and synthetic `.demo-data`. Vendor views and send timers are disabled in this mode. Select **Search all conversations**, ask `What database stores Atlas conversation history?`, then click its source citation. The stored source says Atlas uses SQLite. A provider filter changes the results; pausing/rebuilding vectors shows index status. Search remains useful after stopping the model processes.

## Personal testing before merge

Keep this work on `feature/9-conversation-search` until you have tested it. Start with the isolated synthetic demo above. For normal use, open a fresh shell so the demo-only environment does not carry over, then run `npm run build` and `npm start` from this checkout. Node.js 24 must be on PATH, or `BLIBS_NODE_PATH` must point to it. Normal startup uses the existing Electron profile and persistent vendor partitions; a different checkout can share the same OS user profile, so stop any other blibs instance first.

In normal startup, use **Agents → Log in** yourself if needed, open a conversation in the vendor window, and wait for its rendered messages to sync. Confirm the current chat still imports and existing delivery statuses still display. Search a distinctive phrase with **Search all conversations** while models are unconfigured; view the exact stored message, change provider/date filters, and open its original thread. Reopen the app and confirm history remains. Only rendered conversation history can be imported; this feature does not retrieve all vendor threads automatically.

To test semantic search, set the local model variables in that fresh shell, start the model helper, and restart the app. Wait for indexing, search a paraphrase, then pause/resume indexing. Optional **Ask locally** selects evidence experimentally; inspect its citation and compare it with the question. Test a question whose answer is absent and a conflicting decision. The small model can still select an irrelevant true sentence or miss an answer, as the held-out report shows. Stop the models afterward with `./scripts/local-models.ps1 Stop`. Search/asking should leave the send outbox unchanged. Sending a real message is a separate user action.

No merge, auto-merge, release, or change to master is part of these test instructions.

`./scripts/verify-search-desktop.ps1` launches the real Electron/React renderer, exercises search, a real local answer, and the exact source citation, asserts the outbox is empty, then closes the app. It writes `evidence/desktop-demo.json` and three ignored PNG screenshots. It uses the same synthetic profile and data. Close the interactive demo first to free ports 4312/4321.

```powershell
npm run evaluate:search -- --partition=tuning
npm run evaluate:search -- --partition=held-out
./scripts/local-models.ps1 Stop
```

The versioned corpus has 35 synthetic messages and 40 questions: 12 tuning and 28 held-out questions. Held-out paraphrases share facts/projects with tuning, so this is question generalization, not an unseen-project test. Labels identify supporting messages and required facts. The report compares keyword and hybrid recall@3/@5, quote relevance/support, answer completeness, expected abstention, source URL preservation, and measured latency. Fixture vendor URLs are fictitious; URL preservation does not claim that a real external thread resolved. The desktop test separately checks that a local citation opens the exact retained message.

Reports: `evidence/evaluation-tuning-initial.json`, `evidence/evaluation-tuning-second.json`, final `evidence/evaluation-tuning.json`, and `evidence/evaluation-held-out.json`. Settings are frozen before held-out evaluation. [Evaluation report](../evidence/evaluation-report.md) records actual scores and failures.

## Five-minute design walkthrough

1. Show provider search, source provenance, and the exact local citation. Explain rendered-history limits and experimental answer selection.
2. Trace preload collection through the existing main-process relay into transactional SQLite. Explain stable IDs, legacy migration, backups, and fallback ambiguity.
3. Explain FTS5, BGE vectors, versioned incremental chunks, cancellation/restart, filters, exact cosine scan, and reciprocal-rank fusion.
4. Explain the local Qwen evidence selector, strict quote/source validation, no tools, localhost-only endpoints, and why relevance can still fail.
5. Show the tuning/held-out comparison, conflict/abstention/injection cases, measured CPU/RAM/latency, and the next scaling and quality work justified by that evidence.
