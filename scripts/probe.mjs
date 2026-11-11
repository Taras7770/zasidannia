#!/usr/bin/env node
// Службовий скрипт: показує набори даних data.gov.ua за запитом і початок файлу.
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const UA = { 'User-Agent': 'zasidannia-open-data-reader/1.0' };
const [q, url] = process.argv.slice(2);
if (q) {
  for (const query of q.split('|')) {
    const j = await (await fetch(`https://data.gov.ua/api/3/action/package_search?rows=40&q=${encodeURIComponent(query)}`, { headers: UA })).json();
    console.log(`== ${query}: ${j.result.count}`);
    for (const p of j.result.results) {
      console.log(`- ${p.id} | ${p.title} | ${p.organization && p.organization.title} | ${p.metadata_modified} | ${p.accrualPeriodicity || p.update_frequency || ''}`);
      for (const r of p.resources.slice(-6)) console.log(`    ${r.name} | ${r.format} | ${r.size} | ${r.last_modified} | ${r.url}`);
    }
  }
}
if (url) {
  for (const u of url.split('|')) {
    console.log('== файл', u);
    const r = await fetch(u, { headers: UA });
    const buf = Buffer.from(await r.arrayBuffer());
    console.log('розмір', buf.length, r.headers.get('content-type'));
    if (buf[0] === 0x50 && buf[1] === 0x4b) {
      writeFileSync('/tmp/probe.zip', buf);
      console.log(execSync('unzip -l /tmp/probe.zip').toString());
      for (const name of execSync('unzip -Z1 /tmp/probe.zip').toString().trim().split('\n')) {
        console.log('--', name);
        console.log(execSync(`unzip -p /tmp/probe.zip "${name}" | head -c 2500`, { maxBuffer: 1e7 }).toString());
        console.log(execSync(`unzip -p /tmp/probe.zip "${name}" | wc -l`).toString());
      }
    } else {
      console.log(buf.subarray(0, 3000).toString('utf8'));
    }
  }
}
