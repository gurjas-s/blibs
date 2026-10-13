import fs from 'node:fs';
import path from 'node:path';
import { HistoryStore } from '../server/history.ts';
import { messages } from '../evaluation/corpus.ts';
const dataDir = path.resolve('.demo-data');
fs.mkdirSync(dataDir, { recursive: true });
const store = new HistoryStore(dataDir); console.log(store.import(messages)); store.close();
console.log(`Synthetic history is ready at ${dataDir}. No vendor sign-in or real conversation import is required.`);
