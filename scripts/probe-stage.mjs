#!/usr/bin/env node
// Службовий аналіз набору ДСА «Інформація щодо стану розгляду справ» (щоденні файли).
import { spawn, execFileSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { TsvParser } from './tsv.mjs';
const UA = { 'User-Agent': 'zasidannia-open-data-reader/1.0' };
const K = +(process.argv[2] || 3);
const pass = await (await fetch('https://dsa.court.gov.ua/open_data_json.php?json=532', { headers: UA })).json();
const files = pass['Файли'].map((o) => Object.entries(o)[0]).filter(([n]) => /\.zip$/.test(n));
const byDate = files.map(([n, u]) => { const m = /(\d\d)\.(\d\d)\.(\d{4})/.exec(n); return { n, u, d: `${m[3]}-${m[2]}-${m[1]}` }; }).sort((a, b) => (a.d < b.d ? -1 : 1));
console.log('файлів zip:', byDate.length, 'перший:', byDate[0].d, 'останній:', byDate[byDate.length - 1].d);
const sets = [];
for (const f of byDate.slice(-K)) {
  const t0 = Date.now();
  const r = await fetch(f.u, { headers: UA });
  await pipeline(Readable.fromWeb(r.body), createWriteStream('/tmp/s.zip'));
  const names = execFileSync('unzip', ['-Z1', '/tmp/s.zip']).toString().trim().split('\n');
  const keys = new Set();
  const years = {}; const stages = {}; let rows = 0; let recent = 0; let susp = 0; const suspYears = {}; let bad = 0; let reg26 = 0;
  const cut = new Date(Date.parse(f.d) - 7 * 864e5).toISOString().slice(0, 10);
  for (const name of names) {
    const child = spawn('unzip', ['-p', '/tmp/s.zip', name], { stdio: ['ignore', 'pipe', 'inherit'] });
    const p = new TsvParser((c) => {
      if (c.length !== 13) { bad++; return; }
      if (c[0] === 'court_name') return;
      rows++;
      keys.add(c[0] + '|' + c[1] + '|' + c[2]);
      const sd = c[7].length === 10 ? `${c[7].slice(6)}-${c[7].slice(3, 5)}-${c[7].slice(0, 2)}` : '';
      const y = sd.slice(0, 4) || 'немає';
      years[y] = (years[y] || 0) + 1;
      if (sd >= cut) recent++;
      stages[c[8]] = (stages[c[8]] || 0) + 1;
      if (/упинен/i.test(c[8])) { susp++; suspYears[y] = (suspYears[y] || 0) + 1; }
      if (c[3].endsWith('2026')) reg26++;
    });
    const dec = new TextDecoder();
    for await (const b of child.stdout) p.push(dec.decode(b, { stream: true }));
    p.end(); bad += p.bad;
  }
  console.log(`== ${f.d}: рядків ${rows}, унікальних ${keys.size}, зіпсованих ${bad}, зі стадією за останні 7 днів ${recent}, зареєстровано у 2026: ${reg26}, ${((Date.now() - t0) / 1000).toFixed(0)} с`);
  console.log('  роки стадій:', JSON.stringify(Object.fromEntries(Object.entries(years).sort().slice(-12))));
  console.log('  стадії:', JSON.stringify(Object.entries(stages).sort((a, b) => b[1] - a[1]).slice(0, 14)));
  console.log('  зупинено:', susp, JSON.stringify(suspYears));
  sets.push(keys);
}
for (let i = 1; i < sets.length; i++) {
  let common = 0;
  for (const k of sets[i]) if (sets[i - 1].has(k)) common++;
  console.log(`спільних записів між днем ${i} і ${i + 1}: ${common}`);
}
