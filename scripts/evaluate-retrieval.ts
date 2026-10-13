import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { HistoryStore } from '../server/history.ts';
import { RetrievalService } from '../server/retrieval.ts';
import { messages, questions, VERSION } from '../evaluation/corpus.ts';

const partition = process.argv.find(arg => arg.startsWith('--partition='))?.split('=')[1] || 'held-out';
if (!['tuning', 'held-out'].includes(partition)) throw new Error('Choose tuning or held-out.');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blibs-evaluation-'));
const store = new HistoryStore(dir); store.import(messages);
const service = new RetrievalService(store);
if (!service.status().embeddingConfigured || !service.status().generationConfigured) throw new Error('Run the documented local model setup before evaluating. No stubs or paid APIs are used.');
const indexStarted = performance.now(); await service.startIndex();
if (store.pending(service.model).length) throw new Error(`Index incomplete: ${service.indexError}`);
const indexMs = performance.now() - indexStarted;
const rows: Record<string, unknown>[] = [];
const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))] || 0;
try {
  for (const q of questions.filter(q => q.partition === partition)) {
    const keyword = await service.search(q.query, {}, 'keyword', 5);
    const hybrid = await service.search(q.query, {}, 'hybrid', 5);
    const start = performance.now(); const answer = await service.ask(q.query); const answerMs = performance.now() - start;
    const supportIds = new Set(store.list().filter(m => q.support.includes(m.sourceId)).map(m => m.id));
    const recall = (items: { id: string }[], k: number) => supportIds.size ? items.slice(0, k).filter(m => supportIds.has(m.id)).length / supportIds.size : null;
    const supportedClaims = answer.claims.filter(c => supportIds.has(c.sourceId) && store.message(c.sourceId)?.text.includes(c.quote) && c.text === c.quote).length;
    const answerComplete = !q.abstain && !answer.abstained && q.required.every(term => answer.answer.toLowerCase().includes(term.toLowerCase())) && q.support.every(source => answer.claims.some(c => store.message(c.sourceId)?.sourceId === source));
    const sourceUrlsPreserved = answer.sources.every(source => store.message(source.id)?.url === source.url && source.url.startsWith('https://'));
    const row = { id: q.id, kind: q.kind, query: q.query, keywordRecall3: recall(keyword.results, 3), keywordRecall5: recall(keyword.results, 5), hybridRecall3: recall(hybrid.results, 3), hybridRecall5: recall(hybrid.results, 5), keywordMs: keyword.latencyMs, hybridMs: hybrid.latencyMs, answerMs, answerComplete, expectedAbstain: Boolean(q.abstain), abstained: answer.abstained, supportedClaims, claims: answer.claims.length, sourceUrlsPreserved, answer: answer.answer, citations: answer.claims.map(c => ({ source: store.message(c.sourceId)?.sourceId, quote: c.quote })) };
    rows.push(row); console.log(JSON.stringify({ id: q.id, complete: answerComplete, abstained: answer.abstained, support: `${supportedClaims}/${answer.claims.length}`, answerMs: Math.round(answerMs) }));
  }
  const sum = (key: string) => rows.reduce((n, r) => n + Number(r[key] || 0), 0);
  const answerable = rows.filter(r => !r.expectedAbstain), missing = rows.filter(r => r.expectedAbstain);
  const meanRecall = (key: string) => answerable.reduce((n, r) => n + Number(r[key]), 0) / answerable.length;
  const report = { version: VERSION, partition, createdAt: new Date().toISOString(), models: { embedding: service.model, generation: process.env.BLIBS_GENERATION_MODEL, runtime: 'llama.cpp b11598 CPU', temperature: 0, seed: 7, threadsPerModel: 2 }, environment: { node: process.version, platform: process.platform, cpu: os.cpus()[0].model, memoryGiB: os.totalmem() / 2 ** 30 }, corpus: { messages: messages.length, questionsTotal: questions.length, evaluated: rows.length, answerable: answerable.length, expectedAbstentions: missing.length, chunksIndexed: service.status().indexed, indexMs }, metrics: { keywordRecall3: meanRecall('keywordRecall3'), keywordRecall5: meanRecall('keywordRecall5'), hybridRecall3: meanRecall('hybridRecall3'), hybridRecall5: meanRecall('hybridRecall5'), answerCompleteness: answerable.filter(r => r.answerComplete).length / answerable.length, citationSupportPrecision: sum('claims') ? sum('supportedClaims') / sum('claims') : null, abstentionAccuracy: missing.filter(r => r.abstained).length / missing.length, falseAbstentions: answerable.filter(r => r.abstained).length, sourceUrlPreservation: rows.filter(r => r.sourceUrlsPreserved).length / rows.length, keywordP50Ms: percentile(rows.map(r => Number(r.keywordMs)), .5), hybridP50Ms: percentile(rows.map(r => Number(r.hybridMs)), .5), hybridP95Ms: percentile(rows.map(r => Number(r.hybridMs)), .95), answerP50Ms: percentile(rows.map(r => Number(r.answerMs)), .5), answerP95Ms: percentile(rows.map(r => Number(r.answerMs)), .95) }, supportDefinition: 'Each claim must cite a labeled supporting message, preserve its exact sentence, and answer the labeled question. Completeness additionally requires all labeled facts/sources. True but irrelevant quotes fail support. Source URL preservation does not validate fictitious fixture threads on vendor sites.', rows };
  const provenance = { retrievalSourceSha256: createHash('sha256').update(fs.readFileSync('server/retrieval.ts')).digest('hex'), selection: 'one exact sentence, two for explicit conflict; conservative deictic ambiguity check', maxGenerationTokens: 240, chunkCharacters: 1000, chunkOverlap: 150, cosineThreshold: 0.35, rankFusionConstant: 60 };
  fs.mkdirSync('evidence', { recursive: true }); fs.writeFileSync(`evidence/evaluation-${partition}.json`, JSON.stringify({ ...report, provenance }, null, 2)); console.log(JSON.stringify(report.metrics, null, 2));
} finally { await service.close(); fs.rmSync(dir, { recursive: true }); }
