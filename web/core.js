// Спільна логіка: нормалізація тексту, доступ до даних, пошук, злиття списків.
// Цей файл використовують і застосунок (браузер), і скрипт побудови даних (Node).

export const normText = (s) => (s || '').toLowerCase().replace(/[ʼ’'`]/g, '');
export const tokenize = (s) => normText(s).match(/[a-zа-яёіїєґ0-9]{3,}/g) || [];
export const normCase = (s) =>
  (s || '').toLowerCase().replace(/\s+/g, '').replace(/\p{Pd}/gu, '-').replace(/№/g, '');
export const shardKey = (c) => {
  const m = /^(\d{1,4})\//.exec(c || '');
  return m ? m[1] : 'x';
};
// Основний номер справи без суфіксів: «127/1/26-ц (2/127/5/26)» -> «127/1/26»
export const caseBase = (c) => {
  const n = normCase(c);
  const m = /^(\d{1,4}\/\d+\/\d{2})(?!\d)/.exec(n);
  return m ? m[1] : n;
};
export const bucketName = (tok) =>
  [...tok.slice(0, 3)].map((ch) => ch.charCodeAt(0).toString(16).padStart(4, '0')).join('');

export function matchInvolved(involved, qTokens) {
  const toks = tokenize(involved);
  return qTokens.every((q) => toks.some((t) => t.startsWith(q)));
}

// ---------- Час: дані суду записані за київським часом ----------
let TZ = 'Europe/Kyiv';
try {
  new Intl.DateTimeFormat('en-US', { timeZone: TZ });
} catch {
  TZ = 'Europe/Kiev';
}
const tzFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit',
});
function tzOffsetMin(ms) {
  const p = {};
  for (const x of tzFmt.formatToParts(new Date(ms))) p[x.type] = x.value;
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute);
  return Math.round((asUtc - ms) / 60000);
}
// 'YYYY-MM-DDTHH:MM' (київський час) -> Date
export function kyivDate(iso) {
  const [d, t] = iso.split('T');
  const [Y, M, D] = d.split('-').map(Number);
  const [h, m] = (t || '00:00').split(':').map(Number);
  const utc = Date.UTC(Y, M - 1, D, h, m);
  let res = utc - tzOffsetMin(utc) * 60000;
  const off2 = tzOffsetMin(res);
  res = utc - off2 * 60000;
  return new Date(res);
}
// Поточна дата у Києві: 'YYYY-MM-DD'
export function kyivToday(now = Date.now()) {
  const p = {};
  for (const x of tzFmt.formatToParts(new Date(now))) p[x.type] = x.value;
  return `${p.year}-${p.month}-${p.day}`;
}
export function kyivNowIso(now = Date.now()) {
  const p = {};
  for (const x of tzFmt.formatToParts(new Date(now))) p[x.type] = x.value;
  return `${p.year}-${p.month}-${p.day}T${String(+p.hour % 24).padStart(2, '0')}:${p.minute}`;
}

