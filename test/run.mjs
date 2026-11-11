import { readFileSync, existsSync } from 'node:fs';
import assert from 'node:assert/strict';
import { extractCaseNumbers, fileToText } from '../web/core.js';
import { DataClient, kyivDate, normCase, mergeItems, buildIcs, utf8ToB64, b64ToUtf8, tokenize } from '../web/core.js';
import { TsvParser } from '../scripts/tsv.mjs';
const dir = process.argv[2];
// 1. розбір малими шматками дає той самий результат
const text = readFileSync(new URL('./sample.csv', import.meta.url), 'utf8');
const all = []; const p1 = new TsvParser((f) => all.push(f)); p1.push(text); p1.end();
for (const size of [1, 2, 3, 7, 50]) {
  const got = []; const p = new TsvParser((f) => got.push(f));
  for (let i = 0; i < text.length; i += size) p.push(text.slice(i, i + size)); p.end();
  assert.deepEqual(got, all, 'chunk ' + size);
}
assert.equal(all.length, 11); assert.equal(all[2][5].includes('\r\n'), true); assert.equal(all[1][5].includes('"УКР КРЕДИТ ФІНАНС"'), true);
// 2. клієнт даних
const dc = new DataClient(async (path) => { const f = dir + '/' + path.split('?')[0]; if (!existsSync(f)) return null; const b = readFileSync(f); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); });
const meta = await dc.meta(); console.log('meta', meta.rows, meta.from, meta.stop, Object.keys(meta.shards));
assert.equal(meta.rows, 7); // 1 старий рядок відкинуто, 1 дубль прибрано
let r = await dc.findCase('127/33448/26'); assert.equal(r.rows.length, 1); assert.equal(r.rows[0].room, '№5');
r = await dc.findCase(' 127 / 23233 / 26 '); assert.equal(r.rows.length, 1); assert.equal(r.rows[0].court, 'Вінницький апеляційний суд');
r = await dc.findCase('127/2'); assert.equal(r.rows.length, 1);
r = await dc.findCase('2-1234/09'); assert.equal(r.rows.length, 1);
r = await dc.findCase('999/1/26'); assert.equal(r.rows.length, 0);
r = await dc.findCase('абв'); assert.equal(r.error, 'format');
r = await dc.findName('Юрченко Тарас Петрович'); assert.deepEqual(r.rows.map(x => x.case), ['127/33448/26', '127/23233/26']);
r = await dc.findName('юрченко'); assert.equal(r.rows.length, 4);
r = await dc.findName('Юрченко', { court: 'господарськ' }); assert.equal(r.rows.length, 1);
r = await dc.findName("Д'яченко Мар'яна"); assert.equal(r.rows.length, 1);
r = await dc.findName('рогова вікторія'); assert.equal(r.rows.length, 1);
r = await dc.findName('надзвичайних ситуацій'); assert.equal(r.rows.length, 1); assert.ok(!r.rows[0].involved.includes('\n'));
r = await dc.findName('аб'); assert.equal(r.error, 'short');
r = await dc.findName('неіснуючий'); assert.equal(r.rows.length, 0);
// 3. час
assert.equal(kyivDate('2026-11-20T09:30').toISOString(), '2026-11-20T07:30:00.000Z');
assert.equal(kyivDate('2026-07-01T09:30').toISOString(), '2026-07-01T06:30:00.000Z');
assert.equal(normCase('127/33448/26 '), '127/33448/26');
// 4. злиття
const m = mergeItems([{ id: 'a', u: 1, c: 1 }, { id: 'b', u: Date.now(), c: 2, del: true }], [{ id: 'a', u: 3, c: 1, title: 'x' }, { id: 'b', u: 2, c: 2 }]);
assert.equal(m[0].title, 'x'); assert.equal(m[1].del, true);
assert.equal(b64ToUtf8(utf8ToB64('Справа № 1 ї')), 'Справа № 1 ї');
const ics = buildIcs((await dc.findCase('127/33448/26')).rows); assert.ok(ics.includes('TRIGGER:-P1D') && ics.includes('TRIGGER:-PT1H') && ics.includes('DTSTART:20261120T073000Z'));
for (const line of ics.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, 'fold');
assert.deepEqual(extractCaseNumbers('Справа № 127/33448/26, а також 902 / 44 / 26 і 127/33448/26; 755/1/26-к; дата 11/11/2026 та 1/2/3/4'), ['127/33448/26', '902/44/26', '755/1/26-к']);
{
  const b = readFileSync(new URL('./sample.xlsx', import.meta.url));
  const t = await fileToText(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  assert.deepEqual(extractCaseNumbers(t).sort(), ['127/33448/26', '129/56/25', '902/44/26']);
}
assert.deepEqual(extractCaseNumbers(await fileToText(new TextEncoder().encode('a;127/1/26\nb;128/2/26').buffer)), ['127/1/26', '128/2/26']);
// 6. судові рішення
{
  const { caseBase, mergeRead, reviewUrl } = await import('../web/core.js');
  assert.equal(caseBase('127/33448/26-ц (2/127/5/26)'), '127/33448/26'); assert.equal(caseBase('2-1234/09'), '2-1234/09');
  const dm = await dc.decMeta(); assert.equal(dm.rows, 6); assert.equal(dm.forms[5], 'Ухвала');
  const d = await dc.decisions('127/33448/26'); assert.deepEqual(d.map((x) => x.id), [140000002, 140000001, 139000003]);
  assert.equal(d[0].form, 'Постанова'); assert.equal(d[0].adj, '2026-11-09'); assert.equal(d[0].recv, '2026-11-10'); assert.equal(d[0].court, 'Вінницький міський суд Вінницької області'); assert.equal(d[2].pub, false);
  assert.equal((await dc.decisions('902/44/26')).length, 1); assert.equal((await dc.decisions('999/1/26')).length, 0);
  assert.equal(reviewUrl(5), 'https://reyestr.court.gov.ua/Review/5');
  const today = new Date().toISOString().slice(0, 10);
  const mr = mergeRead({ ra: '2026-11-01', read: { 1: today, 2: '2026-10-01' } }, { ra: '2026-10-15', read: { 3: today } });
  assert.equal(mr.ra, '2026-11-01'); assert.deepEqual(Object.keys(mr.read), ['1', '3']);
}
console.log('OK');
