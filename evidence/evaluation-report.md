# Local search evaluation

This contribution implements retained-history search and an optional experimental local evidence selector. The selector is a real Qwen generation path. It does not provide dependable free-form answers. No model training, hosted inference, paid API call, or real user conversation was used.

The versioned corpus `synthetic-decisions-v1` has 35 messages and 40 questions: 12 tuning questions and 28 held-out questions. The held-out set has 24 answerable questions, including paraphrases, a conflicting-date question, and an instruction-injection question, plus four unanswerable/ambiguous questions. Paraphrases share underlying facts and projects with tuning. This is a small synthetic development check, not a production benchmark or an unseen-fact test.

| Held-out metric | Keyword | Hybrid / local selector |
| --- | ---: | ---: |
| Recall@3 (24 answerable questions) | 79.17% | 87.50% |
| Recall@5 (24 answerable questions) | 79.17% | 100% |
| Complete answers | — | 17/24 (70.83%) |
| Relevant, supported selected claims | — | 18/20 (90%) |
| Expected abstentions | — | 4/4 |
| False abstentions on answerable questions | — | 5/24 |
| Median retrieval latency | 1.03 ms | 35.41 ms |
| 95th percentile retrieval latency | — | 48.21 ms |
| Median answer latency | — | 5.31 s |
| 95th percentile answer latency | — | 6.77 s |

Recall is the per-question fraction of labeled supporting messages among the first k results, averaged across answerable questions. Multiple chunks count as one message. Citation support requires the selected claim's source to be a labeled supporting message and its quote to be exact. The single-fact source sentences make those labels useful for relevance, but this check is limited by the simple corpus. Completeness separately requires all labeled facts and sources. Two true but irrelevant quotations failed citation support; syntactic citation validity alone would have missed them.

The conflict question returned both October 20 and November 3 for Ember, without resolving the dispute. The injection question selected the agent's SQLite decision and did not follow the pasted Redis/upload instruction. All four missing-context/unanswerable cases abstained. The selector missed five answerable questions and chose irrelevant evidence for two other questions. Those failures remain in the report. Settings were frozen after tuning; held-out failures were not used to revise them.

Tuning history is preserved to show the effect and limits of prompt changes:

| Tuning run (12 questions) | Citation support | Complete answers | Expected abstentions |
| --- | ---: | ---: | ---: |
| Initial: up to four claims, duplicated quote/text output | 30% | 9/10 | 1/2 |
| Second: shorter IDs and up to two quotes | 75% | 9/10 | 1/2 |
| Final: one quote normally, two for explicit conflict, conservative ambiguity check | 100% | 9/10 | 2/2 |

The final tuning score is not held-out quality evidence. Raw outputs, selected source labels, required-fact outcomes, and timings are in [held-out JSON](evaluation-held-out.json) and the three tuning JSON files. Historical reports called URL preservation `correctSourceLinks`; this name did not mean fixture URLs were opened on vendor sites. The final metric is `sourceUrlPreservation` (100%). Fixture vendor URLs are fictitious. The real desktop test separately verifies the local citation opens the exact retained source.

Runtime: Windows x64, Node 24.21.0, Ryzen 5 8640HS, 13.76 GiB total RAM, llama.cpp b11598, two CPU threads per model. BGE small English v1.5 Q8_0 supplies 384-dimensional embeddings; Qwen2.5 1.5B Instruct Q4_K_M selects evidence at temperature 0 and seed 7. The generation token bound is 240, context 4,096 tokens. Models were already loaded; prompt caching is enabled by the runtime, so these timings are warm local measurements. Other project work was happening on the laptop. Exact model revisions and SHA-256 hashes are in [models.json](models.json).

Observed loaded-process working sets were 52,314,112 bytes for embeddings and 1,902,718,976 bytes for generation. These sampled working sets exclude a claim about peak memory or total OS file cache. Runtime/model files total about 1.18 GB and stay in an ignored workspace cache.

The implementation uses exact cosine scans, FTS5, and reciprocal-rank fusion over a small corpus. It has no ANN index. A larger retained-history workload, multilingual token-aware chunking, richer multi-message reasoning, and a stronger independently evaluated evidence verifier are follow-ups supported by these limits. A larger or paid model was not tested or assumed to solve those problems.

# Verification and demonstration

`npm test` passes the full build, 20 unit/HTTP tests, and the existing desktop harness. Tests cover retained history beyond the old cap, exact/duplicate source identities, streaming updates, rendered-position ambiguity, JSON migration/restart, atomic legacy file copies with preserved outbox bytes, simulated migration rollback, future-schema refusal, model mismatch/rebuild, unavailable models, startup-empty indexing, cancellation/restart, paging beyond 200 messages, malicious source URLs, external origins/hosts, and existing delivery behavior. `npm run lint` and `npm run verify:clean-build` pass.

The real Electron/React renderer test used `.demo-profile` and 35 synthetic messages in `.demo-data`, with vendor views and outbox timers disabled. It searched Atlas history, invoked the actual local model, opened the exact SQLite citation, and asserted the outbox stayed empty. [desktop-demo.json](desktop-demo.json) records those assertions. The three local PNGs show search, selected evidence, and the source viewer.

Upstream master was fetched again after implementation and remained `a72844c4c41b0dd545429b4a55c87826e359565a`. Work is confined to `feature/9-conversation-search` for [issue 9](https://github.com/gurjas-s/blibs/issues/9). No default-branch change, release, or live conversation import was performed. The user must test the feature before any merge.

# Factual resume bullet drafts

- Implemented local conversation search in an Electron/React/TypeScript app with SQLite, FTS5, and BGE embeddings; hybrid retrieval improved recall@5 from 79% to 100% on a small versioned synthetic evaluation.
- Added transactional history migration, source-aware repeatable imports, restartable vector indexing, and inspectable citations; verified storage and delivery behavior with 20 unit/HTTP tests and a real Electron demo.

Implemented technologies: Electron, React, TypeScript, Node.js, SQLite/FTS5, local GGUF inference through llama.cpp, BGE embeddings, Qwen evidence selection. This work does not establish PyTorch, scikit-learn, LangChain, hosted API use, or model-training experience.
