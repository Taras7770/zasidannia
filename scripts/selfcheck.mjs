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
let okCase = 0, okName = 0, tried = 0, triedName = 0, maxShards = 0, sumShards = 0, sumBytes = 0, maxBytes = 0, trunc = 0;
for (let i = 0; i < N; i++) {
  const sh = await dc.shard(keys[rnd(keys.length)]);
  if (!sh || !sh.rows.length) continue;
  const row = DataClient.row(sh, sh.rows[rnd(sh.rows.length)]);
  tried++;
  const rc = await dc.findCase(row.case.split('(')[0]);
  if (rc.rows.some((r) => r.iso === row.iso && normCase(r.case) === normCase(row.case))) okCase++;
  // запит: два найдовші слова з поля учасників (імітація «прізвище імʼя»)
  const toks = [...new Set(tokenize(row.involved))].filter((t) => !stop.has(t) && !/^\d+$/.test(t)).sort((a, b) => b.length - a.length).slice(0, 2);
  if (toks.length < 2) continue;
  triedName++;
  const fresh = new DataClient(dc.fetchBytes);
  const b0 = bytes;
  const rn = await fresh.findName(toks.join(' '), { maxShards: 80 });
  const used = bytes - b0;
  sumBytes += used;
  maxBytes = Math.max(maxBytes, used);
  sumShards += rn.shards || 0;
  maxShards = Math.max(maxShards, rn.shards || 0);
  if (rn.truncated) trunc++;
  if (rn.rows.some((r) => r.iso === row.iso && normCase(r.case) === normCase(row.case))) okName++;
}
console.log(`Пошук за номером: ${okCase}/${tried}. Пошук за учасником: ${okName}/${triedName} (обрізано: ${trunc}).`);
console.log(`Запит за учасником: у середньому ${(sumShards / triedName).toFixed(1)} судів і ${(sumBytes / triedName / 1024).toFixed(0)} КБ, максимум ${maxShards} судів і ${(maxBytes / 1024).toFixed(0)} КБ.`);
if (okCase < tried || okName + trunc < triedName * 0.98) {
  console.error('Самоперевірка не пройдена.');
  process.exit(1);
}
