#!/usr/bin/env node
// Будує дані про судові рішення з відкритого набору ДСА України
// «Єдиний державний реєстр судових рішень» (data.gov.ua, архів за рік).
// Результат: dec.json і d/<код суду>_<частина>.json.gz. Тексти рішень не копіюються:
// застосунок відкриває рішення на reyestr.court.gov.ua за номером документа.
import { mkdirSync, writeFileSync, rmSync, createWriteStream, existsSync, statSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { TsvParser } from './tsv.mjs';
import { shardKey, caseBase, hash32, kyivToday } from '../web/core.js';

const VERSION = 1;
const UA = { 'User-Agent': 'zasidannia-open-data-reader/1.0 (personal court calendar)' };
const KNOWN = { 2026: '16ab7f06-7414-405f-8354-0a492475272d', 2025: '2a95ae17-ed46-42ae-ad66-dd9b7a727bb7' };
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  return m ? [m[1], m[2] ?? true] : [a, true];
}));
const OUT = args.out || 'web/data';
const DAYS = +(args.days || 90);
const PER_FILE = +(args.per || 1200);
const today = args.today || kyivToday();
const cutoffDate = new Date(today + 'T00:00:00Z');
cutoffDate.setUTCDate(cutoffDate.getUTCDate() - DAYS);
const cutoff = cutoffDate.toISOString().slice(0, 10);

async function findZip(year) {
  const pick = (pkg) => {
    const r = (pkg.resources || []).filter((x) => /zip/i.test(x.format) && x.url.includes(String(year)))
      .sort((a, b) => (a.last_modified < b.last_modified ? 1 : -1))[0];
    return r ? { url: r.url, modified: r.last_modified, size: r.size } : null;
  };
  if (KNOWN[year]) {
    const j = await (await fetch(`https://data.gov.ua/api/3/action/package_show?id=${KNOWN[year]}`, { headers: UA })).json();
    const r = pick(j.result);
    if (r) return r;
  }
  const q = encodeURIComponent(`title:"реєстр судових рішень за ${year} рік"`);
  const j = await (await fetch(`https://data.gov.ua/api/3/action/package_search?rows=10&q=${q}`, { headers: UA })).json();
  for (const p of j.result.results) {
    if (p.title.includes(String(year))) {
      const r = pick(p);
      if (r) return r;
    }
  }
  return null;
}
async function readEntry(zip, name, onRow) {
  const child = spawn('unzip', ['-p', zip, name], { stdio: ['ignore', 'pipe', 'inherit'] });
  const parser = new TsvParser(onRow);
  const dec = new TextDecoder('utf-8');
  for await (const b of child.stdout) parser.push(dec.decode(b, { stream: true }));
  parser.push(dec.decode());
  parser.end();
  return parser.bad;
}

const zips = [];
const sourceModified = {};
if (args.zip) {
  for (const z of String(args.zip).split(',')) zips.push(z);
  sourceModified.local = 'local';
} else {
  const years = [...new Set([+cutoff.slice(0, 4), +today.slice(0, 4)])];
  mkdirSync('/tmp/edrsr', { recursive: true });
  for (const y of years) {
    const info = await findZip(y);
    if (!info) {
      console.warn(`Архів за ${y} рік не знайдено`);
      continue;
    }
    const file = `/tmp/edrsr/${y}.zip`;
    console.log(`Завантаження ${info.url} (${info.size} байт, оновлено ${info.modified})`);
    const r = await fetch(info.url, { headers: UA });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    await pipeline(Readable.fromWeb(r.body), createWriteStream(file));
    console.log(`  збережено ${statSync(file).size} байт`);
    zips.push(file);
    sourceModified[y] = info.modified;
  }
}
if (!zips.length) {
  console.error('Немає архівів для обробки');
  process.exit(1);
}

const courts = new Map();
const forms = {};
const kinds = {};
const byKey = new Map();
const seen = new Set();
let total = 0;
let kept = 0;
let bad = 0;
for (const zip of zips) {
  const list = execFileSync('unzip', ['-Z1', zip]).toString().split('\n');
  const has = (n) => list.includes(n);
  if (has('courts.csv')) await readEntry(zip, 'courts.csv', (f) => f[0] !== 'court_code' && f[1] && courts.set(f[0], f[1]));
  if (has('judgment_forms.csv')) await readEntry(zip, 'judgment_forms.csv', (f) => f[0] !== 'judgment_code' && f[1] && (forms[f[0]] = f[1]));
  if (has('justice_kinds.csv')) await readEntry(zip, 'justice_kinds.csv', (f) => f[0] !== 'justice_kind' && f[1] && (kinds[f[0]] = f[1]));
  const t0 = Date.now();
  bad += await readEntry(zip, 'documents.csv', (f) => {
    total++;
    if (f.length < 12 || f[0] === 'doc_id') return;
    const recv = f[7].slice(0, 10);
    if (recv < cutoff || !/^\d{4}-\d\d-\d\d$/.test(recv)) return;
    const cause = f[5].replace(/\s+/g, '');
    if (!cause || !/^\d+$/.test(f[0]) || seen.has(f[0])) return;
    seen.add(f[0]);
    const key = shardKey(cause.toLowerCase());
    let arr = byKey.get(key);
    if (!arr) byKey.set(key, (arr = []));
    arr.push([+f[0], cause, f[6].slice(0, 10), recv, +f[2] || 0, +f[3] || 0, f[1], f[8].trim(), f[10] === '0' ? 0 : 1]);
    kept++;
  });
  console.log(`${zip}: рядків ${total}, залишено ${kept}, ${((Date.now() - t0) / 1000).toFixed(1)} с`);
}
if (kept < (args.min ? +args.min : 1000)) {
  console.error('Замало рішень. Дані про рішення не оновлено.');
  process.exit(1);
}

rmSync(join(OUT, 'd'), { recursive: true, force: true });
mkdirSync(join(OUT, 'd'), { recursive: true });
const b = {};
let files = 0;
let bytes = 0;
for (const [key, rows] of byKey) {
  const B = Math.max(1, Math.ceil(rows.length / PER_FILE));
  b[key] = B;
  const parts = Array.from({ length: B }, () => []);
  for (const r of rows) parts[hash32(caseBase(r[1])) % B].push(r);
  parts.forEach((part, i) => {
    if (!part.length) return;
    part.sort((x, y) => (x[3] < y[3] ? 1 : x[3] > y[3] ? -1 : y[0] - x[0]));
    const cm = new Map();
    const jm = new Map();
    const out = part.map((r) => {
      const cn = courts.get(r[6]) || '';
      if (!cm.has(cn)) cm.set(cn, cm.size);
      if (!jm.has(r[7])) jm.set(r[7], jm.size);
      return [r[0], r[1], r[2], r[3], r[4], r[5], cm.get(cn), jm.get(r[7]), r[8]];
    });
    const gz = gzipSync(JSON.stringify({ courts: [...cm.keys()], judges: [...jm.keys()], rows: out }), { level: 9 });
    writeFileSync(join(OUT, 'd', `${key}_${i}.json.gz`), gz);
    files++;
    bytes += gz.length;
  });
}
writeFileSync(join(OUT, 'dec.json'), JSON.stringify({
  v: VERSION, built: new Date().toISOString(), sourceModified, from: cutoff, rows: kept, bad, forms, kinds, b,
  source: 'ДСА України, набір «Єдиний державний реєстр судових рішень», data.gov.ua',
}));
console.log(`Рішень: ${kept}, файлів: ${files} (${(bytes / 1e6).toFixed(1)} МБ), судів: ${byKey.size}`);