export function hash32(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
export const hearingUid = (r) => `${normCase(r.case)}|${r.iso}|${r.court}`;

// ---------- Доступ до даних ----------
async function gunzipMaybe(buf) {
  const u = new Uint8Array(buf);
  if (u.length > 2 && u[0] === 0x1f && u[1] === 0x8b) {
    const ds = new DecompressionStream('gzip');
    const stream = new Blob([u]).stream().pipeThrough(ds);
    return await new Response(stream).text();
  }
  return new TextDecoder('utf-8').decode(u);
}

export class DataClient {
  // fetchBytes(path, {fresh}) -> ArrayBuffer | null (null, якщо файлу немає)
  constructor(fetchBytes) {
    this.fetchBytes = fetchBytes;
    this._meta = null;
    this._shards = new Map();
    this._buckets = new Map();
  }
  async meta(force = false) {
    if (this._meta && !force) return this._meta;
    const buf = await this.fetchBytes('meta.json', { fresh: true });
    if (!buf) throw new Error('Дані суду ще не опубліковані');
    const meta = JSON.parse(await gunzipMaybe(buf));
    if (!this._meta || this._meta.built !== meta.built) {
      this._shards.clear();
      this._buckets.clear();
    }
    this._meta = meta;
    this._stop = new Set(meta.stop || []);
    return meta;
  }
  ver() {
    return this._meta ? encodeURIComponent(this._meta.built) : '';
  }
  async shard(key) {
    await this.meta();
    if (this._shards.has(key)) return this._shards.get(key);
    const p = (async () => {
      if (!this._meta.shards[key]) return null;
      const buf = await this.fetchBytes(`c/${key}.json.gz?v=${this.ver()}`, {});
      if (!buf) return null;
      return JSON.parse(await gunzipMaybe(buf));
    })();
    this._shards.set(key, p);
    try {
      return await p;
    } catch (e) {
      this._shards.delete(key);
      throw e;
    }
  }
  static row(sh, r) {
    return {
      iso: r[0], judges: sh.judges[r[1]] || '', case: r[2], court: sh.courts[r[3]] || '',
      room: r[4] || '', involved: r[5] || '', desc: r[6] || '',
    };
  }
  async bucket(tok) {
    await this.meta();
    const name = bucketName(tok);
    if (this._buckets.has(name)) return this._buckets.get(name);
    const p = (async () => {
      const buf = await this.fetchBytes(`n/${name}.txt.gz?v=${this.ver()}`, {});
      const map = new Map();
      if (!buf) return map;
      const text = await gunzipMaybe(buf);
      for (const line of text.split('\n')) {
        const t = line.indexOf('\t');
        if (t > 0) map.set(line.slice(0, t), line.slice(t + 1));
      }
      return map;
    })();
    this._buckets.set(name, p);
    try {
      return await p;
    } catch (e) {
      this._buckets.delete(name);
      throw e;
    }
  }
  // ---- Судові рішення (ЄДРСР) ----
  async decMeta(force = false) {
    if (this._dec !== undefined && !force) return this._dec;
    try {
      const buf = await this.fetchBytes('dec.json', { fresh: true });
      this._dec = buf ? JSON.parse(await gunzipMaybe(buf)) : null;
    } catch {
      this._dec = null;
    }
    this._decFiles = new Map();
    return this._dec;
  }
  async decisions(caseNo) {
    const dec = await this.decMeta();
    if (!dec) return null;
    const base = caseBase(caseNo);
    if (!dec.n) return [];
    const name = `d/${hash32(base) % dec.n}.json.gz?v=${encodeURIComponent(dec.built)}`;
    let p = this._decFiles.get(name);
    if (!p) {
      p = (async () => {
        const buf = await this.fetchBytes(name, {});
        return buf ? JSON.parse(await gunzipMaybe(buf)) : null;
      })();
      this._decFiles.set(name, p);
      p.catch(() => this._decFiles.delete(name));
    }
    const f = await p;
    if (!f) return [];
    const out = [];
    for (const r of f.rows) {
      if (caseBase(r[1]) !== base) continue;
      out.push({
        id: r[0], case: r[1], adj: r[2], recv: r[3], form: dec.forms[r[4]] || 'Документ',
        kind: dec.kinds[r[5]] || '', court: f.courts[r[6]] || '', judge: f.judges[r[7]] || '', pub: r[8] !== 0,
      });
    }
    return out;
  }
  // Пошук за номером справи (повний номер або його початок з кодом суду)
  async findCase(q) {
    const n = normCase(q);
    if (!/^[0-9a-zа-яіїєґ-]+\/.+/.test(n)) return { rows: [], error: 'format' };
    const sh = await this.shard(shardKey(n));
    if (!sh) return { rows: [] };
    const complete = n.split('/').length >= 3 && /\/\d{2}/.test(n.slice(n.lastIndexOf('/')));
    const rows = [];
    for (const r of sh.rows) {
      const c = normCase(r[2]);
      if (c === n || (!complete && c.startsWith(n)) || c.startsWith(n + '-') ||
        c.startsWith(n + '(') || c.includes('(' + n + ')')) {
        rows.push(DataClient.row(sh, r));
      }
    }
    return { rows };
  }
  // Пошук за учасником або представником
  async findName(query, opts = {}) {
    const meta = await this.meta();
    const maxShards = opts.maxShards || 25;
    const qAll = [...new Set(tokenize(query))];
    const usable = qAll.filter((t) => !this._stop.has(t)).sort((a, b) => b.length - a.length);
    if (!qAll.length) return { rows: [], error: 'short' };
    if (!usable.length) return { rows: [], error: 'common' };
    const cf = normText(opts.court || '').trim();
    let cand = null; // Map key -> Set(idx)
    let used = 0;
    for (const tok of usable) {
      if (used >= 4) break;
      const b = await this.bucket(tok);
      const cur = new Map();
      for (const [word, post] of b) {
        if (!word.startsWith(tok)) continue;
        for (const grp of post.split(';')) {
          const c = grp.indexOf(':');
          const key = grp.slice(0, c);
          if (cand && !cand.has(key)) continue;
          let set = cur.get(key);
          if (!set) cur.set(key, (set = new Set()));
          for (const i of grp.slice(c + 1).split(',')) set.add(+i);
        }
      }
      if (cand) {
        for (const [key, set] of cur) {
          const prev = cand.get(key);
          for (const i of set) if (!prev.has(i)) set.delete(i);
          if (!set.size) cur.delete(key);
        }
      }
      cand = cur;
      used++;
      if (!cand.size) break;
      if (cand.size <= 12 && used >= Math.min(2, usable.length)) break;
    }
    let keys = [...(cand || new Map()).keys()];
    if (cf) {
      keys = keys.filter((k) => normText((meta.shards[k] || [0, ''])[1]).includes(cf));
    }
    keys.sort((a, b) => cand.get(b).size - cand.get(a).size);
    const totalShards = keys.length;
    let totalRows = 0;
    for (const k of keys) totalRows += cand.get(k).size;
    const truncated = keys.length > maxShards;
    if (truncated) keys = keys.slice(0, maxShards);
    const rows = [];
    let done = 0;
    const work = async (key) => {
      const sh = await this.shard(key);
      done++;
      if (opts.onProgress) opts.onProgress(done, keys.length);
      if (!sh) return;
      for (const i of cand.get(key)) {
        const r = sh.rows[i];
        if (r && matchInvolved(r[5], qAll)) rows.push(DataClient.row(sh, r));
      }
    };
    const queue = keys.slice();
    await Promise.all(
      Array.from({ length: Math.min(6, queue.length) }, async () => {
        while (queue.length) await work(queue.shift());
      }),
    );
    rows.sort((a, b) => (a.iso < b.iso ? -1 : a.iso > b.iso ? 1 : 0));
    return { rows, truncated, shards: keys.length, totalShards, totalRows };
  }
}

// ---------- Список спостереження: злиття для синхронізації ----------
// Елемент: {id, t:'case'|'kw', number|query, court, title, note, u (мс зміни), del}
export function mergeItems(a, b) {
  const map = new Map();
  for (const it of [...(a || []), ...(b || [])]) {
    if (!it || !it.id) continue;
    const prev = map.get(it.id);
    if (!prev || (it.u || 0) > (prev.u || 0)) map.set(it.id, it);
  }
  const limit = Date.now() - 90 * 864e5;
  return [...map.values()]
    .filter((it) => !(it.del && (it.u || 0) < limit))
    .sort((x, y) => (x.c || 0) - (y.c || 0) || (x.id < y.id ? -1 : 1));
}
export const sameItems = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// Стан прочитання рішень: ra = дата «усе прочитано до», read = {id рішення: дата надходження}
export function mergeRead(a, b) {
  const ra = [a && a.ra, b && b.ra].filter(Boolean).sort().pop() || '';
  const read = {};
  const old = new Date(Date.now() - 150 * 864e5).toISOString().slice(0, 10);
  for (const src of [a && a.read, b && b.read]) {
    for (const [id, d] of Object.entries(src || {})) {
      if (d >= old && !(ra && d < ra)) read[id] = d;
    }
  }
  const sorted = {};
  for (const k of Object.keys(read).sort()) sorted[k] = read[k];
  return { ra, read: sorted };
}
export const reviewUrl = (id) => `https://reyestr.court.gov.ua/Review/${id}`;

export function utf8ToB64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}
export function b64ToUtf8(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

// ---------- Календар (.ics) з нагадуваннями за добу і за годину ----------
export function buildIcs(hearings, titleOf) {
  const z = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const esc = (s) => (s || '').replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/([,;])/g, '\\$1');
  const fold = (line) => {
    const out = [];
    let cur = '';
    let bytes = 0;
    for (const ch of line) {
      const n = new TextEncoder().encode(ch).length;
      if (bytes + n > 73) {
        out.push(cur);
        cur = ' ';
        bytes = 1;
      }
      cur += ch;
      bytes += n;
    }
    out.push(cur);
    return out.join('\r\n');
  };
  const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//zasidannia//UA', 'CALSCALE:GREGORIAN',
    'X-WR-CALNAME:Судові засідання'];
  const stamp = z(new Date());
  for (const h of hearings) {
    const start = kyivDate(h.iso);
    const end = new Date(start.getTime() + 60 * 60000);
    const uid = hash32(hearingUid(h)).toString(16) + '-' + h.iso.replace(/\D/g, '');
    L.push('BEGIN:VEVENT', `UID:${uid}@zasidannia`, `DTSTAMP:${stamp}`,
      `DTSTART:${z(start)}`, `DTEND:${z(end)}`,
      fold(`SUMMARY:${esc(`Суд: ${titleOf ? titleOf(h) : h.case}`)}`),
      fold(`LOCATION:${esc(h.court + (h.room ? `, зал ${h.room}` : ''))}`),
      fold(`DESCRIPTION:${esc(`Справа № ${h.case}\n${h.judges}\n${h.involved}\n${h.desc}`)}`),
      'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Засідання завтра', 'TRIGGER:-P1D', 'END:VALARM',
      'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Засідання за годину', 'TRIGGER:-PT1H', 'END:VALARM',
      'END:VEVENT');
  }
  L.push('END:VCALENDAR');
  return L.join('\r\n') + '\r\n';
}

