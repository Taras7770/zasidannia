#!/usr/bin/env node
// Будує базу «стан розгляду справ» з відкритого набору ДСА України
// «Інформація щодо стану розгляду справ» (dsa.court.gov.ua, набір 532, щоденні файли змін).
// База зберігається частинами base-<N>.tsv.gz. Кожен запуск обробляє кілька щоденних файлів
// і зливає їх з наявною базою. Для одного провадження залишається найновіший запис.
import {
  mkdirSync, writeFileSync, rmSync, createWriteStream, existsSync, readFileSync, appendFileSync, createReadStream,
  readdirSync, statSync,
} from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { gzipSync, gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { TsvParser } from './tsv.mjs';
import { caseBase, hash32 } from '../web/core.js';

const UA = { 'User-Agent': 'zasidannia-open-data-reader/1.0 (personal court calendar)' };
const PASSPORT = 'https://dsa.court.gov.ua/open_data_json.php?json=532';
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  return m ? [m[1], m[2] ?? true] : [a, true];
}));
const WORK = args.work || '/tmp/stan';
const BASE = join(WORK, 'base');
const OUT = join(WORK, 'out');
const TMP = join(WORK, 'tmp');
const MAX_FILES = +(args['max-files'] || 100);
const MAX_MIN = +(args['max-min'] || 110);
const MAX_ROWS = +(args['max-rows'] || 120e6);
const SHARDS_DEFAULT = +(args.shards || 512);
const started = Date.now();
const setOutput = (k, v) => process.env.GITHUB_OUTPUT && appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`);

for (const d of [OUT, TMP]) {
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
}
mkdirSync(BASE, { recursive: true });
const manPath = join(BASE, 'manifest.json');
const man = existsSync(manPath)
  ? JSON.parse(readFileSync(manPath, 'utf8'))
  : { v: 1, shards: SHARDS_DEFAULT, processed: [], failed: {}, skipped: [], rows: 0 };
const S = man.shards;

// ---- список щоденних файлів ----
let passport;
if (args.passport) passport = JSON.parse(readFileSync(args.passport, 'utf8'));
else passport = await (await fetch(PASSPORT, { headers: UA })).json();
const byDate = new Map();
for (const o of passport['Файли'] || []) {
  const [name, url] = Object.entries(o)[0];
  const m = /(\d\d)\.(\d\d)\.(\d{4})/.exec(name);
  if (!m) continue;
  const date = `${m[3]}-${m[2]}-${m[1]}`;
  const type = /\.zip$/i.test(name) ? 'zip' : /\.csv$/i.test(name) ? 'csv' : '';
  if (!type) continue;
  const prev = byDate.get(date);
  if (!prev || (prev.type === 'csv' && type === 'zip')) byDate.set(date, { date, url, type });
}
// Ремонт: повторна обробка вже оброблених файлів лише для вказаних частин бази
if (args.repair && args.repair !== true) {
  const ids = String(args.repair).split(',').map((x) => +x).filter((x) => Number.isInteger(x) && x >= 0 && x < S);
  man.redoShards = [...new Set([...(man.redoShards || []), ...ids])];
  man.redo = [...new Set([...(man.redo || []), ...man.processed])];
  console.log(`Ремонт частин ${man.redoShards.join(',')}: файлів до повторної обробки ${man.redo.length}`);
}
// Повторна обробка останніх N файлів для всіх частин (після зміни правил злиття)
if (args['reprocess-last']) {
  const last = [...man.processed].sort().slice(-(+args['reprocess-last']));
  man.redo = [...new Set([...(man.redo || []), ...last])];
  console.log(`Повторна обробка останніх файлів: ${last.length}`);
}
const redoSet = new Set(man.redoShards || []);
const redoOnly = redoSet.size ? redoSet : null;
const done = new Set([...man.processed, ...man.skipped]);
const from = args.from || '2000-01-01';
const todo = [...byDate.values()]
  .filter((f) => !done.has(f.date) && (man.failed[f.date] || 0) < 3 && f.date >= from)
  .sort((a, b) => (a.date < b.date ? 1 : -1));
const redoTodo = (man.redo || []).filter((d) => byDate.has(d) && (man.failed['r' + d] || 0) < 3).sort().reverse()
  .map((d) => ({ ...byDate.get(d), redo: true }));
console.log(`Файлів у наборі: ${byDate.size}, оброблено раніше: ${man.processed.length}, залишилось: ${todo.length}, на ремонт: ${redoTodo.length}`);

// ---- тимчасові частини ----
const bufs = Array.from({ length: S }, () => []);
let buffered = 0;
function flushAll() {
  for (let i = 0; i < S; i++) {
    if (!bufs[i].length) continue;
    appendFileSync(join(TMP, `p${i}.gz`), gzipSync(bufs[i].join(''), { level: 4 }));
    bufs[i] = [];
  }
  buffered = 0;
}
const clean = (s) => (s || '').replace(/[\t\r\n\u0001]+/g, ' ').replace(/ {2,}/g, ' ').trim();
const iso = (d) => {
  const m = /^(\d\d)\.(\d\d)\.(\d{4})/.exec(d || '');
  if (!m || +m[3] < 1990 || +m[3] > 2100) return '';
  return `${m[3]}-${m[2]}-${m[1]}`;
};
const NEED = ['court_name', 'case_number', 'case_proc', 'registration_date', 'judge', 'participants', 'stage_date', 'stage_name', 'cause_result', 'type', 'description'];
let rowsBatch = 0;

async function parseStream(stream, date, only) {
  let idx = null;
  let n = 0;
  let unsupported = false;
  const parser = new TsvParser((c) => {
    if (unsupported) return;
    if (!idx) {
      const head = c.map((x) => x.trim().toLowerCase());
      if (!head.includes('court_name') || !head.includes('case_number')) {
        unsupported = true;
        return;
      }
      idx = NEED.map((k) => head.indexOf(k));
      return;
    }
    const g = (k) => (idx[k] >= 0 ? c[idx[k]] || '' : '');
    const num = clean(g(1)).replace(/\s+/g, '');
    const court = clean(g(0));
    if (!num || !court || num === 'case_number') return;
    const line = [date, court, num, clean(g(2)), iso(g(3)), clean(g(4)), clean(g(5)).slice(0, 1500), iso(g(6)),
      clean(g(7)), clean(g(8)), clean(g(9)), clean(g(10)).slice(0, 300)].join('\t') + '\n';
    const i = hash32(caseBase(num)) % S;
    if (only && !only.has(i)) return;
    bufs[i].push(line);
    buffered += line.length;
    n++;
    if (buffered > 200e6) flushAll();
  });
  const dec = new TextDecoder('utf-8');
  for await (const b of stream) parser.push(dec.decode(b, { stream: true }));
  parser.push(dec.decode());
  parser.end();
  return unsupported && !n ? -1 : n;
}
async function download(f) {
  const file = join(TMP, `src-${f.date}.${f.type}`);
  if (!/^https?:/.test(f.url)) return f.url; // локальний файл (тести)
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(f.url, { headers: UA });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await pipeline(Readable.fromWeb(r.body), createWriteStream(file));
      if (f.type === 'zip') execFileSync('unzip', ['-Z1', file], { stdio: ['ignore', 'pipe', 'ignore'] });
      return file;
    } catch (e) {
      if (attempt === 2) throw e;
      await new Promise((res) => setTimeout(res, 3000));
    }
  }
}
async function processFile(f, file) {
  let n = 0;
  if (f.type === 'zip') {
    const names = execFileSync('unzip', ['-Z1', file]).toString().trim().split('\n').filter((x) => /\.csv$/i.test(x));
    for (const name of names) {
      const child = spawn('unzip', ['-p', file, name], { stdio: ['ignore', 'pipe', 'ignore'] });
      const k = await parseStream(child.stdout, f.date, f.redo ? redoOnly : null);
      if (k > 0) n += k;
    }
    if (!names.length) return -1;
  } else {
    n = await parseStream(createReadStream(file), f.date, f.redo ? redoOnly : null);
  }
  return n;
}

// ---- обробка з попереднім завантаженням ----
const batch = todo.slice(0, MAX_FILES);
for (const f of redoTodo) if (batch.length < MAX_FILES) batch.push(f);
const pending = new Map();
const startDl = (k) => {
  if (k < batch.length && !pending.has(k)) pending.set(k, download(batch[k]).then((file) => ({ file }), (err) => ({ err })));
};
let filesDone = 0;
let redoDone = 0;
for (let k = 0; k < batch.length; k++) {
  if ((Date.now() - started) / 60000 > MAX_MIN || rowsBatch > MAX_ROWS) break;
  for (let j = k; j < k + 3; j++) startDl(j);
  const f = batch[k];
  const { file, err } = await pending.get(k);
  pending.delete(k);
  if (err) {
    const fk = (f.redo ? 'r' : '') + f.date;
    man.failed[fk] = (man.failed[fk] || 0) + 1;
    console.log(`${f.date}: помилка завантаження (${err.message})`);
    continue;
  }
  const t0 = Date.now();
  let n;
  try {
    n = await processFile(f, file);
  } catch (e) {
    n = -2;
    console.log(`${f.date}: помилка розбору (${e.message})`);
  }
  if (/^https?:/.test(f.url)) rmSync(file, { force: true });
  if (f.redo) {
    if (n === -2) man.failed['r' + f.date] = (man.failed['r' + f.date] || 0) + 1;
    else {
      man.redo = man.redo.filter((d) => d !== f.date);
      rowsBatch += Math.max(0, n);
      filesDone++;
      redoDone++;
    }
  } else if (n === -1) man.skipped.push(f.date);
  else if (n === -2) man.failed[f.date] = (man.failed[f.date] || 0) + 1;
  else {
    man.processed.push(f.date);
    rowsBatch += n;
    filesDone++;
  }
  if (filesDone % 10 === 0 || n < 0) console.log(`${f.date}: ${n} рядків, ${((Date.now() - t0) / 1000).toFixed(0)} с, усього в запуску ${rowsBatch}`);
}
for (const p of pending.values()) await p;
flushAll();
console.log(`Оброблено файлів: ${filesDone}, рядків: ${rowsBatch}, ${((Date.now() - started) / 60000).toFixed(1)} хв`);

// ---- злиття з базою ----
// Перевага: запис зі стадією або результатом, потім новіший файл, потім новіша дата стадії.
// Записи Верховного Суду не мають назви стадії, але мають результат.
const better = (a, b) => {
  const sa = a[8] || a[9] ? 1 : 0;
  const sb = b[8] || b[9] ? 1 : 0;
  if (sa !== sb) return sa > sb;
  if (a[0] !== b[0]) return a[0] > b[0];
  return a[7] > b[7];
};
let total = 0;
let bytes = 0;
let changed = 0;
for (let i = 0; i < S; i++) {
  const tmp = join(TMP, `p${i}.gz`);
  const basef = join(BASE, `base-${i}.tsv.gz`);
  const hasTmp = existsSync(tmp);
  const map = new Map();
  const feed = (text) => {
    for (const line of text.split('\n')) {
      if (!line) continue;
      const c = line.split('\t');
      if (c.length < 12) continue;
      const key = `${c[1]}\u0001${c[2]}\u0001${c[3]}`;
      const prev = map.get(key);
      if (!prev || better(c, prev)) map.set(key, c);
    }
  };
  if (existsSync(basef)) feed(gunzipSync(readFileSync(basef)).toString('utf8'));
  const baseCount = map.size;
  if (hasTmp) {
    feed(gunzipSync(readFileSync(tmp)).toString('utf8'));
    rmSync(tmp);
  }
  total += map.size;
  if (!hasTmp) continue;
  const rows = [...map.values()].sort((a, b) => (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : a[7] < b[7] ? 1 : -1));
  const gz = gzipSync(rows.map((c) => c.join('\t')).join('\n') + '\n', { level: 9 });
  writeFileSync(join(OUT, `base-${i}.tsv.gz`), gz);
  bytes += gz.length;
  changed++;
  if (i === 0) console.log(`Частина 0: було ${baseCount}, стало ${map.size}`);
}
man.processed.sort();
man.rows = total;
man.newest = man.processed[man.processed.length - 1] || '';
man.oldest = man.processed[0] || '';
man.updated = new Date().toISOString();
const left = [...byDate.values()].filter((f) => !man.processed.includes(f.date) && !man.skipped.includes(f.date) && (man.failed[f.date] || 0) < 3 && f.date >= from).length;
const redoLeft = (man.redo || []).filter((d) => byDate.has(d) && (man.failed['r' + d] || 0) < 3).length;
if (!redoLeft) {
  delete man.redoShards;
  delete man.redo;
}
man.remaining = left;
man.redoRemaining = redoLeft;
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(man));
console.log(`База: ${total} проваджень, змінено частин: ${changed} (${(bytes / 1e6).toFixed(1)} МБ), файли від ${man.oldest} до ${man.newest}, залишилось файлів: ${man.remaining}, на ремонт: ${man.redoRemaining}`);
setOutput('remaining', man.remaining + man.redoRemaining);
setOutput('done', filesDone);
