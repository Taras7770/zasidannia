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
const ids = process.argv[4];
if (ids) {
  for (const id of ids.split('|')) {
    const j = await (await fetch(`https://data.gov.ua/api/3/action/package_show?id=${id}`, { headers: UA })).json();
    const p = j.result;
    console.log(`== ${p.title} | ${p.metadata_modified} | ресурсів: ${p.resources.length}`);
    console.log((p.notes || '').slice(0, 1500));
    for (const r of p.resources) console.log(`    ${r.name} | ${r.format} | ${r.size} | ${r.last_modified} | ${r.url} | ${(r.description || '').slice(0, 300)}`);
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
    } else if (/html/.test(r.headers.get('content-type') || '')) {
      const cs = /1251/.test(r.headers.get('content-type') || '') ? 'windows-1251' : 'utf-8';
      const html = new TextDecoder(cs).decode(buf);
      if (process.env.DUMP) {
        const body = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ' ');
        for (const m of body.matchAll(/href=["']([^"']+)["'][^>]*>([\s\S]{0,300}?)<\/a>/g)) {
          const text = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
          if (/\d{3}|json|csv|zip/.test(m[1]) && text) console.log(`  ${m[1]} | ${text.slice(0, 200)}`);
        }
        const txt = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
        const i = txt.search(/розгляду|реєстр/i);
        console.log('ТЕКСТ:', txt.slice(Math.max(0, i - 500), i + 5000));
      }
      const seen = new Set();
      for (const m of html.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
        const text = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        if (!/oddata|open_data|\.zip|\.csv|\.json|data\.gov/i.test(m[1]) || seen.has(m[1])) continue;
        seen.add(m[1]);
        console.log(`  ${m[1]} | ${text.slice(0, 160)}`);
      }
      console.log('посилань:', seen.size, 'довжина сторінки:', html.length);
    } else if (/open_data_json/.test(u)) {
      let t = buf.toString('utf8');
      if (t.includes('\uFFFD')) t = new TextDecoder('windows-1251').decode(buf);
      try {
        const obj = JSON.parse(t);
        for (const [k, v] of Object.entries(obj)) {
          const sv = typeof v === 'string' ? v : JSON.stringify(v);
          if (sv.length < 400) console.log(`  ${k}: ${sv}`);
          else {
            const parts = Array.isArray(v) ? v.map((x) => JSON.stringify(x)) : sv.split(',');
            console.log(`  ${k}: [${parts.length} частин] перші: ${parts.slice(0, 3).join(' ; ').slice(0, 700)} ... останні: ${parts.slice(-4).join(' ; ').slice(0, 900)}`);
          }
        }
      } catch (e) {
        console.log('не JSON', e.message);
      }
      const title = (/"(?:title|name|nazva)[^"]*"\s*:\s*"([^"]{3,200})"/i.exec(t) || [])[1];
      const links = [...new Set(t.match(/https?:[^"\s]+?\.(?:zip|csv|json|xml)/gi) || [])].map((x) => x.replace(/\\\//g, '/'));
      console.log(`  JSON ${u.split('=').pop()} | ${title} | ${links.slice(-3).join(' , ')} | ${t.slice(0, 260).replace(/\s+/g, ' ')}`);
    } else {
      console.log(buf.subarray(0, 3000).toString('utf8'));
    }
  }
}