// ---------- Імпорт: номери справ з тексту або з файлу (xlsx, docx, csv, txt) ----------
export function extractCaseNumbers(text) {
  const out = new Map();
  const re = /(?<![\d/])(\d{1,4})\s*\/\s*(\d{1,6})\s*\/\s*(\d{2})(?:\s*-\s*([а-яіїєґa-z]))?(?![\d/])/gi;
  let m;
  while ((m = re.exec(text || ''))) {
    const num = `${m[1]}/${m[2]}/${m[3]}${m[4] ? '-' + m[4].toLowerCase() : ''}`;
    if (!out.has(num)) out.set(num, true);
  }
  return [...out.keys()];
}
async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
const xmlToText = (xml) =>
  xml.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
// Повертає текст файлу. Архіви zip (xlsx, docx, ods) розпаковує і читає їхні xml.
export async function fileToText(buf) {
  const u = new Uint8Array(buf);
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  if (u.length > 30 && u[0] === 0x50 && u[1] === 0x4b) {
    let eocd = -1;
    for (let i = u.length - 22; i >= Math.max(0, u.length - 70000); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error('Файл пошкоджений');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const parts = [];
    const dec = new TextDecoder('utf-8');
    for (let n = 0; n < count && dv.getUint32(p, true) === 0x02014b50; n++) {
      const method = dv.getUint16(p + 10, true);
      const csize = dv.getUint32(p + 20, true);
      const nl = dv.getUint16(p + 28, true);
      const el = dv.getUint16(p + 30, true);
      const cl = dv.getUint16(p + 32, true);
      const lho = dv.getUint32(p + 42, true);
      const name = dec.decode(u.subarray(p + 46, p + 46 + nl));
      p += 46 + nl + el + cl;
      if (!/\.xml$/i.test(name) || /styles|theme|rels|\[Content_Types\]/i.test(name)) continue;
      const start = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
      const data = u.subarray(start, start + csize);
      const raw = method === 8 ? await inflateRaw(data) : method === 0 ? data : null;
      if (raw) parts.push(xmlToText(dec.decode(raw)));
    }
    return parts.join('\n');
  }
  let text = new TextDecoder('utf-8').decode(u);
  if ((text.match(/�/g) || []).length > 5) {
    try {
      text = new TextDecoder('windows-1251').decode(u);
    } catch { /* залишаємо utf-8 */ }
  }
  return /<\w+[^>]*>/.test(text.slice(0, 2000)) ? xmlToText(text) : text;
}
