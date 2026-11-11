#!/usr/bin/env node
// Самоперевірка на побудованих даних: випадкові засідання мають знаходитися
// і за номером справи, і за учасником. Імена в журнал не потрапляють.
import { readFileSync, existsSync } from 'node:fs';
import { DataClient, tokenize, normCase } from '../web/core.js';
const dir = process.argv[2] || 'web/data';
const N = +(process.argv[3] || 150);
let files = 0;
let bytes = 0;
const dc = new DataClient(async (path) => {
  const f = `${dir}/${path.split('?')[0]}`;
  if (!existsSync(f)) return null;
  const b = readFileSync(f);
  files++;
  bytes += b.length;
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
});
const meta = await dc.meta();
const stop = new Set(meta.stop);
const keys = Object.keys(meta.shards);
let seed = 12345;
const rnd = (n) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
let okCase = 0, okName = 0, tried = 0, triedName = 0, maxShards = 0, sumShards = 0, sumBytes = 0, maxBytes = 0, trunc = 0, missed = 0, narrow = 0;
for (let i = 0; i < N; i++) {
  const sh = await dc.shard(keys[rnd(keys.length)]);
  if (!sh || !sh.rows.length) continue;
  const row = DataClient.row(sh, sh.rows[rnd(sh.rows.length)]);
  tried++;
  const rc = await dc.findCase(row.case.split('(')[0]);
  if (rc.rows.some((r) => r.iso === row.iso && normCase(r.case) === normCase(row.case))) okCase++;
  // запит: перші два слова після назви ролі (імітація «прізвище імʼя» або назви організації)
  const after = row.involved.slice(row.involved.indexOf(':') + 1).split(/,\s+[^,:]{2,60}:\s/)[0];
  const toks = [...new Set(tokenize(after))].filter((t) => !stop.has(t) && !/^\d+$/.test(t)).slice(0, 2);
  if (toks.length < 2) continue;
  triedName++;
  const fresh = new DataClient(dc.fetchBytes);
  const b0 = bytes;
  const rn = await fresh.findName(toks.join(' '));
  const used = bytes - b0;
  if (!rn.truncated) {
    narrow++;
    sumBytes += used;
    maxBytes = Math.max(maxBytes, used);
    sumShards += rn.shards || 0;
    maxShards = Math.max(maxShards, rn.shards || 0);
  }
  const hit = rn.rows.some((r) => r.iso === row.iso && normCase(r.case) === normCase(row.case));
  if (hit) okName++;
  else if (rn.truncated) trunc++;
  else missed++;
}
console.log(`Пошук за номером: ${okCase}/${tried}. Пошук за учасником: ${okName}/${triedName} (надто широкий запит: ${trunc}, пропущено: ${missed}).`);
console.log(`Точний запит за учасником (${narrow}): у середньому ${(sumShards / (narrow || 1)).toFixed(1)} судів і ${(sumBytes / (narrow || 1) / 1024).toFixed(0)} КБ, максимум ${maxShards} судів і ${(maxBytes / 1024).toFixed(0)} КБ.`);
// рішення: випадкові записи мають знаходитися за номером справи
const dm = await dc.decMeta();
let decOk = 0, decTried = 0;
if (dm) {
  const { readdirSync } = await import('node:fs');
  const { gunzipSync } = await import('node:zlib');
  const dfiles = readdirSync(`${dir}/d`);
  for (let i = 0; i < 60 && dfiles.length; i++) {
    const f = JSON.parse(gunzipSync(readFileSync(`${dir}/d/${dfiles[rnd(dfiles.length)]}`)).toString());
    const causes = Object.keys(f.c);
    const cause = causes[rnd(causes.length)];
    const id = f.c[cause][0][0];
    decTried++;
    const got = await dc.decisions(cause);
    if (got && got.some((x) => x.id === id && x.court && /^\d{4}-/.test(x.adj))) decOk++;
  }
  console.log(`Рішення: ${decOk}/${decTried} знайдено за номером справи. Усього рішень: ${dm.rows}, з ${dm.from}.`);
} else console.log('Даних про рішення немає.');
if (okCase < tried || missed > 0 || decOk < decTried) {
  console.error('Самоперевірка не пройдена.');
  process.exit(1);
}
