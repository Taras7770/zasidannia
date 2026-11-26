#!/usr/bin/env node
// Повертає попередні дані про рішення з опублікованого сайту, коли свіжий архів ЄДРСР недоступний.
// Так нова публікація засідань не стирає рішення.
// Використання: node scripts/restore-decisions.mjs <адреса сайту> <тека даних>
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const base = (process.argv[2] || '').replace(/\/$/, '');
const out = process.argv[3] || 'web/data';
if (!base) {
  console.error('Не вказано адресу сайту');
  process.exit(1);
}
const UA = { 'User-Agent': 'zasidannia-restore/1.0' };

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
// GitHub Pages відповідає 429 на часті запити: тоді всі потоки чекають
let pauseUntil = 0;
async function get(url, tries = 10) {
  for (let i = 1; ; i++) {
    const wait = pauseUntil - Date.now();
    if (wait > 0) await sleep(wait);
    try {
      const r = await fetch(url, { headers: UA });
      if (r.status === 404) return null;
      if (r.status === 429) {
        const ra = +r.headers.get('retry-after') || Math.min(60, 5 * i);
        pauseUntil = Math.max(pauseUntil, Date.now() + ra * 1000);
        throw new Error('HTTP 429');
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) {
      if (i >= tries) throw new Error(`${url}: ${e.message}`);
      await sleep(1000 * i);
    }
  }
}

const decBuf = await get(`${base}/data/dec.json`);
if (!decBuf) {
  console.error('На сайті немає dec.json');
  process.exit(1);
}
const dec = JSON.parse(decBuf.toString('utf8'));
rmSync(join(out, 'd'), { recursive: true, force: true });
mkdirSync(join(out, 'd'), { recursive: true });

let next = 0;
let files = 0;
let bytes = 0;
async function worker() {
  while (next < dec.n) {
    const i = next++;
    const b = await get(`${base}/data/d/${i}.json.gz`);
    if (!b) continue;
    writeFileSync(join(out, 'd', `${i}.json.gz`), b);
    files++;
    bytes += b.length;
    if (files % 2000 === 0) console.log(`  ${files} файлів`);
  }
}
await Promise.all(Array.from({ length: 6 }, worker));
writeFileSync(join(out, 'dec.json'), decBuf);
console.log(`Повернуто попередні рішення: ${files} файлів (${(bytes / 1e6).toFixed(1)} МБ), побудовано ${dec.built}`);
