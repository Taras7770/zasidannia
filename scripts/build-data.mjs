#!/usr/bin/env node
// Будує дані для застосунку з відкритого набору ДСА України
// «Список справ призначених до розгляду» (data.gov.ua, ліцензія CC BY).
// Результат: meta.json, c/<код суду>.json.gz (засідання), n/<префікс>.txt.gz (індекс імен).
import { mkdirSync, writeFileSync, rmSync, createReadStream, appendFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { TsvParser } from './tsv.mjs';
import { tokenize, shardKey, bucketName, kyivToday } from '../web/core.js';

const VERSION = 1;
const DATASET = '3a321301-a06f-487b-9d19-e6b917250aee';
const CKAN = `https://data.gov.ua/api/3/action/package_show?id=${DATASET}`;
const FALLBACK = `https://data.gov.ua/dataset/${DATASET}/resource/98d6ba0d-1c18-4835-ae68-bfc0af724bfa/download/spisok-sprav-priznachenih-do-rozglyadu.csv`;
const UA = { 'User-Agent': 'zasidannia-open-data-reader/1.0 (personal court calendar)' };

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    return m ? [m[1], m[2] ?? true] : [a, true];
  }),
);
const OUT = args.out || 'web/data';
// Минулі засідання залишаються в даних: застосунок показує історію справи
const PAST_DAYS = +(args.past || 400);
const today = args.today || kyivToday();
const cutoff = (() => {
  const d = new Date(today + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - PAST_DAYS);
  return d.toISOString().slice(0, 10) + 'T00:00';
})();

