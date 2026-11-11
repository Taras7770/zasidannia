#!/usr/bin/env node
// Будує дані про судові рішення з відкритого набору ДСА України
// «Єдиний державний реєстр судових рішень» (data.gov.ua, архів за рік).
// Результат: dec.json і d/<код суду>_<частина>.json.gz. Тексти рішень не копіюються:
// застосунок відкриває рішення на reyestr.court.gov.ua за номером документа.
import { mkdirSync, writeFileSync, rmSync, createWriteStream, existsSync, statSync, appendFileSync, readFileSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { TsvParser } from './tsv.mjs';
import { shardKey, caseBase, hash32, kyivToday } from '../web/core.js';

const VERSION = 2;
const UA = { 'User-Agent': 'zasidannia-open-data-reader/1.0 (personal court calendar)' };
const KNOWN = { 2026: '16ab7f06-7414-405f-8354-0a492475272d', 2025: '2a95ae17-ed46-42ae-ad66-dd9b7a727bb7' };
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  return m ? [m[1], m[2] ?? true] : [a, true];
}));
const OUT = args.out || 'web/data';
// Скільки років рішень тримати (разом з поточним). Зупинені справи мають старі рішення.
const YEARS = +(args.years || 4);
const today = args.today || kyivToday();
const cutoff = args.days
  ? new Date(Date.parse(today + 'T00:00:00Z') - +args.days * 864e5).toISOString().slice(0, 10)
  : `${+today.slice(0, 4) - YEARS + 1}-01-01`;
// Кількість файлів результату: близько 1300 рішень у файлі
const NFILES = +(args.files || 0) || 6000 * (+today.slice(0, 4) - +cutoff.slice(0, 4) + 1);
const PARTS = 128;
const TMP = args.tmp || '/tmp/dparts';

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
  const years = [];
  for (let y = +cutoff.slice(0, 4); y <= +today.slice(0, 4); y++) years.push(y);
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
let total = 0;
let kept = 0;
let bad = 0;
// Етап 1: рядки розкладаємо у тимчасові файли, щоб не тримати десятки мільйонів записів у памʼяті
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const bufs = Array.from({ length: PARTS }, () => []);
const sizes = new Array(PARTS).fill(0);
const flush = (i) => {
  if (!bufs[i].length) return;
  appendFileSync(join(TMP, `p${i}.tsv`), bufs[i].join(''));
  bufs[i] = [];
  sizes[i] = 0;
};
for (const zip of zips) {
  const list = execFileSync('unzip', ['-Z1', zip]).toString().split('\n');
  const has = (n) => list.includes(n);
  if (has('courts.csv')) await readEntry(zip, 'courts.csv', (f) => f[0] !== 'court_code' && f[1] && courts.set(f[0], f[1]));
  if (has('judgment_forms.csv')) await readEntry(zip, 'judgment_forms.csv', (f) => f[0] !== 'judgment_code' && f[1] && (forms[f[0]] = f[1]));
  if (has('justice_kinds.csv')) await readEntry(zip, 'justice_kinds.csv', (f) => f[0] !== 'justice_kind' && f[1] && (kinds[f[0]] = f[1]));
  const t0 = Date.now();
  const before = kept;
  bad += await readEntry(zip, 'documents.csv', (f) => {
    total++;
    if (f.length < 12 || f[0] === 'doc_id') return;
    const recv = f[7].slice(0, 10);
    if (recv < cutoff || !/^\d{4}-\d\d-\d\d$/.test(recv)) return;
    const cause = f[5].replace(/\s+/g, '');
    if (!cause || !/^\d+$/.test(f[0])) return;
    const bucket = hash32(caseBase(cause)) % NFILES;
    const part = bucket % PARTS;
    const line = `${bucket}\t${f[0]}\t${cause}\t${f[6].slice(0, 10)}\t${recv}\t${+f[2] || 0}\t${+f[3] || 0}\t${f[1]}\t${f[8].trim().replace(/[\t\n]/g, ' ')}\t${f[10] === '0' ? 0 : 1}\n`;
    bufs[part].push(line);
    sizes[part] += line.length;
    if (sizes[part] > 1 << 20) flush(part);
    kept++;
  });
  console.log(`${zip}: залишено ${kept - before}, ${((Date.now() - t0) / 1000).toFixed(1)} с`);
}
for (let i = 0; i < PARTS; i++) flush(i);
if (kept < (args.min ? +args.min : 1000)) {
  console.error('Замало рішень. Дані про рішення не оновлено.');
  process.exit(1);
}

// Етап 2: кожен тимчасовий файл ділимо на файли результату
rmSync(join(OUT, 'd'), { recursive: true, force: true });
mkdirSync(join(OUT, 'd'), { recursive: true });
let files = 0;
let bytes = 0;
let rowsOut = 0;
for (let i = 0; i < PARTS; i++) {
  const file = join(TMP, `p${i}.tsv`);
  if (!existsSync(file)) continue;
  const groups = new Map();
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    const c = line.split('\t');
    let g = groups.get(c[0]);
    if (!g) groups.set(c[0], (g = []));
    g.push(c);
  }
  rmSync(file);
  for (const [bucket, part] of groups) {
    part.sort((x, y) => (x[4] < y[4] ? 1 : x[4] > y[4] ? -1 : y[1] - x[1]));
    const cm = new Map();
    const jm = new Map();
    const out = [];
    let prev = '';
    for (const r of part) {
      if (r[1] === prev) continue;
      prev = r[1];
      const cn = courts.get(r[7]) || '';
      if (!cm.has(cn)) cm.set(cn, cm.size);
      if (!jm.has(r[8])) jm.set(r[8], jm.size);
      out.push([+r[1], r[2], r[3], r[4], +r[5], +r[6], cm.get(cn), jm.get(r[8]), +r[9]]);
    }
    const gz = gzipSync(JSON.stringify({ courts: [...cm.keys()], judges: [...jm.keys()], rows: out }), { level: 6 });
    writeFileSync(join(OUT, 'd', `${bucket}.json.gz`), gz);
    files++;
    bytes += gz.length;
    rowsOut += out.length;
  }
}
kept = rowsOut;
writeFileSync(join(OUT, 'dec.json'), JSON.stringify({
  v: VERSION, built: new Date().toISOString(), sourceModified, from: cutoff, rows: kept, bad, forms, kinds, n: NFILES,
  source: 'ДСА України, набір «Єдиний державний реєстр судових рішень», data.gov.ua',
}));
console.log(`Рішень: ${kept} з ${cutoff}, файлів: ${files} (${(bytes / 1e6).toFixed(1)} МБ)`);