function setOutput(k, v) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`);
}

async function sourceInfo() {
  if (args.src) return { url: args.src, modified: args.modified || 'local' };
  try {
    const r = await fetch(CKAN, { headers: UA });
    const j = await r.json();
    const res = j.result.resources.find((x) => /csv/i.test(x.format)) || j.result.resources[0];
    return { url: res.url, modified: res.last_modified || j.result.metadata_modified, size: res.size };
  } catch (e) {
    console.warn('CKAN недоступний, беру запасну адресу:', e.message);
    return { url: FALLBACK, modified: new Date().toISOString() };
  }
}

async function* textChunks(url) {
  const dec = new TextDecoder('utf-8');
  if (!/^https?:/.test(url)) {
    for await (const b of createReadStream(url)) yield dec.decode(b, { stream: true });
  } else {
    const r = await fetch(url, { headers: UA });
    if (!r.ok) throw new Error(`Завантаження CSV: HTTP ${r.status}`);
    for await (const b of r.body) yield dec.decode(b, { stream: true });
  }
  yield dec.decode();
}

const src = await sourceInfo();
console.log('Джерело:', src.url, 'оновлено:', src.modified, 'розмір:', src.size || '?');

if (args['if-changed']) {
  try {
    const r = await fetch(args['if-changed'], { headers: UA });
    if (r.ok) {
      const live = await r.json();
      const ageH = (Date.now() - Date.parse(live.built)) / 36e5;
      if (live.v === VERSION && live.sourceModified === src.modified && ageH < 30) {
        console.log('Джерело не змінилося. Нова публікація не потрібна.');
        setOutput('changed', 'false');
        process.exit(0);
      }
    }
  } catch (e) {
    console.warn('Не вдалося прочитати опубліковані дані:', e.message);
  }
}

const shards = new Map();
let total = 0;
let kept = 0;
let badRows = 0;
let maxIso = '';
const dateRe = /^(\d\d)\.(\d\d)\.(\d{4})\s+(\d\d):(\d\d)/;
const clean = (s) => s.replace(/\s*\r?\n\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();

const parser = new TsvParser((f) => {
  total++;
  if (f.length !== 7) {
    if (!(f.length === 1 && f[0] === '')) badRows++;
    return;
  }
  const m = dateRe.exec(f[0]);
  if (!m) {
    if (f[0] !== 'date') badRows++;
    return;
  }
  const iso = `${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}`;
  if (iso < cutoff) return;
  const caseNo = f[2].replace(/\s+/g, '');
  if (!caseNo) {
    badRows++;
    return;
  }
  const key = shardKey(caseNo.toLowerCase());
  let sh = shards.get(key);
  if (!sh) shards.set(key, (sh = { courts: new Map(), judges: new Map(), rows: [] }));
  const court = clean(f[3]);
  const judges = clean(f[1]);
  let ci = sh.courts.get(court);
  if (ci === undefined) sh.courts.set(court, (ci = sh.courts.size));
  let ji = sh.judges.get(judges);
  if (ji === undefined) sh.judges.set(judges, (ji = sh.judges.size));
  sh.rows.push([iso, ji, caseNo, ci, clean(f[4]), clean(f[5]), clean(f[6])]);
  kept++;
  if (iso > maxIso) maxIso = iso;
});

const t0 = Date.now();
for await (const chunk of textChunks(src.url)) parser.push(chunk);
parser.end();
badRows += parser.bad;
console.log(`Прочитано рядків: ${total}, залишено: ${kept}, зіпсовано: ${badRows}, ${((Date.now() - t0) / 1000).toFixed(1)} с`);
if (kept < (args.min ? +args.min : 1000)) {
  console.error('Замало даних. Публікацію скасовано.');
  process.exit(1);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, 'c'), { recursive: true });
mkdirSync(join(OUT, 'n'), { recursive: true });

const metaShards = {};
const postings = new Map(); // слово -> [код частини, індекс, ...]
const keys = [...shards.keys()].sort();
let finalRows = 0;
for (const key of keys) {
  const sh = shards.get(key);
  sh.rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0));
  const rows = [];
  let prev = '';
  for (const r of sh.rows) {
    const sig = `${r[0]}|${r[2]}|${r[3]}|${r[4]}|${r[5]}`;
    if (sig === prev) continue;
    prev = sig;
    rows.push(r);
  }
  const courtCount = new Map();
  rows.forEach((r, idx) => {
    courtCount.set(r[3], (courtCount.get(r[3]) || 0) + 1);
    for (const tok of new Set(tokenize(r[5]))) {
      if (/^\d+$/.test(tok)) continue;
      let p = postings.get(tok);
      if (!p) postings.set(tok, (p = []));
      p.push(key, idx);
    }
  });
  const courts = [...sh.courts.keys()];
  const main = [...courtCount.entries()].sort((a, b) => b[1] - a[1])[0];
  metaShards[key] = [rows.length, main ? courts[main[0]] : ''];
  finalRows += rows.length;
  const json = JSON.stringify({ k: key, courts, judges: [...sh.judges.keys()], rows });
  writeFileSync(join(OUT, 'c', `${key}.json.gz`), gzipSync(json, { level: 9 }));
  shards.delete(key);
}

// Лише слова, які є майже в кожному записі (назви ролей), не входять до індексу.
// Поширені імена залишаються: без них запит «прізвище імʼя» був би неточним.
const STOP_LIMIT = Math.max(+(args.stop || 0) || 0, Math.round(finalRows * 0.15), 50);
const stop = [];
const buckets = new Map();
for (const [tok, p] of postings) {
  if (p.length / 2 > STOP_LIMIT) {
    stop.push(tok);
    continue;
  }
  const groups = [];
  let curKey = null;
  let cur = null;
  for (let i = 0; i < p.length; i += 2) {
    if (p[i] !== curKey) {
      if (cur) groups.push(`${curKey}:${cur.join(',')}`);
      curKey = p[i];
      cur = [];
    }
    cur.push(p[i + 1]);
  }
  if (cur) groups.push(`${curKey}:${cur.join(',')}`);
  const b = bucketName(tok);
  let arr = buckets.get(b);
  if (!arr) buckets.set(b, (arr = []));
  arr.push(`${tok}\t${groups.join(';')}`);
}
let idxBytes = 0;
for (const [b, lines] of buckets) {
  const gz = gzipSync(lines.join('\n'), { level: 9 });
  idxBytes += gz.length;
  writeFileSync(join(OUT, 'n', `${b}.txt.gz`), gz);
}

const meta = {
  v: VERSION,
  built: new Date().toISOString(),
  sourceModified: src.modified,
  source: 'ДСА України, набір «Список справ призначених до розгляду», data.gov.ua, CC BY',
  from: cutoff,
  to: maxIso,
  rows: finalRows,
  bad: badRows,
  stop: stop.sort(),
  shards: metaShards,
};
writeFileSync(join(OUT, 'meta.json'), JSON.stringify(meta));
console.log(`Частин: ${keys.length}, засідань: ${finalRows}, слів в індексі: ${postings.size - stop.length}, ` +
  `файлів індексу: ${buckets.size} (${(idxBytes / 1e6).toFixed(1)} МБ), стоп-слів: ${stop.length}`);
setOutput('changed', 'true');
