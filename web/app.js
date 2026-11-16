import {
  DataClient, normCase, normText, tokenize, kyivDate, kyivToday, kyivNowIso, hearingUid, hash32,
  mergeItems, sameItems, utf8ToB64, b64ToUtf8, buildIcs, extractCaseNumbers, fileToText,
  caseBase, mergeRead, reviewUrl, mergeMarks, docStatus, docDue,
} from './core.js';

// ---------- Сховище ----------
const LS = {
  get(k, d) {
    try {
      const v = localStorage.getItem(k);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch (e) {
      console.warn('Сховище переповнене', e);
    }
  },
};
const S = {
  items: LS.get('ct.items', []),
  hearings: LS.get('ct.h', {}),
  seen: new Set(LS.get('ct.seen', [])),
  fresh: new Set(LS.get('ct.new', [])),
  init: new Set(LS.get('ct.init', [])),
  set: Object.assign({ repo: '', token: '', r1d: true, r1h: true, rdoc: true, sort: 'next' }, LS.get('ct.set', {})),
  dec: LS.get('ct.dec', {}),
  rd: Object.assign({ ra: '', read: {} }, LS.get('ct.rd', {})),
  decMeta: LS.get('ct.decmeta', null),
  cfilter: 'live',
  afilter: 'all',
  mh: LS.get('ct.mh', []),
  esud: LS.get('ct.esud', null),
  aw: LS.get('ct.aw', {}),
  decA: LS.get('ct.decA', {}),
  busyData: LS.get('ct.busy', null),
  es: Object.assign({ b: '', seen: {} }, LS.get('ct.es', {})),
  cards: LS.get('ct.cards', null),
  docs: LS.get('ct.docs', null),
  dm: LS.get('ct.dm', {}),
  dfilter: 'open',
  meta: LS.get('ct.meta', null),
  view: 'agenda',
  busy: false,
  err: '',
  sync: '',
  notif: '',
  search: { mode: 'case', q: '', court: '', res: null, busy: false, prog: '' },
};
const save = () => {
  LS.set('ct.items', S.items);
  LS.set('ct.h', S.hearings);
  LS.set('ct.seen', [...S.seen]);
  LS.set('ct.new', [...S.fresh]);
  LS.set('ct.init', [...S.init]);
  LS.set('ct.set', S.set);
  LS.set('ct.dec', S.dec);
  LS.set('ct.rd', S.rd);
  LS.set('ct.mh', S.mh);
  LS.set('ct.es', S.es);
  LS.set('ct.dm', S.dm);
  LS.set('ct.aw', S.aw);
};
const active = () => S.items.filter((i) => !i.del);
// Справи поза архівом: лише вони оновлюються і дають нагадування
const live = () => S.items.filter((i) => !i.del && !i.arch);

// ---------- Дані ----------
const DATA_BASE = new URL('data/', location.href).href;
const dc = new DataClient(async (path, o) => {
  const r = await fetch(DATA_BASE + path, { cache: o && o.fresh ? 'no-store' : 'default' });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`Помилка завантаження даних (${r.status})`);
  return await r.arrayBuffer();
});

// ---------- Допоміжні ----------
const $ = (s, el = document) => el.querySelector(s);
const h = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MON = ['січня', 'лютого', 'березня', 'квітня', 'травня', 'червня', 'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня'];
const WD = ['неділя', 'понеділок', 'вівторок', 'середа', 'четвер', 'пʼятниця', 'субота'];
const dayDiff = (isoDate, today = kyivToday()) =>
  Math.round((Date.parse(isoDate + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 864e5);
function dayLabel(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const wd = WD[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  const n = dayDiff(isoDate);
  const rel = n === 0 ? 'сьогодні' : n === 1 ? 'завтра' : n === 2 ? 'післязавтра' : n > 0 ? `через ${n} дн.` : `${-n} дн. тому`;
  const yr = y !== +kyivToday().slice(0, 4) ? ` ${y}` : '';
  return { main: `${d} ${MON[m - 1]}${yr}, ${wd}`, rel };
}
const fmtD = (d) => (d && d.length >= 10 ? `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}` : '');
const dateMinus = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') - n * 864e5).toISOString().slice(0, 10);
const fmtDT = (iso) => {
  const [d, t] = iso.split('T');
  const [y, m, dd] = d.split('-');
  return `${dd}.${m}.${y} о ${t}`;
};
function shortParties(inv) {
  const names = [];
  for (const seg of (inv || '').split(/,\s+(?=[^,:]{2,60}:\s)/)) {
    const i = seg.indexOf(':');
    if (i < 0 && /:\s/.test(inv)) continue; // уривок назви ролі, наприклад «Особа, яка притягається…»
    const role = i > 0 ? seg.slice(0, i).toLowerCase() : '';
    if (/представник|захисник|адвокат|прокурор/.test(role)) continue;
    const name = (i > 0 ? seg.slice(i + 1) : seg).trim();
    if (name) names.push(name.replace(/ТОВАРИСТВО З ОБМЕЖЕНОЮ ВІДПОВІДАЛЬНІСТЮ/i, 'ТОВ'));
    if (names.length === 2) break;
  }
  const s = names.join(' / ');
  return s.length > 90 ? s.slice(0, 88) + '…' : s;
}
let toastT;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('on'), 3200);
}
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// ---------- Список спостереження ----------
function itemTitle(it) {
  if (it.title) return it.title;
  if (it.t === 'kw') return it.query;
  const rows = S.hearings[it.id] || [];
  const withInv = rows.filter((r) => r.involved);
  const cards = cardsOf(it).filter((c) => c.parts);
  return (withInv.length && shortParties(withInv[withInv.length - 1].involved)) || (cards.length && shortParties(cards[0].parts)) || `Справа № ${it.number}`;
}
function addItem(data) {
  const now = Date.now();
  if (data.t === 'case') {
    const n = normCase(data.number);
    const ex = active().find((i) => i.t === 'case' && normCase(i.number) === n);
    if (ex) {
      if (ex.arch) updateItem(ex.id, { arch: false });
      return ex;
    }
  } else {
    const q = tokenize(data.query).join(' ');
    const ex = active().find((i) => i.t === 'kw' && tokenize(i.query).join(' ') === q && normText(i.court || '') === normText(data.court || ''));
    if (ex) return ex;
  }
  const it = { id: uid(), c: now, u: now, rb: dateMinus(kyivToday(), 7), ...data };
  S.items.push(it);
  save();
  syncSoon();
  return it;
}
function updateItem(id, patch) {
  const it = S.items.find((i) => i.id === id);
  if (!it) return;
  Object.assign(it, patch, { u: Date.now() });
  save();
  syncSoon();
}
function removeItem(id) {
  updateItem(id, { del: true });
  delete S.hearings[id];
  save();
}

// ---------- Синхронізація через приватний репозиторій GitHub ----------
const syncOn = () => /^[\w.-]+\/[\w.-]+$/.test(S.set.repo) && S.set.token.length > 20;
const ghHeaders = () => ({
  Authorization: `Bearer ${S.set.token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
});
const ghUrl = (name) => `https://api.github.com/repos/${S.set.repo}/contents/${name}`;
async function ghGetJson(name) {
  const r = await fetch(ghUrl(name) + `?t=${Date.now()}`, { headers: ghHeaders(), cache: 'no-store' });
  if (r.status === 404) return { data: null, sha: null };
  if (r.status === 401 || r.status === 403) throw new Error('GitHub відхилив ключ доступу');
  if (!r.ok) throw new Error(`GitHub: помилка ${r.status}`);
  const j = await r.json();
  let data = null;
  try {
    data = JSON.parse(b64ToUtf8(j.content || ''));
  } catch { /* порожній файл */ }
  return { data, sha: j.sha };
}
async function ghPutJson(name, obj, sha, message) {
  const body = { message, content: utf8ToB64(JSON.stringify(obj, null, 1)) };
  if (sha) body.sha = sha;
  const r = await fetch(ghUrl(name), { method: 'PUT', headers: ghHeaders(), body: JSON.stringify(body) });
  if (r.status === 409 || r.status === 422) return false;
  if (!r.ok) throw new Error(`GitHub: не вдалося зберегти (${r.status})`);
  return true;
}
// Список справ лежить у watch.json, позначки прочитання у state.json.
// Запис у watch.json запускає в репозиторії завдання, яке оновлює cards.json (стан розгляду справ).
let syncBusy = null;
async function syncNow() {
  if (!syncOn()) {
    S.sync = '';
    return false;
  }
  if (syncBusy) return syncBusy;
  syncBusy = (async () => {
    try {
      for (let i = 0; i < 3; i++) {
        const w = await ghGetJson('watch.json');
        const st = await ghGetJson('state.json');
        const wd = w.data || {};
        const remoteItems = Array.isArray(wd.items) ? wd.items : [];
        const legacy = 'read' in wd || 'ra' in wd;
        const remoteRd = { ra: (st.data && st.data.ra) || '', read: (st.data && st.data.read) || {} };
        const merged = mergeItems(S.items, remoteItems);
        const rd = mergeRead(mergeRead(S.rd, remoteRd), legacy ? { ra: wd.ra || '', read: wd.read || {} } : null);
        const remoteMh = (st.data && Array.isArray(st.data.mh) && st.data.mh) || [];
        const mh = mergeItems(S.mh, remoteMh);
        const remoteEs = { b: (st.data && st.data.es && st.data.es.b) || '', seen: (st.data && st.data.es && st.data.es.seen) || {} };
        const es = mergeEs(S.es, remoteEs);
        const remoteDm = mergeMarks((st.data && st.data.dm) || {}, null);
        const dm = mergeMarks(S.dm, remoteDm);
        const remoteAw = (st.data && st.data.aw) || {};
        const aw = mergeMax(S.aw, remoteAw);
        S.aw = aw;
        S.dm = dm;
        S.es = es;
        S.items = merged;
        S.rd = rd;
        S.mh = mh;
        save();
        const ok1 = (sameItems(merged, remoteItems) && !legacy) || (await ghPutJson('watch.json', { v: 1, items: merged }, w.sha, 'Оновлення списку справ'));
        const ok2 = (sameItems(rd, remoteRd) && sameItems(mh, remoteMh) && sameItems(es, remoteEs) && sameItems(dm, (st.data && st.data.dm) || {}) && sameItems(aw, remoteAw)) || (await ghPutJson('state.json', { v: 1, ra: rd.ra, read: rd.read, mh, es, dm, aw }, st.sha, 'Позначки прочитання і ручні засідання'));
        if (ok1 && ok2) break;
      }
      S.sync = 'ok:' + Date.now();
      return true;
    } catch (e) {
      S.sync = 'err:' + e.message;
      return false;
    } finally {
      syncBusy = null;
    }
  })();
  return syncBusy;
}
// Читає файл даних із приватного репозиторію. Якщо файл не змінився, сервер відповідає «304»
// без вмісту: застосунок бере збережену копію і не витрачає трафік.
async function ghRaw(name, have) {
  const et = LS.get('ct.et', {});
  const url = ghUrl(name) + `?t=${Date.now()}`;
  const base = { ...ghHeaders(), Accept: 'application/vnd.github.raw+json' };
  let r;
  try {
    r = await fetch(url, { headers: have && et[name] ? { ...base, 'If-None-Match': et[name] } : base, cache: 'no-store' });
  } catch {
    r = await fetch(url, { headers: base, cache: 'no-store' });
  }
  if (r.status === 304) return { same: true };
  if (!r.ok) return { miss: true };
  const data = await r.json();
  const tag = r.headers.get('etag');
  if (tag) {
    et[name] = tag;
    LS.set('ct.et', et);
  }
  return { data };
}

// ---------- Зайнятість: пари та інші події (busy.json у приватному репозиторії) ----------
// Подія: {id, iso, end ('ГГ:ХХ'), title, place, kind}. Події не належать до справ.
async function loadBusy() {
  if (!syncOn()) return;
  try {
    const j = (await ghRaw('busy.json', !!S.busyData)).data;
    if (j && Array.isArray(j.events)) {
      S.busyData = { at: j.at, events: j.events };
      LS.set('ct.busy', S.busyData);
    }
  } catch { /* спробуємо під час наступного оновлення */ }
}
function busyList(includePastHours = 3) {
  if (!S.busyData) return [];
  const from = kyivNowIso(Date.now() - includePastHours * 36e5);
  return S.busyData.events.filter((e) => e && e.iso && e.iso >= from)
    .map((e) => ({ ...e, busy: true, mine: true, uid: `b|${e.id || e.iso}` }))
    .sort((a, b) => (a.iso < b.iso ? -1 : a.iso > b.iso ? 1 : 0));
}
const minOf = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
function busyCard(x) {
  return `<div class="card busy"><div class="row"><div class="time">${h(x.iso.slice(11))}${x.end ? `<div class="m">${h(x.end)}</div>` : ''}</div>
    <div class="grow"><div class="t">${h(x.title || 'Подія')}</div>
    ${x.place ? `<div class="m">${h(x.place)}</div>` : ''}
    <div style="margin-top:4px"><span class="tag busy">${h(x.kind || 'пара')}</span>${x.clash ? '<span class="tag new">накладка із засіданням</span>' : ''}</div></div></div></div>`;
}

// ---------- Загальний стан справи: усі провадження разом ----------
const mergeMax = (a, b) => {
  const out = {};
  for (const src of [a, b]) for (const [k, d] of Object.entries(src || {})) if (!out[k] || d > out[k]) out[k] = d;
  return Object.fromEntries(Object.keys(out).sort().map((k) => [k, out[k]]));
};
const instOf = (court) => (/касаційн|верховн|велика палата/i.test(court || '') ? 3 : /апеляційн/i.test(court || '') ? 2 : 1);
const INST_NAME = ['', 'перша інстанція', 'апеляція', 'касація'];
function recKind(c) {
  const st = (c.stage || '').toLowerCase();
  const r = (c.result || '').toLowerCase();
  if (/подано апеляційну|направлено до апеляційного|подано касаційну|направлено до суду касаційної/.test(st)) return 'filed';
  if (/набрало законної сили/.test(st) || /^виконання рішення/.test(st)) return 'final';
  if (/^(розглянуто|повернуто|відмовлено|залишено без розгляду|закрито|направлено за підсудністю)/.test(st)) return 'done';
  if (st) return 'active';
  if (/^(залишено без змін|скасовано|змінено|відмовлено|повернуто|провадження у справі закрито|залишено без розгляду|у задоволенні)/.test(r)) return 'done';
  if (/^(передано для відправки|передано на відправку|відправлено до суду)/.test(r)) return 'done';
  if (/відкрито кас|витребувано/.test(r)) return 'active';
  return 'unknown';
}
// Повертає {code, label, date, court}. code: appeal (оскарження), active, done, final, unknown
function caseStatus(it) {
  const cs = cardsOf(it).filter((c) => c.stage || c.result);
  if (!cs.length) return null;
  const recs = cs.map((c) => ({ c, kind: recKind(c), inst: instOf(c.court), d: c.sd || c.reg || c.fd || '' }));
  recs.sort((a, b) => (a.d < b.d ? 1 : a.d > b.d ? -1 : b.inst - a.inst));
  const recent = dateMinus(kyivToday(), 180);
  const rank = (r) => r.inst + (r.kind === 'filed' ? 1 : 0);
  const live2 = recs.filter((r) => (r.kind === 'active' || r.kind === 'filed') && r.d >= recent)
    .sort((a, b) => rank(b) - rank(a) || (a.d < b.d ? 1 : -1));
  // «Подано скаргу» у першій інстанції втрачає силу, якщо вища інстанція вже розглянула справу пізніше
  const top = recs[0];
  let p = live2[0] || top;
  if (p.kind === 'filed' && recs.some((r) => r.inst > p.inst && r.kind !== 'active' && r.kind !== 'unknown' && r.d >= p.d)) p = live2.find((r) => r.kind === 'active') || top;
  const text = p.c.stage || p.c.result;
  let code = 'unknown';
  let label = text;
  if (p.kind === 'filed') {
    code = 'appeal';
    label = `Оскарження: ${text}`;
  } else if (p.kind === 'active' && p.inst > 1) {
    code = 'appeal';
    label = `Оскарження, ${INST_NAME[p.inst]}: ${text}`;
  } else if (p.kind === 'active') code = 'active';
  else if (p.kind === 'final') code = 'final';
  else if (p.kind === 'done') {
    code = 'done';
    if (p.inst > 1) label = `Розглянуто, ${INST_NAME[p.inst]}${p.c.result ? `: ${p.c.result}` : ''}`;
  }
  // ДСА давно не оновлювала запис: стадія може не відповідати дійсності
  const asof = p.c.fd || p.d;
  if ((code === 'active' || code === 'appeal' || code === 'unknown') && asof && asof < dateMinus(kyivToday(), 365)) {
    code = 'stale';
    label = `Остання відома стадія: ${text}`;
  }
  return { code, label, date: p.d, court: p.c.court, asof };
}
const statusLineOf = (st) => (st ? `<div class="m">Стан: <b>${h(st.label)}</b>${st.date ? ` (${h(fmtD(st.date))})` : ''}${st.code === 'appeal' ? ' <span class="tag due">оскарження</span>' : st.code === 'final' ? ' <span class="tag past">завершено</span>' : st.code === 'stale' ? ` <span class="tag past">дані ДСА від ${h(fmtD(st.asof))}</span>` : ''}</div>` : '');

// Справи, які можна перенести в архів: завершені, без засідань і без свіжих подій
function archCandidates() {
  const now = kyivNowIso();
  const d30 = dateMinus(kyivToday(), 30);
  const d90 = dateMinus(kyivToday(), 90);
  const out = [];
  for (const it of live()) {
    if (it.t !== 'case') continue;
    const st = caseStatus(it);
    if (!st || !(st.code === 'final' || st.code === 'done' || st.code === 'stale')) continue;
    if ((st.code === 'final' && st.date > d30) || (st.code === 'done' && st.date > d90)) continue;
    if (itemHearings(it).some((r) => r.iso >= now)) continue;
    const decs = S.dec[caseBase(it.number)] || [];
    if (decs.some((d) => d.recv > d30)) continue;
    const e = esOf(it);
    if (e && e.last > d30) continue;
    out.push({ it, st });
  }
  const ord = { final: 0, done: 1, stale: 2 };
  return out.sort((a, b) => ord[a.st.code] - ord[b.st.code] || (a.st.date < b.st.date ? -1 : 1));
}
function toArchive(it) {
  S.aw[esKey(it.number)] = kyivToday();
  updateItem(it.id, { arch: true });
}
function openArchCandidates() {
  const list = archCandidates();
  const fin = list.filter((x) => x.st.code === 'final');
  const done = list.filter((x) => x.st.code === 'done');
  const card = ({ it, st }) => `<div class="card"><div class="row"><div class="grow"><div class="t">${h(itemTitle(it))}</div>
    <div class="m">№ ${h(it.number)}${st.court ? ` · ${h(st.court)}` : ''}</div>${statusLineOf(st)}</div>
    <div class="col"><button class="btn sec sm" data-act="ac-arch" data-id="${h(it.id)}">В архів</button><button class="btn ghost sm" data-act="open" data-id="${h(it.id)}">Відкрити</button></div></div></div>`;
  $('#dlgBody').innerHTML = `<div class="dh"><h1>Справи для архіву</h1><button class="x" data-act="close" aria-label="Закрити">×</button></div>
    <p class="note">Це справи без призначених засідань і без нових рішень та документів за останні 30 днів. Архівну справу застосунок перевіряє далі і повідомляє про нові стадії та рішення.</p>
    ${fin.length ? `<h2>Рішення набрало законної сили (${fin.length})</h2><div class="btns"><button class="btn" data-act="ac-all" data-g="final">Усі ${fin.length} в архів</button></div>${fin.map(card).join('')}` : ''}
    ${done.length ? `<h2>Розглянуто понад 90 днів тому (${done.length})</h2><div class="btns"><button class="btn sec" data-act="ac-all" data-g="done">Усі ${done.length} в архів</button></div>${done.map(card).join('')}` : ''}
    ${list.filter((x) => x.st.code === 'stale').length ? `<h2>Давні дані: понад рік без оновлення (${list.filter((x) => x.st.code === 'stale').length})</h2><p class="note">ДСА не оновлювала ці записи понад рік. Справа, ймовірно, завершена, але перевірте.</p><div class="btns"><button class="btn sec" data-act="ac-all" data-g="stale">Усі ${list.filter((x) => x.st.code === 'stale').length} в архів</button></div>${list.filter((x) => x.st.code === 'stale').map(card).join('')}` : ''}
    ${list.length ? '' : '<p class="note">Зараз таких справ немає.</p>'}
    <button class="btn sec wide" data-act="close">Закрити</button>`;
  S.openId = null;
  showDlg();
}

// ---------- Нагляд за архівом: нові стадії, рішення і документи в архівних справах ----------
const awBase = (it) => S.aw[esKey(it.number)] || new Date(it.u || it.c || Date.now()).toISOString().slice(0, 10);
function archEvents() {
  const out = [];
  for (const it of active()) {
    if (it.t !== 'case' || !it.arch) continue;
    const ab = awBase(it);
    const evs = [];
    for (const c of cardsOf(it)) {
      if (c.sd && c.sd > ab && (c.stage || c.result)) evs.push({ k: 'stan', d: c.sd, text: `Нова стадія: ${c.stage || c.result}`, sub: c.court });
    }
    for (const d of S.decA[caseBase(it.number)] || []) {
      if (d.recv > ab) evs.push({ k: 'dec', d: d.recv, text: `${d.form} від ${fmtD(d.adj)}`, sub: d.court, id: d.id });
    }
    const e = esOf(it);
    if (e && e.last > ab) evs.push({ k: 'esud', d: e.last, text: 'Новий документ в Електронному суді', sub: e.court || '' });
    if (evs.length) out.push({ it, evs: evs.sort((a, b) => (a.d < b.d ? 1 : -1)) });
  }
  return out.sort((a, b) => (a.evs[0].d < b.evs[0].d ? 1 : -1));
}
function archEventCard(x) {
  const it = x.it;
  return `<div class="card unread"><div class="t">${h(itemTitle(it))} <span class="tag past">архів</span></div>
    <div class="m">№ ${h(it.number)}</div>
    ${x.evs.slice(0, 4).map((e) => `<div class="m"><b>${h(fmtD(e.d))}</b> · ${h(e.text)}${e.sub ? ` · ${h(e.sub)}` : ''}${e.id ? ` · <a href="${h(reviewUrl(e.id))}" target="_blank" rel="noopener">реєстр</a>` : ''}</div>`).join('')}
    <div class="btns"><button class="btn sm" data-act="open" data-id="${h(it.id)}">Відкрити справу</button>
    <button class="btn sec sm" data-act="arch" data-id="${h(it.id)}">Повернути з архіву</button>
    <button class="btn ghost sm" data-act="aw-read" data-id="${h(it.id)}">Прочитано</button></div></div>`;
}
function archNotices() {
  const sent = new Set(LS.get('ct.awn', []));
  const out = [];
  for (const x of archEvents()) {
    const id = `${esKey(x.it.number)}|${x.evs[0].k}|${x.evs[0].d}`;
    if (sent.has(id)) continue;
    sent.add(id);
    out.push({ id: hash32('aw|' + id) & 0x7fffffff, title: `Архівна справа: ${x.evs[0].text}`, body: `${itemTitle(x.it)}\n№ ${x.it.number}, ${fmtD(x.evs[0].d)}` });
  }
  LS.set('ct.awn', [...sent].slice(-600));
  return out;
}
// Рішення в архівних справах перевіряємо раз на 14 днів
async function refreshArchDecisions() {
  const last = LS.get('ct.decAat', '');
  if (last && last > dateMinus(kyivToday(), 14)) return;
  if (!S.decMeta) return;
  const bases = [...new Set(active().filter((i) => i.t === 'case' && i.arch).map((i) => caseBase(i.number)).filter(Boolean))];
  const from = dateMinus(kyivToday(), 200);
  const next = {};
  const queue = bases.slice();
  let failed = 0;
  await Promise.all(Array.from({ length: Math.min(6, queue.length) }, async () => {
    while (queue.length) {
      const b = queue.shift();
      try {
        const rows = ((await dc.decisions(b)) || []).filter((d) => d.recv >= from).slice(0, 5);
        if (rows.length) next[b] = rows;
      } catch {
        failed++;
        if (S.decA[b]) next[b] = S.decA[b];
      }
    }
  }));
  S.decA = next;
  LS.set('ct.decA', S.decA);
  if (failed < bases.length / 4) LS.set('ct.decAat', kyivToday());
}

// ---------- Електронний суд (esud.json у приватному репозиторії) ----------
// Файл містить дату останнього документа у кожній справі з кабінету користувача.
function mergeEs(a, b) {
  const bs = [a && a.b, b && b.b].filter(Boolean).sort();
  const seen = {};
  for (const src of [a && a.seen, b && b.seen]) {
    for (const [k, d] of Object.entries(src || {})) if (!seen[k] || d > seen[k]) seen[k] = d;
  }
  const keys = Object.keys(seen).sort();
  return { b: bs[0] || '', seen: Object.fromEntries(keys.map((k) => [k, seen[k]])) };
}
async function loadEsud() {
  if (!syncOn()) return;
  try {
    const j = (await ghRaw('esud.json', !!S.esud)).data;
    if (j && j.cases) {
      S.esud = { at: j.at, cases: j.cases };
      LS.set('ct.esud', S.esud);
      if (!S.es.b && j.at) {
        S.es.b = dateMinus(j.at.slice(0, 10), 3);
        save();
        syncSoon();
      }
    }
  } catch { /* спробуємо під час наступного оновлення */ }
}
const esKey = (n) => caseBase(n) || normCase(n);
const esOf = (it) => (it && it.t === 'case' && S.esud && S.esud.cases[esKey(it.number)]) || null;
function esUnread(it) {
  const e = esOf(it);
  return !!e && !!S.es.b && e.last >= S.es.b && e.last > (S.es.seen[esKey(it.number)] || '');
}
function esList() {
  const out = [];
  // Архівні справи теж беруть участь: новий документ у старій справі є важливим сигналом
  for (const it of active()) {
    const e = esOf(it);
    if (e) out.push({ item: it, e, unread: esUnread(it) });
  }
  return out.sort((a, b) => (a.e.last < b.e.last ? 1 : a.e.last > b.e.last ? -1 : 0));
}
function esMark(it) {
  const e = esOf(it);
  if (!e) return;
  S.es.seen[esKey(it.number)] = e.last;
  save();
  syncSoon();
}
// Справи з кабінету, яких немає у списку застосунку
function esMissing() {
  if (!S.esud) return [];
  const have = new Set(active().filter((i) => i.t === 'case').map((i) => esKey(i.number)));
  return Object.entries(S.esud.cases).filter(([k]) => !have.has(k)).map(([k, e]) => ({ k, e }))
    .sort((a, b) => (a.e.last < b.e.last ? 1 : a.e.last > b.e.last ? -1 : 0));
}
function openEsMissing() {
  const list = esMissing();
  $('#dlgBody').innerHTML = `<div class="dh"><h1>Справи з Електронного суду</h1><button class="x" data-act="close" aria-label="Закрити">×</button></div>
    <p class="note">Цих справ немає у вашому списку. Список відсортовано за датою останнього документа. Сторони і стадія взяті з відкритих даних ДСА.</p>
    ${list.length ? `<div class="btns"><button class="btn" data-act="es-add-all">Додати всі (${list.length})</button><button class="btn sec" data-act="es-add-all" data-arch="1">Усі в архів (${list.length})</button></div>
      <p class="note">«Додати»: застосунок стежить за справою. «В архів»: справа є у застосунку, але не оновлюється і не дає нагадувань. З архіву її можна повернути.</p>` : '<p class="note">Усі справи з кабінету вже у списку.</p>'}
    ${list.map(({ k, e }) => {
    const cs = (S.cards && S.cards.cases && S.cards.cases[k]) || [];
    const parts = (cs.filter((c) => c.parts).sort((x, y) => y.parts.length - x.parts.length)[0] || {}).parts || '';
    const st = cs.find((c) => c.stage || c.result);
    const desc = (cs.find((c) => c.desc) || {}).desc || '';
    return `<div class="card"><div class="row"><div class="grow"><div class="t">${h(shortParties(parts) || `Справа № ${e.n}`)}</div>
      <div class="m">№ ${h(e.n)} · ${h(e.court || '')}</div>
      ${desc ? `<div class="m clamp">${h(desc)}</div>` : ''}
      ${st ? `<div class="m">Стадія: <b>${h(st.stage || st.result)}</b>${st.sd ? ` (${h(fmtD(st.sd))})` : ''}</div>` : ''}
      <div class="m">Документи в Е-суді: ${h(fmtD(e.first))} - ${h(fmtD(e.last))}</div>
      ${parts ? `<details class="m"><summary>Усі учасники</summary>${h(parts)}</details>` : ''}</div>
      <div class="col"><button class="btn sec sm" data-act="es-add" data-k="${h(k)}">Додати</button><button class="btn ghost sm" data-act="es-add" data-arch="1" data-k="${h(k)}">В архів</button></div></div></div>`;
  }).join('')}
    <button class="btn sec wide" data-act="close">Закрити</button>`;
  S.openId = null;
  showDlg();
}
function esAdd(keys, arch) {
  let n = 0;
  for (const k of keys) {
    const e = S.esud && S.esud.cases[k];
    if (!e) continue;
    if (arch) S.aw[k] = kyivToday();
    addItem(arch ? { t: 'case', number: caseBase(e.n) || e.n, arch: true } : { t: 'case', number: caseBase(e.n) || e.n });
    n++;
  }
  return n;
}
function esCard(x) {
  const it = x.item;
  return `<div class="card${x.unread ? ' unread' : ''}">
    <div class="t">Документ від ${h(fmtD(x.e.last))} ${x.unread ? '<span class="tag new">нове</span>' : ''}${it.arch ? '<span class="tag past">справа в архіві</span>' : ''}</div>
    <div class="m"><b>${h(itemTitle(it))}</b></div>
    <div class="m">№ ${h(it.number)}${x.e.court ? ` · ${h(x.e.court)}` : ''}</div>
    <div class="btns"><button class="btn sm" data-act="open" data-id="${h(it.id)}">Відкрити справу</button>
    <a class="btn sec sm" href="https://cabinet.court.gov.ua/cases" target="_blank" rel="noopener" data-act="copy" data-text="${h(it.number)}">Електронний суд</a>
    ${x.unread ? `<button class="btn ghost sm" data-act="es-read" data-id="${h(it.id)}">Прочитано</button>` : ''}</div></div>`;
}

// ---------- Документи (docs.json у приватному репозиторії) ----------
// Файл веде помічник: документи, що надійшли у справах, потрібна дія і дата реагування.
// Запис: {id, recv, case, vp (номер виконавчого провадження), proc, court, name, from, kind ('act'|'info'), act, due, dk ('p' строк | 'c' контрольна дата), dueNote, note, link, draft}.
// Позначки користувача (виконано, власна дата, нотатка) лежать у state.json (dm) і синхронізуються.
async function loadDocs() {
  if (!syncOn()) return;
  try {
    const r = await fetch(ghUrl('docs.json') + `?t=${Date.now()}`, { headers: { ...ghHeaders(), Accept: 'application/vnd.github.raw+json' }, cache: 'no-store' });
    if (!r.ok) return;
    const j = await r.json();
    if (j && Array.isArray(j.docs)) {
      S.docs = { at: j.at || '', docs: j.docs };
      LS.set('ct.docs', S.docs);
    }
  } catch { /* спробуємо під час наступного оновлення */ }
}
const safeUrl = (u) => (/^https:\/\/[^\s"'<>]+$/.test(u || '') ? u : '');
const fmtRecv = (r) => (!r ? '' : r.length > 10 ? fmtDT(r) : fmtD(r));
function docList() {
  if (!S.docs) return [];
  const byCase = new Map(active().filter((i) => i.t === 'case').map((i) => [esKey(i.number), i]));
  const today = kyivToday();
  return S.docs.docs.filter((d) => d && d.id).map((d) => {
    const mark = S.dm[d.id] || null;
    const due = docDue(d, mark);
    return {
      ...d, mark, st: docStatus(d, mark), dueD: due ? due.date : '', dueK: due ? due.kind : '',
      left: due ? dayDiff(due.date, today) : null, item: (d.case && byCase.get(esKey(d.case))) || null,
    };
  });
}
const byRecv = (a, b) => (a.recv < b.recv ? 1 : a.recv > b.recv ? -1 : 0);
// У роботі: спочатку документи з датою (найближча зверху), потім без дати (новіші зверху)
const docsOpen = () => docList().filter((d) => d.st === 'open')
  .sort((a, b) => (a.dueD && b.dueD ? a.dueD.localeCompare(b.dueD) || byRecv(a, b) : a.dueD ? -1 : b.dueD ? 1 : byRecv(a, b)));
function setMark(id, patch) {
  S.dm[id] = { s: '', due: '', note: '', ...(S.dm[id] || {}), ...patch, u: Date.now() };
  save();
  syncSoon();
  scheduleReminders();
}
function dueLine(d) {
  if (!d.dueD) return '<div class="m">Дату реагування не визначено</div>';
  const n = d.left;
  const rel = n < 0 ? `прострочено на ${-n} дн.` : n === 0 ? 'сьогодні' : n === 1 ? 'завтра' : `через ${n} дн.`;
  const label = d.dueK === 'p' ? 'Строк' : d.dueK === 'u' ? 'Моя дата' : 'Контрольна дата';
  return `<div class="m">${label}: <b>${h(fmtD(d.dueD))}</b> · ${rel}</div>`;
}
function docCard(d, opts = {}) {
  const open = d.st === 'open';
  const late = open && d.left != null && d.left < 0;
  const soon = open && d.left != null && d.left >= 0 && d.left <= 1;
  const title = d.item ? itemTitle(d.item) : '';
  const link = safeUrl(d.link);
  return `<div class="card doc${late ? ' unread' : ''}${open ? '' : ' closed'}">
    <div class="t">${h(d.name || 'Документ')} ${late ? '<span class="tag new">прострочено</span>' : soon ? `<span class="tag due">${d.left === 0 ? 'сьогодні' : 'завтра'}</span>` : ''}${d.st === 'done' ? '<span class="tag">виконано</span>' : d.st === 'skip' ? '<span class="tag past">без реакції</span>' : d.st === 'info' ? '<span class="tag past">довідково</span>' : ''}</div>
    ${opts.noTitle || !title ? '' : `<div class="m"><b>${h(title)}</b></div>`}
    <div class="m">${d.case ? `№ ${h(d.case)}` : d.vp ? `Виконавче провадження № ${h(d.vp)}` : 'Номер справи не визначено'}${d.court ? ` · ${h(d.court)}` : ''}</div>
    <div class="m">${d.from ? `Від: ${h(d.from)} · ` : ''}надійшов ${h(fmtRecv(d.recv))}</div>
    ${d.act && d.st !== 'info' ? `<div class="m act">Потрібно: <b>${h(d.act)}</b></div>` : ''}
    ${open ? dueLine(d) : ''}
    <div class="btns">${open ? `<button class="btn sm" data-act="doc-done" data-id="${h(d.id)}">Виконано</button>` : ''}<button class="btn sec sm" data-act="doc-open" data-id="${h(d.id)}">Деталі</button>${link ? `<a class="btn ghost sm" href="${h(link)}" target="_blank" rel="noopener">Е-суд</a>` : ''}</div></div>`;
}
function viewDocs() {
  let out = `<div class="head"><h1>Документи</h1><button class="btn sec sm" data-act="refresh" ${S.busy ? 'disabled' : ''}>Оновити</button></div>`;
  if (!syncOn()) return out + `<div class="empty"><b>Розділ ще не працює</b>Спочатку налаштуйте синхронізацію в розділі «Налаштування».</div>`;
  if (!S.docs) return out + `<div class="empty"><b>Даних ще немає</b>Застосунок завантажить реєстр документів під час наступного оновлення.</div>`;
  const all = docList();
  const open = docsOpen();
  const closed = all.filter((d) => d.st === 'done' || d.st === 'skip').sort(byRecv);
  const f = S.dfilter;
  out += `<p class="sub">Реєстр веде помічник за листами Електронного суду. Дані станом на ${h(fmtRecv(S.docs.at))}. Строки перевіряйте за ухвалою суду.</p>
    <div class="seg"><button data-act="dfilter" data-f="open" class="${f === 'open' ? 'on' : ''}">У роботі (${open.length})</button><button data-act="dfilter" data-f="all" class="${f === 'all' ? 'on' : ''}">Усі (${all.length})</button><button data-act="dfilter" data-f="closed" class="${f === 'closed' ? 'on' : ''}">Закриті (${closed.length})</button></div>`;
  if (f === 'open') {
    if (!open.length) return out + `<div class="empty"><b>Документів у роботі немає</b>Нові документи зʼявляться тут після перевірки пошти.</div>`;
    const late = open.filter((d) => d.left != null && d.left < 0).length;
    if (late) out += `<p class="note badc">Увага: прострочених дат: ${late}.</p>`;
    const dated = open.filter((d) => d.dueD);
    const rest = open.filter((d) => !d.dueD);
    if (dated.length) out += `<h2>З датою реагування (${dated.length})</h2>` + dated.map((d) => docCard(d)).join('');
    if (rest.length) out += `<h2>Без дати (${rest.length})</h2>` + rest.map((d) => docCard(d)).join('');
    return out;
  }
  const list = f === 'closed' ? closed : all.slice().sort(byRecv);
  if (!list.length) return out + `<div class="empty"><b>Список порожній</b></div>`;
  return out + list.slice(0, 200).map((d) => docCard(d)).join('') + (list.length > 200 ? '<p class="note">Показано останні 200 документів.</p>' : '');
}
function openDoc(id) {
  const d = docList().find((x) => x.id === id);
  if (!d) return;
  const open = d.st === 'open';
  const m = d.mark || {};
  const link = safeUrl(d.link);
  const draft = safeUrl(d.draft);
  $('#dlgBody').innerHTML = `<div class="dh"><h1>${h(d.name || 'Документ')}</h1><button class="x" data-act="close" aria-label="Закрити">×</button></div>
    ${d.item ? `<div class="m"><b>${h(itemTitle(d.item))}</b></div>` : ''}
    <div class="m">${d.case ? `Справа № ${h(d.case)} <button class="btn ghost sm" data-act="copy" data-text="${h(d.case)}">копіювати</button>` : d.vp ? `Виконавче провадження № ${h(d.vp)} <button class="btn ghost sm" data-act="copy" data-text="${h(d.vp)}">копіювати</button>` : 'Номер справи не визначено'}</div>
    ${d.proc ? `<div class="m">Провадження № ${h(d.proc)}</div>` : ''}
    ${d.court ? `<div class="m">${h(d.court)}</div>` : ''}
    <div class="m">${d.from ? `Від: ${h(d.from)} · ` : ''}надійшов ${h(fmtRecv(d.recv))}</div>
    <h2>Що потрібно</h2>
    <div class="card"><div class="t">${h(d.act || 'Реакція не потрібна')} ${d.st === 'done' ? '<span class="tag">виконано</span>' : d.st === 'skip' ? '<span class="tag past">без реакції</span>' : ''}</div>
      ${d.act || d.dueD ? dueLine(d) : ''}
      ${d.dueNote ? `<div class="m">${h(d.dueNote)}</div>` : ''}
      ${d.note ? `<div class="m">${h(d.note)}</div>` : ''}
      ${draft ? `<div class="btns"><a class="btn sec sm" href="${h(draft)}" target="_blank" rel="noopener">Проєкт відповіді</a></div>` : d.draft ? `<div class="m">Проєкт відповіді: ${h(d.draft)}</div>` : ''}</div>
    <label for="docDue">Моя дата реагування</label>
    <div class="row"><input type="date" id="docDue" data-doc="${h(d.id)}" data-field="due" value="${h(m.due || '')}"></div>
    <p class="note">Ваша дата замінює дату помічника. Очистіть поле, щоб повернути дату помічника.</p>
    <label for="docNote">Моя нотатка</label>
    <textarea id="docNote" rows="2" data-doc="${h(d.id)}" data-field="note">${h(m.note || '')}</textarea>
    <div class="btns">${open ? `<button class="btn" data-act="doc-done" data-id="${h(d.id)}">Виконано</button><button class="btn sec" data-act="doc-skip" data-id="${h(d.id)}">Не потребує реакції</button>`
    : `<button class="btn sec" data-act="doc-reopen" data-id="${h(d.id)}">${d.st === 'info' ? 'Взяти в роботу' : 'Повернути в роботу'}</button>`}
      ${link ? `<a class="btn sec" href="${h(link)}" target="_blank" rel="noopener">Відкрити в Електронному суді</a>` : ''}
      ${d.item ? `<button class="btn sec" data-act="open" data-id="${h(d.item.id)}">Відкрити справу</button>` : d.case ? `<button class="btn sec" data-act="watch-case" data-case="${h(d.case)}">Стежити за справою</button>` : ''}</div>
    <button class="btn wide" data-act="close">Закрити</button>`;
  S.openId = null;
  showDlg();
}
// Нові документи з часу попередньої перевірки на цьому пристрої. Перше завантаження сповіщень не дає.
function checkDocs() {
  if (!S.docs) return [];
  const prev = LS.get('ct.dseen', null);
  const seen = new Set(prev || []);
  const notices = [];
  for (const d of docList()) {
    if (seen.has(d.id)) continue;
    seen.add(d.id);
    if (prev && d.st === 'open') {
      notices.push({
        id: hash32(`docnew|${d.id}`) & 0x7fffffff,
        title: `Надійшов документ: ${d.name || 'документ'}`,
        body: `${d.item ? itemTitle(d.item) + '\n' : ''}${d.case ? `№ ${d.case}. ` : d.vp ? `ВП № ${d.vp}. ` : ''}${d.act ? `Потрібно: ${d.act}.` : ''}${d.dueD ? ` Дата: ${fmtD(d.dueD)}.` : ''}`,
      });
    }
  }
  LS.set('ct.dseen', [...seen].slice(-3000));
  return notices.slice(0, 6);
}

// ---------- Стан розгляду справ (cards.json у приватному репозиторії) ----------
async function loadCards() {
  if (!syncOn()) return;
  try {
    const j = (await ghRaw('cards.json', !!S.cards)).data;
    if (j && j.cases) {
      S.cards = { newest: j.newest, oldest: j.oldest, remaining: j.remaining, built: j.built, cases: j.cases };
      LS.set('ct.cards', S.cards);
    }
  } catch { /* спробуємо під час наступного оновлення */ }
}
const cardsOf = (it) => (it && it.t === 'case' && S.cards && S.cards.cases && S.cards.cases[caseBase(it.number)]) || [];
let cardsT = [];
// Після додавання справи завдання GitHub готує дані близько хвилини
function cardsSoon() {
  if (!syncOn()) return;
  cardsT.forEach(clearTimeout);
  cardsT = [80, 160, 300].map((sec) => setTimeout(async () => {
    await loadCards();
    softRender();
  }, sec * 1000));
}
let syncT;
function syncSoon() {
  if (!syncOn()) return;
  clearTimeout(syncT);
  syncT = setTimeout(async () => {
    await syncNow();
    if (S.view === 'settings') render();
  }, 1500);
}

// ---------- Оновлення засідань ----------
async function refreshItem(it) {
  let rows;
  const now = kyivNowIso();
  if (it.t === 'case') {
    rows = (await dc.findCase(it.number)).rows;
    // Історія: минулі засідання, яких уже немає в даних суду, залишаються на пристрої
    const have = new Set(rows.map(hearingUid));
    const kept = (S.hearings[it.id] || []).filter((r) => r.iso < now && !have.has(hearingUid(r)));
    rows = kept.concat(rows).sort((a, b) => (a.iso < b.iso ? -1 : a.iso > b.iso ? 1 : 0)).slice(-250);
    // Для старих засідань зберігаємо лише дату, суд, зал і суддю, щоб не переповнити памʼять
    const lastPast = rows.filter((r) => r.iso < now).length - 1;
    rows = rows.map((r, i) => (i < lastPast ? { ...r, involved: '', desc: '' } : r));
  } else {
    const from = kyivNowIso(Date.now() - 30 * 864e5);
    rows = (await dc.findName(it.query, { court: it.court, maxShards: 40 })).rows.filter((r) => r.iso >= from).slice(0, 400);
  }
  S.hearings[it.id] = rows;
  const first = !S.init.has(it.id);
  for (const r of rows) {
    const u = hearingUid(r);
    if (!S.seen.has(u)) {
      S.seen.add(u);
      if (!first && r.iso >= now) S.fresh.add(u);
    }
  }
  S.init.add(it.id);
}
async function refreshAll(opts = {}) {
  if (S.busy) return;
  S.busy = true;
  S.err = '';
  softRender();
  try {
    await syncNow();
    loadCards().then(softRender);
    loadEsud().then(softRender);
    loadBusy().then(softRender);
    const pDocs = loadDocs();
    pDocs.then(softRender);
    S.meta = await dc.meta(true);
    LS.set('ct.meta', { built: S.meta.built, sourceModified: S.meta.sourceModified, rows: S.meta.rows, to: S.meta.to });
    const list = live();
    const queue = list.slice();
    const errs = [];
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
      while (queue.length) {
        const it = queue.shift();
        try {
          await refreshItem(it);
        } catch (e) {
          errs.push(e.message);
        }
      }
    }));
    // прибираємо застарілі записи
    const ids = new Set(active().map((i) => i.id));
    for (const k of Object.keys(S.hearings)) if (!ids.has(k)) delete S.hearings[k];
    const old = new Date(Date.now() - 420 * 864e5).toISOString().slice(0, 16);
    for (const u of S.seen) if ((u.split('|')[1] || '') < old) S.seen.delete(u);
    const nowIso = kyivNowIso();
    for (const u of S.fresh) if ((u.split('|')[1] || '') < nowIso) S.fresh.delete(u);
    if (errs.length) S.err = errs[0];
    save();
    softRender();
    await refreshDecisions();
    save();
    await pDocs;
    await refreshArchDecisions();
    const notices = checkManual().concat(checkDocs()).concat(archNotices());
    await scheduleReminders();
    await notifyNow(notices);
  } catch (e) {
    S.err = navigator.onLine === false ? 'Немає звʼязку з інтернетом. Показано збережені дані.' : e.message;
  } finally {
    S.busy = false;
    if (opts.force) render();
    else softRender();
  }
}
// ---------- Судові рішення ----------
// Справи, за якими застосунок шукає рішення: справи зі списку і справи із запитів за учасником
function trackedCases() {
  const map = new Map();
  for (const it of live()) {
    if (it.t !== 'case') continue;
    map.set(caseBase(it.number), { item: it, baseline: it.rb || dateMinus(new Date(it.c || Date.now()).toISOString().slice(0, 10), 7) });
  }
  for (const it of live()) {
    if (it.t !== 'kw' || it.ag === false) continue;
    const baseline = it.rb || dateMinus(new Date(it.c || Date.now()).toISOString().slice(0, 10), 7);
    for (const r of S.hearings[it.id] || []) {
      const b = caseBase(r.case);
      if (!map.has(b) && map.size < 70) map.set(b, { item: it, row: r, baseline });
    }
  }
  return map;
}
async function refreshDecisions() {
  const meta = await dc.decMeta(true);
  S.decMeta = meta ? { built: meta.built, from: meta.from, sourceModified: meta.sourceModified } : null;
  LS.set('ct.decmeta', S.decMeta);
  if (!meta) return;
  const tracked = trackedCases();
  const bases = [...tracked.keys()];
  const next = {};
  const queue = bases.slice();
  await Promise.all(Array.from({ length: Math.min(6, queue.length) }, async () => {
    while (queue.length) {
      const b = queue.shift();
      try {
        const rows = await dc.decisions(b);
        next[b] = (rows || []).slice(0, tracked.get(b).item.t === 'case' ? 60 : 15);
      } catch {
        if (S.dec[b]) next[b] = S.dec[b];
      }
    }
  }));
  S.dec = next;
}
const isUnread = (d, baseline) => d.recv >= baseline && !(S.rd.ra && d.recv < S.rd.ra) && !S.rd.read[d.id];
function decList() {
  const out = [];
  for (const [base, t] of trackedCases()) {
    const title = t.item.t === 'case' ? itemTitle(t.item) : shortParties(t.row.involved) || `Справа № ${t.row.case}`;
    for (const d of S.dec[base] || []) out.push({ ...d, base, item: t.item, title, unread: isUnread(d, t.baseline) });
  }
  return out.sort((a, b) => (a.recv < b.recv ? 1 : a.recv > b.recv ? -1 : b.id - a.id));
}
function markRead(id, recv) {
  if (S.rd.read[id]) return;
  S.rd.read[id] = recv;
  save();
  syncSoon();
}
function markAllRead() {
  const today = kyivToday();
  for (const d of decList()) if (d.unread && d.recv >= today) S.rd.read[d.id] = d.recv;
  S.rd = mergeRead({ ra: today, read: S.rd.read }, null);
  for (const x of esList()) if (x.unread) S.es.seen[esKey(x.item.number)] = x.e.last;
  save();
  syncSoon();
  render();
  toast('Усі рішення позначено прочитаними');
}
function decCard(d, opts = {}) {
  return `<div class="card${d.unread ? ' unread' : ''}">
    <div class="t">${h(d.form)} від ${h(fmtD(d.adj))} ${d.unread ? '<span class="tag new">нове</span>' : ''}</div>
    ${opts.noTitle ? '' : `<div class="m"><b>${h(d.title)}</b></div>`}
    <div class="m">№ ${h(d.case)} · ${h(d.court)}</div>
    <div class="m">${d.judge ? `Суддя: ${h(d.judge)} · ` : ''}надійшло до реєстру ${h(fmtD(d.recv))}</div>
    ${d.pub ? '' : '<div class="m warn">Текст рішення в реєстрі може бути закритий.</div>'}
    <div class="btns"><a class="btn sm" href="${h(reviewUrl(d.id))}" target="_blank" rel="noopener" data-act="dec-open" data-id="${d.id}" data-recv="${h(d.recv)}">Відкрити в реєстрі</a>
    ${!opts.noTitle && d.item && d.item.t === 'case' ? `<button class="btn sec sm" data-act="open" data-id="${h(d.item.id)}">Відкрити справу</button>` : ''}
    ${d.unread ? `<button class="btn ghost sm" data-act="dec-read" data-id="${d.id}" data-recv="${h(d.recv)}">Прочитано</button>` : ''}</div></div>`;
}
function viewDecisions() {
  const list = decList();
  const unread = list.filter((d) => d.unread);
  const since = dateMinus(kyivToday(), 90);
  const rest = list.filter((d) => !d.unread && d.recv >= since);
  const es = esList();
  const esNew = es.filter((x) => x.unread);
  let out = `<div class="head"><h1>Рішення</h1><button class="btn sec sm" data-act="dec-all" ${unread.length || esNew.length ? '' : 'disabled'}>Усі прочитані</button></div>`;
  const aev = archEvents();
  if (aev.length) out += `<h2>Архівні справи: нові події (${aev.length})</h2>${aev.map(archEventCard).join('')}`;
  if (S.esud) {
    out += `<h2>Електронний суд: нові документи (${esNew.length})</h2>${esNew.map(esCard).join('')}
      <p class="note">Дані кабінету станом на ${h(fmtDT(S.esud.at))}. ${esNew.length ? '' : 'Нових документів немає. '}Справ із кабінету у списку: ${es.length}.</p>
      ${esMissing().length ? `<div class="btns" style="margin-bottom:12px"><button class="btn sec sm" data-act="es-missing">У кабінеті є ще ${esMissing().length} справ не зі списку</button></div>` : ''}`;
  }
  if (!S.decMeta) return out + `<div class="empty"><b>Даних про рішення ще немає</b>Застосунок завантажить їх під час наступного оновлення.</div>`;
  out += `<p class="sub">Нові рішення та прочитані за останні 90 днів. Усі рішення з ${h(fmtD(S.decMeta.from))} є у вікні справи. ДСА публікує ці дані із затримкою 1-3 дні.</p>`;
  if (!unread.length && !rest.length) return out + `<div class="empty"><b>Нових рішень немає</b>Старіші рішення відкрийте у вікні справи.</div>`;
  if (unread.length) out += `<h2>Нові рішення з реєстру (${unread.length})</h2>` + unread.map((d) => decCard(d)).join('');
  if (rest.length) out += `<h2>Прочитані</h2>` + rest.slice(0, 150).map((d) => decCard(d)).join('');
  return out;
}

// ---------- Засідання, введені вручну ----------
// Запис: {id, item (id справи), iso, note, c, u, del}. Синхронізується через state.json.
function addManual(itemId, iso, note) {
  const now = Date.now();
  const m = { id: uid(), item: itemId, iso, note: note || '', c: now, u: now };
  S.mh.push(m);
  save();
  syncSoon();
  return m;
}
function removeManual(id) {
  const m = S.mh.find((x) => x.id === id);
  if (!m) return;
  m.del = true;
  m.u = Date.now();
  save();
  syncSoon();
}
// Усі засідання справи: дані суду плюс ручні записи.
// Ручний запис не показується, коли суд уже вніс засідання на той самий день.
function itemHearings(it) {
  const rows = (S.hearings[it.id] || []).slice();
  if (it.t !== 'case') return rows;
  const days = new Set(rows.map((r) => r.iso.slice(0, 10)));
  const card = cardsOf(it)[0];
  const court = rows.length ? rows[rows.length - 1].court : card ? card.court : '';
  for (const m of S.mh) {
    if (m.del || m.item !== it.id) continue;
    if (days.has(m.iso.slice(0, 10))) {
      // суд уже вніс засідання на цей день: показуємо його, а різницю в часі позначаємо
      const i = rows.findIndex((r) => !r.manual && r.iso.slice(0, 10) === m.iso.slice(0, 10));
      if (i >= 0 && rows[i].iso !== m.iso) rows[i] = { ...rows[i], wasManual: m.iso.slice(11) };
      continue;
    }
    rows.push({ iso: m.iso, case: it.number, court, room: '', judges: '', involved: '', desc: m.note || '', manual: true, mid: m.id });
  }
  return rows.sort((a, b) => (a.iso < b.iso ? -1 : a.iso > b.iso ? 1 : 0));
}
// Порівняння ручних записів із даними суду. Повертає сповіщення про інший час.
function checkManual() {
  const now = kyivNowIso();
  const notices = [];
  let changed = false;
  for (const m of S.mh) {
    if (m.del || m.iso < now) continue;
    const it = S.items.find((i) => i.id === m.item && !i.del);
    if (!it) continue;
    const day = m.iso.slice(0, 10);
    const off = (S.hearings[it.id] || []).filter((r) => r.iso.slice(0, 10) === day);
    if (!off.length) continue;
    const r = off.find((x) => x.iso === m.iso) || off[0];
    if (m.ok === r.iso) continue;
    m.ok = r.iso;
    m.u = Date.now();
    changed = true;
    if (r.iso !== m.iso) {
      notices.push({
        id: hash32(`mh|${m.id}|${r.iso}`) & 0x7fffffff,
        title: `Суд призначив інший час: ${r.iso.slice(11)} замість ${m.iso.slice(11)}`,
        body: `${itemTitle(it)}\n№ ${it.number}, ${fmtD(day)}. Вручну було ${m.iso.slice(11)}, суд вніс ${r.iso.slice(11)}.`,
      });
    }
  }
  if (changed) {
    save();
    syncSoon();
  }
  return notices;
}
async function notifyNow(list) {
  if (!list.length) return;
  toast(list[0].title + (list.length > 1 ? ` (і ще ${list.length - 1})` : ''));
  try {
    if (isNative) {
      if (S.notif !== 'granted') return;
      await LN('schedule', { notifications: list.map((n) => ({ id: n.id, title: n.title, body: n.body, largeBody: n.body, channelId: 'hearings', schedule: { at: new Date(Date.now() + 1500).toISOString(), allowWhileIdle: true } })) });
    } else if ('Notification' in window && Notification.permission === 'granted') {
      for (const n of list) new Notification(n.title, { body: n.body, tag: String(n.id) });
    }
  } catch (e) {
    console.warn(e);
  }
}
const rowUid = (r) => (r.manual ? `m|${r.mid}` : hearingUid(r));
// Засідання за запитом без нагадувань (наприклад, засідання колеги) не є «моїми»
const isMine = (it) => !(it.t === 'kw' && it.rm === false);

function agenda(includePastHours = 3) {
  const from = kyivNowIso(Date.now() - includePastHours * 36e5);
  const map = new Map();
  for (const it of live()) {
    if (it.t === 'kw' && it.ag === false) continue;
    if (it.t === 'case' && it.nh) continue; // стеження за засіданнями цієї справи вимкнено
    for (const r of itemHearings(it)) {
      if (r.iso < from) continue;
      const u = rowUid(r);
      const prev = map.get(u);
      if (!prev || (prev.item.t === 'kw' && it.t === 'case')) map.set(u, { ...r, uid: u, item: it });
    }
  }
  // якщо справа є у списку, беремо її назву і для збігів за учасником
  const byCase = new Map(live().filter((i) => i.t === 'case').map((i) => [normCase(i.number), i]));
  const out = [...map.values()].map((x) => {
    const ci = byCase.get(normCase(x.case).split('(')[0]);
    const mine = isMine(x.item) || !!ci;
    return ci ? { ...x, item: ci, mine } : { ...x, mine };
  }).filter((x) => !(x.item.t === 'case' && x.item.nh));
  out.sort((a, b) => (a.iso < b.iso ? -1 : a.iso > b.iso ? 1 : 0));
  // Накладки: два мої засідання одного дня з різницею менше години
  const mineList = out.filter((x) => x.mine);
  for (let i = 0; i < mineList.length; i++) {
    for (let j = i + 1; j < mineList.length; j++) {
      const a = mineList[i];
      const b = mineList[j];
      if (a.iso.slice(0, 10) !== b.iso.slice(0, 10)) break;
      const diff = Math.abs(kyivDate(a.iso) - kyivDate(b.iso)) / 60000;
      if (diff < 60 && normCase(a.case) !== normCase(b.case)) {
        a.clash = true;
        b.clash = true;
      }
    }
  }
  // Накладки з парами та іншими подіями: засідання триває умовно 1 годину
  for (const e of busyList(includePastHours)) {
    const s0 = minOf(e.iso.slice(11));
    const e0 = e.end ? minOf(e.end) : s0 + 80;
    for (const x of mineList) {
      if (x.iso.slice(0, 10) !== e.iso.slice(0, 10)) continue;
      const t = minOf(x.iso.slice(11));
      if (t < e0 && s0 < t + 60) {
        x.clash = true;
        x.clashBusy = `${e.kind || 'пара'} ${e.iso.slice(11)}${e.end ? '-' + e.end : ''}`;
      }
    }
  }
  return out;
}
const hTitle = (x) => (x.item && x.item.t === 'case' ? itemTitle(x.item) : shortParties(x.involved) || `Справа № ${x.case}`);

// ---------- Нагадування ----------
const cap = window.Capacitor;
const isNative = !!(cap && cap.isNativePlatform && cap.isNativePlatform() && cap.nativePromise);
const LN = (method, o = {}) => cap.nativePromise('LocalNotifications', method, o);
let webTimers = [];
function reminderList() {
  const now = Date.now();
  const out = [];
  for (const x of agenda(0).filter((y) => y.mine).slice(0, 150)) {
    const t = kyivDate(x.iso).getTime();
    const time = x.iso.slice(11);
    const place = x.court + (x.room ? `, зал ${x.room}` : '');
    for (const [on, min, title] of [[S.set.r1d, 1440, `Завтра о ${time} засідання`], [S.set.r1h, 60, `Через годину засідання (${time})`]]) {
      const at = t - min * 60000;
      if (on && at > now + 20000) {
        out.push({ id: hash32(`${x.uid}|${min}`) & 0x7fffffff, at, title, body: `${hTitle(x)}\n№ ${x.case}. ${place}` });
      }
    }
  }
  // Дати реагування на документи: за 3 дні, за день і в день строку о 09:00
  if (S.set.rdoc) {
    for (const d of docsOpen()) {
      if (!d.dueD) continue;
      const what = d.act || d.name || 'документ';
      const label = d.dueK === 'p' ? 'строк' : 'дата реагування';
      for (const [days, title] of [[3, `Через 3 дні ${label}: ${what}`], [1, `Завтра ${label}: ${what}`], [0, `Сьогодні ${label}: ${what}`]]) {
        const at = kyivDate(`${dateMinus(d.dueD, days)}T09:00`).getTime();
        if (at > now + 20000) {
          out.push({ id: hash32(`doc|${d.id}|${d.dueD}|${days}`) & 0x7fffffff, at, ch: 'docs', title, body: `${d.name || 'Документ'}\n${d.item ? itemTitle(d.item) + '. ' : ''}${d.case ? `№ ${d.case}. ` : ''}До ${fmtD(d.dueD)}.` });
        }
      }
    }
  }
  return out.sort((a, b) => a.at - b.at);
}
async function scheduleReminders() {
  const list = reminderList();
  if (isNative) {
    try {
      const perm = await LN('checkPermissions');
      S.notif = perm.display;
      if (perm.display !== 'granted') return;
      await LN('createChannel', { id: 'hearings', name: 'Судові засідання', description: 'Нагадування за добу і за годину', importance: 5, visibility: 1, vibration: true });
      await LN('createChannel', { id: 'docs', name: 'Документи і строки', description: 'Нові документи і дати реагування', importance: 5, visibility: 1, vibration: true });
      const pend = await LN('getPending');
      if (pend.notifications && pend.notifications.length) {
        await LN('cancel', { notifications: pend.notifications.map((n) => ({ id: n.id })) });
      }
      if (list.length) {
        await LN('schedule', {
          notifications: list.slice(0, 200).map((n) => ({
            id: n.id, title: n.title, body: n.body, largeBody: n.body, channelId: n.ch || 'hearings',
            schedule: { at: new Date(n.at).toISOString(), allowWhileIdle: true },
          })),
        });
      }
      S.notifCount = Math.min(list.length, 200);
    } catch (e) {
      S.notif = 'error';
      console.warn(e);
    }
    return;
  }
  webTimers.forEach(clearTimeout);
  webTimers = [];
  S.notif = 'Notification' in window ? Notification.permission : 'unsupported';
  if (S.notif !== 'granted') return;
  for (const n of list) {
    const delay = n.at - Date.now();
    if (delay > 24 * 36e5) break;
    webTimers.push(setTimeout(() => new Notification(n.title, { body: n.body, tag: String(n.id) }), delay));
  }
}
async function enableNotifications() {
  if (isNative) {
    const r = await LN('requestPermissions');
    S.notif = r.display;
    try {
      const ex = await LN('checkExactNotificationSetting');
      if (ex.exact_alarm !== 'granted') await LN('changeExactNotificationSetting');
    } catch { /* стара версія Android */ }
  } else if ('Notification' in window) {
    S.notif = await Notification.requestPermission();
  }
  await scheduleReminders();
  render();
}
async function testNotification() {
  if (isNative) {
    await LN('schedule', { notifications: [{ id: 999001, title: 'Перевірка нагадувань', body: 'Нагадування працюють.', channelId: 'hearings', schedule: { at: new Date(Date.now() + 8000).toISOString(), allowWhileIdle: true } }] });
    toast('Сповіщення надійде через 8 секунд. Можна згорнути застосунок.');
  } else if (S.notif === 'granted') {
    setTimeout(() => new Notification('Перевірка нагадувань', { body: 'Нагадування працюють.' }), 3000);
    toast('Сповіщення надійде через 3 секунди.');
  }
}
function downloadIcs(list, name) {
  if (!list.length) return toast('Немає засідань для календаря');
  const blob = new Blob([buildIcs(list, hTitle)], { type: 'text/calendar;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name || 'zasidannia.ics';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 2000);
}

// ---------- Відображення ----------
function statusLine() {
  const m = S.meta;
  let s = '';
  if (S.busy) s = '<span class="spin"></span> Оновлення…';
  else if (m && m.sourceModified) {
    const d = new Date(/Z|[+-]\d\d:?\d\d$/.test(m.sourceModified) ? m.sourceModified : m.sourceModified + 'Z');
    const age = (Date.now() - d.getTime()) / 36e5;
    const txt = isNaN(d) ? '' : d.toLocaleString('uk-UA', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
    s = (txt ? `Дані ДСА від ${h(txt)}` : 'Дані завантажено') + (age > 60 ? ' <span class="warn">(застарілі)</span>' : '');
  }
  if (S.err) s += `<div class="badc">${h(S.err)}</div>`;
  return `<p class="sub">${s}</p>`;
}
function hearingCard(x, opts = {}) {
  const isNew = S.fresh.has(x.uid || rowUid(x));
  const past = x.iso < kyivNowIso();
  const n = dayDiff(x.iso.slice(0, 10));
  return `<button class="card" data-act="${opts.menu ? 'hmenu' : 'open'}" data-uid="${h(x.uid || '')}" data-id="${h(x.item ? x.item.id : '')}" data-case="${h(x.case)}">
    <div class="row"><div class="time">${h(x.iso.slice(11))}${opts.date ? `<div class="m">${h(x.iso.slice(8, 10) + '.' + x.iso.slice(5, 7))}</div>` : ''}</div>
    <div class="grow"><div class="t">${h(opts.title ?? hTitle(x))}</div>
    <div class="m">№ ${h(x.case)}${x.room ? ` · зал ${h(x.room)}` : ''}</div>
    <div class="m">${h(x.court)}</div>
    <div class="m clamp">${h(x.desc)}</div>
    <div style="margin-top:4px">${x.manual ? '<span class="tag man">вручну</span>' : ''}${x.wasManual ? `<span class="tag new">час змінено, вручну було ${h(x.wasManual)}</span>` : ''}${x.clash ? `<span class="tag new">накладка${x.clashBusy ? `: ${h(x.clashBusy)}` : ''}</span>` : ''}${isNew ? '<span class="tag new">нове</span>' : ''}${past ? '<span class="tag past">минуло</span>' : n <= 1 && !opts.noSoon ? `<span class="tag soon">${n === 0 ? 'сьогодні' : 'завтра'}</span>` : ''}${x.item && x.item.t === 'kw' ? `<span class="tag">за запитом: ${h(x.item.query)}</span>` : ''}</div>
    </div></div></button>`;
}
function viewAgenda() {
  const hearings = agenda();
  const clashIso = new Set(hearings.filter((x) => x.clashBusy).map((x) => x.iso.slice(0, 10)));
  const busy = busyList().map((e) => {
    if (!clashIso.has(e.iso.slice(0, 10))) return e;
    const s0 = minOf(e.iso.slice(11));
    const e0 = e.end ? minOf(e.end) : s0 + 80;
    const hit = hearings.some((x) => x.mine && x.iso.slice(0, 10) === e.iso.slice(0, 10) && minOf(x.iso.slice(11)) < e0 && s0 < minOf(x.iso.slice(11)) + 60);
    return hit ? { ...e, clash: true } : e;
  });
  const hasOthers = hearings.some((x) => !x.mine);
  const hasBusy = busy.length > 0;
  let f = S.afilter;
  if ((f === 'mine' && !hasOthers) || (f === 'court' && !hasBusy)) f = 'all';
  let list = hearings;
  if (f === 'mine') list = hearings.filter((x) => x.mine);
  if (f !== 'court') list = list.concat(busy).sort((x, y) => (x.iso < y.iso ? -1 : x.iso > y.iso ? 1 : 0));
  let out = `<div class="head"><h1>Засідання</h1><button class="btn sm" data-act="mh-new">+ Вручну</button><button class="btn sec sm" data-act="refresh" ${S.busy ? 'disabled' : ''}>Оновити</button></div>${statusLine()}`;
  if (hasOthers || hasBusy) {
    out += `<div class="seg"><button data-act="afilter" data-f="all" class="${f === 'all' ? 'on' : ''}">Усе</button>
      ${hasBusy ? `<button data-act="afilter" data-f="court" class="${f === 'court' ? 'on' : ''}">Лише суд</button>` : ''}
      ${hasOthers ? `<button data-act="afilter" data-f="mine" class="${f === 'mine' ? 'on' : ''}">Лише мої</button>` : ''}</div>`;
  }
  const clashes = list.filter((x) => x.clash && !x.busy).length;
  if (clashes) out += `<p class="note badc">Увага: є накладки засідань (${clashes}). Вони позначені у списку.</p>`;
  if (!active().length && !hasBusy) {
    return out + `<div class="empty"><b>Список порожній</b>Додайте справу за номером або запит за учасником чи представником.<div class="btns" style="justify-content:center"><button class="btn" data-act="go-search">Додати справу</button></div></div>`;
  }
  if (!list.length) {
    return out + `<div class="empty"><b>Призначених засідань немає</b>У відкритих даних суду немає майбутніх засідань у ваших справах. Застосунок перевіряє дані під час кожного відкриття.</div>`;
  }
  let day = '';
  for (const x of list) {
    const d = x.iso.slice(0, 10);
    if (d !== day) {
      day = d;
      const l = dayLabel(d);
      out += `<div class="day">${h(l.main)} <small>· ${h(l.rel)}</small></div>`;
    }
    out += x.busy ? busyCard(x) : hearingCard(x, { noSoon: true, menu: true });
  }
  if (S.busyData && S.busyData.at) out += `<p class="note">Розклад пар станом на ${h(fmtDT(S.busyData.at))}.</p>`;
  if (!isNative) out += `<div class="btns"><button class="btn sec" data-act="ics-all">Додати всі засідання в Календар (.ics)</button></div><p class="note">Файл містить нагадування за добу і за годину.</p>`;
  return out;
}
const SORTS = [['next', 'за наступним засіданням'], ['title', 'за назвою'], ['number', 'за номером'], ['added', 'за датою додавання'], ['court', 'за судом'], ['dec', 'за останнім рішенням'], ['stage', 'за датою стадії'], ['esud', 'за останнім документом в Е-суді'], ['status', 'за станом розгляду справи']];
const STATUS_GROUPS = [['appeal', 'Оскарження'], ['active', 'Розглядається'], ['unknown', 'Стан без категорії'], ['stale', 'Давні дані: остання відома стадія'], ['done', 'Розглянуто'], ['final', 'Завершено: рішення набрало законної сили'], ['none', 'Немає даних про стан']];
const statusRank = (cs) => STATUS_GROUPS.findIndex((g) => g[0] === (cs ? cs.code : 'none'));
function sortCases(cases) {
  const now = kyivNowIso();
  const info = cases.map((it) => {
    const rows = it.nh ? [] : itemHearings(it);
    const decs = S.dec[caseBase(it.number)] || [];
    const cards = cardsOf(it);
    const st = cards.find((c) => c.stage || c.result) || cards[0];
    return { it, cs: caseStatus(it), next: rows.find((r) => r.iso >= now), court: rows.length ? rows[rows.length - 1].court : st ? st.court : '', dec: decs.length ? decs[0].recv : '', st };
  });
  const num = (n) => normCase(n).split(/[/-]/).map((x) => (/^\d+$/.test(x) ? x.padStart(7, '0') : x)).join('/');
  const by = {
    next: (a, b) => (a.next ? a.next.iso : '9').localeCompare(b.next ? b.next.iso : '9'),
    title: (a, b) => itemTitle(a.it).localeCompare(itemTitle(b.it), 'uk'),
    number: (a, b) => num(a.it.number).localeCompare(num(b.it.number)),
    added: (a, b) => (b.it.c || 0) - (a.it.c || 0),
    court: (a, b) => (a.court || 'я').localeCompare(b.court || 'я', 'uk') || itemTitle(a.it).localeCompare(itemTitle(b.it), 'uk'),
    dec: (a, b) => (b.dec || '').localeCompare(a.dec || ''),
    stage: (a, b) => ((b.st && b.st.sd) || '').localeCompare((a.st && a.st.sd) || ''),
    esud: (a, b) => ((esOf(b.it) || {}).last || '').localeCompare((esOf(a.it) || {}).last || ''),
    status: (a, b) => statusRank(a.cs) - statusRank(b.cs) || ((a.cs && a.cs.label) || '').localeCompare((b.cs && b.cs.label) || '', 'uk') || ((b.cs && b.cs.date) || '').localeCompare((a.cs && a.cs.date) || ''),
  };
  return info.sort(by[S.set.sort] || by.next);
}
function viewCases() {
  const arch = S.cfilter === 'arch';
  const all = active();
  const nArch = all.filter((i) => i.arch).length;
  const shown = all.filter((i) => !!i.arch === arch);
  const cases = shown.filter((i) => i.t === 'case');
  const kws = shown.filter((i) => i.t === 'kw');
  const now = kyivNowIso();
  let out = `<div class="head"><h1>Справи</h1><button class="btn sm" data-act="go-search">Додати</button></div>
    <div class="seg"><button data-act="cfilter" data-f="live" class="${arch ? '' : 'on'}">Активні (${all.length - nArch})</button><button data-act="cfilter" data-f="arch" class="${arch ? 'on' : ''}">Архів (${nArch})</button></div>`;
  if (cases.length > 1) {
    out += `<label for="sortSel">Сортування</label><select id="sortSel" data-set="sort">${SORTS.map(([v, t]) => `<option value="${v}" ${S.set.sort === v ? 'selected' : ''}>${t}</option>`).join('')}</select>`;
  }
  if (!shown.length) {
    out += arch ? `<div class="empty"><b>Архів порожній</b>Відкрийте справу і натисніть «В архів». Архівні справи не оновлюються і не дають нагадувань.</div>`
      : `<div class="empty"><b>Справ ще немає</b>Знайдіть справу за номером або додайте запит за учасником.</div>`;
  }
  const unreadBy = new Map();
  for (const d of decList()) if (d.unread) unreadBy.set(d.base, (unreadBy.get(d.base) || 0) + 1);
  const docsBy = new Map();
  for (const d of docsOpen()) if (d.item) docsBy.set(d.item.id, (docsBy.get(d.item.id) || 0) + 1);
  const sorted = sortCases(cases);
  let grp = -1;
  for (const { it, next, court, cs } of sorted) {
    if (S.set.sort === 'status' && statusRank(cs) !== grp) {
      grp = statusRank(cs);
      out += `<h2>${h(STATUS_GROUPS[grp][1])} (${sorted.filter((x) => statusRank(x.cs) === grp).length})</h2>`;
    }
    const nu = unreadBy.get(caseBase(it.number)) || 0;
    const nd = docsBy.get(it.id) || 0;
    out += `<button class="card" data-act="open" data-id="${h(it.id)}"><div class="t">${h(itemTitle(it))}</div>
      <div class="m">№ ${h(it.number)}${court ? ` · ${h(court)}` : ''}</div>
      ${arch ? '' : `<div class="m">${it.nh ? 'Засідання не відстежуються' : next ? `Наступне засідання: <b>${h(fmtDT(next.iso))}</b>${next.manual ? ' (вручну)' : ''}` : 'Призначених засідань немає'}</div>`}
      ${statusLineOf(cs)}
      ${esOf(it) ? `<div class="m">Е-суд: останній документ ${h(fmtD(esOf(it).last))}</div>` : ''}
      ${it.note ? `<div class="m clamp">${h(it.note)}</div>` : ''}
      ${nu || nd || esUnread(it) ? `<div style="margin-top:4px">${nu ? `<span class="tag new">нових рішень: ${nu}</span>` : ''}${nd ? `<span class="tag due">документів у роботі: ${nd}</span>` : ''}${esUnread(it) ? '<span class="tag new">новий документ в Е-суді</span>' : ''}</div>` : ''}</button>`;
  }
  if (kws.length) out += `<h2>Запити за учасником або представником</h2>`;
  for (const it of kws) {
    const rows = (S.hearings[it.id] || []).filter((r) => r.iso >= now);
    out += `<button class="card" data-act="open" data-id="${h(it.id)}"><div class="t">${h(it.title || it.query)}</div>
      <div class="m">${it.court ? `Суд: ${h(it.court)} · ` : ''}${arch ? 'в архіві' : `майбутніх засідань: ${rows.length}`}</div></button>`;
  }
  if (!arch) {
    const nc = archCandidates().length;
    out += `<div class="btns">${nc ? `<button class="btn sec" data-act="ac-open">Справи для архіву (${nc})</button>` : ''}<button class="btn sec" data-act="import">Імпорт справ зі старого застосунку</button></div>`;
  }
  return out;
}
function groupByCase(rows) {
  const m = new Map();
  for (const r of rows) {
    const k = normCase(r.case);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return [...m.values()];
}
function viewSearch() {
  const q = S.search;
  const isCase = q.mode === 'case';
  let out = `<div class="head"><h1>Пошук</h1></div>
  <div class="seg"><button data-act="mode" data-mode="case" class="${isCase ? 'on' : ''}">Номер справи</button><button data-act="mode" data-mode="name" class="${isCase ? '' : 'on'}">Учасник або представник</button></div>
  <form data-form="search">
  <input type="search" name="q" autocomplete="off" enterkeyhint="search" placeholder="${isCase ? 'Наприклад: 127/12345/26' : 'Прізвище, імʼя або назва'}" value="${h(q.q)}">
  ${isCase ? '' : `<input type="text" name="court" autocomplete="off" placeholder="Суд або регіон (необовʼязково), наприклад: Вінниц" value="${h(q.court)}">`}
  <button class="btn" ${q.busy ? 'disabled' : ''}>${q.busy ? '<span class="spin"></span> Пошук…' : 'Знайти'}</button>
  </form>`;
  if (q.busy && q.prog) out += `<p class="note">${h(q.prog)}</p>`;
  const res = q.res;
  if (!res) {
    return out + `<p class="note">${isCase
      ? 'Введіть єдиний унікальний номер справи повністю.'
      : 'Пошук працює за полем «учасники» у даних суду. Це поле містить сторони та їхніх представників. Запит шукає початок кожного слова.'}</p>`;
  }
  if (res.error === 'format') return out + `<p class="note warn">Номер має містити код суду і косу риску, наприклад 127/12345/26.</p>`;
  if (res.error === 'short') return out + `<p class="note warn">Введіть слово довжиною від 3 літер.</p>`;
  if (res.error === 'common') return out + `<p class="note warn">Запит містить лише дуже поширені слова. Додайте прізвище або назву.</p>`;
  if (res.error) return out + `<p class="note badc">${h(res.error)}</p>`;
  const now = kyivNowIso();
  const groups = groupByCase(res.rows);
  if (!isCase) {
    const fut = res.rows.filter((r) => r.iso >= now).length;
    out += `<div class="card"><div class="t">Знайдено справ: ${groups.length}, майбутніх засідань: ${fut}</div>
      ${res.truncated ? `<div class="m warn">Збігів дуже багато: близько ${res.totalRows} у ${res.totalShards} судах. Показано частину. Додайте імʼя або вкажіть суд.</div>` : ''}
      <div class="btns"><button class="btn sec" data-act="watch-kw">Стежити за цим запитом</button></div>
      <div class="m">Нові засідання за запитом зʼявлятимуться автоматично.</div></div>`;
  }
  if (!groups.length) {
    out += `<div class="empty"><b>Нічого не знайдено</b>${isCase ? 'У даних суду немає засідань у цій справі за останні пів року і в майбутньому. Справу можна додати, і засідання зʼявиться після призначення.' : 'Перевірте написання або приберіть фільтр суду.'}</div>`;
    if (isCase) out += `<div class="btns"><button class="btn" data-act="watch-case" data-case="${h(q.q.trim())}">Стежити за справою № ${h(q.q.trim())}</button></div>`;
    return out;
  }
  groups.sort((a, b) => {
    const na = a.find((r) => r.iso >= now);
    const nb = b.find((r) => r.iso >= now);
    return (na ? na.iso : 'z' + a[0].iso) < (nb ? nb.iso : 'z' + b[0].iso) ? -1 : 1;
  });
  for (const g of groups.slice(0, 80)) {
    const last = g[g.length - 1];
    const next = g.find((r) => r.iso >= now);
    const num = last.case.split('(')[0];
    const watched = active().some((i) => i.t === 'case' && normCase(i.number) === normCase(num));
    out += `<div class="card"><div class="t">${h(shortParties(last.involved) || '№ ' + last.case)}</div>
      <div class="m">№ ${h(last.case)} · ${h(last.court)}</div>
      <div class="m clamp">${h(last.desc)}</div>
      <div class="m">${next ? `Наступне засідання: <b>${h(fmtDT(next.iso))}</b>${next.room ? `, зал ${h(next.room)}` : ''}` : `Останнє засідання: ${h(fmtDT(last.iso))}`}</div>
      <details><summary class="m">Учасники та суддя</summary><div class="m">${h(last.involved)}</div><div class="m">${h(last.judges)}</div></details>
      <div class="btns">${watched ? '<span class="tag">у вашому списку</span>' : `<button class="btn sm" data-act="watch-case" data-case="${h(num)}">Стежити</button>`}</div></div>`;
  }
  if (groups.length > 80) out += `<p class="note">Показано перші 80 справ. Уточніть запит.</p>`;
  return out;
}
function viewSettings() {
  const st = S.set;
  const nOk = S.notif === 'granted';
  const sync = S.sync.startsWith('ok:') ? `<span class="okc">Синхронізовано о ${new Date(+S.sync.slice(3)).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' })}</span>`
    : S.sync.startsWith('err:') ? `<span class="badc">${h(S.sync.slice(4))}</span>` : syncOn() ? '' : 'Не налаштовано. Список зберігається лише на цьому пристрої.';
  const m = S.meta;
  return `<div class="head"><h1>Налаштування</h1></div>
  <h2>Нагадування</h2>
  <div class="card">
    <div>${nOk ? `<span class="okc">Увімкнено.</span>${isNative && S.notifCount != null ? ` Заплановано сповіщень: ${S.notifCount}.` : ''}` : S.notif === 'denied' ? '<span class="badc">Заборонено в налаштуваннях пристрою.</span>' : 'Вимкнено.'}</div>
    <label class="chk"><input type="checkbox" data-set="r1d" ${st.r1d ? 'checked' : ''}> За добу до засідання</label>
    <label class="chk"><input type="checkbox" data-set="r1h" ${st.r1h ? 'checked' : ''}> За годину до засідання</label>
    <label class="chk"><input type="checkbox" data-set="rdoc" ${st.rdoc ? 'checked' : ''}> Дати реагування на документи: за 3 дні, за день і в день строку о 09:00</label>
    <div class="btns">${nOk ? '' : '<button class="btn" data-act="notif-on">Увімкнути нагадування</button>'}${nOk ? '<button class="btn sec" data-act="notif-test">Перевірити</button>' : ''}</div>
    ${isNative ? '<p class="note">Застосунок планує нагадування під час кожного відкриття. Відкривайте його хоча б раз на кілька днів.</p>'
    : '<p class="note">На компʼютері сповіщення працюють, поки застосунок відкритий. Для надійних нагадувань додайте засідання в Календар (кнопка на сторінці «Засідання»).</p>'}
  </div>
  <h2>Синхронізація між пристроями</h2>
  <div class="card">
    <div class="m">${sync}</div>
    <label>Приватний репозиторій GitHub (власник/назва)</label>
    <input type="text" data-set="repo" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Taras7770/zasidannia-private" value="${h(st.repo)}">
    <label>Ключ доступу (token)</label>
    <input type="password" data-set="token" autocomplete="off" placeholder="github_pat_…" value="${h(st.token)}">
    <div class="btns"><button class="btn sec" data-act="sync">Синхронізувати зараз</button></div>
    <p class="note">Ключ зберігається лише на цьому пристрої. Введіть той самий репозиторій і ключ на телефоні та на компʼютері.</p>
  </div>
  <h2>Дані</h2>
  <div class="card"><div class="kv">
    <span>Джерело</span><span>ДСА України, набір «Список справ призначених до розгляду», <a href="https://data.gov.ua/dataset/3a321301-a06f-487b-9d19-e6b917250aee" target="_blank" rel="noopener">data.gov.ua</a>, CC BY</span>
    <span>Засідань у базі</span><span>${m && m.rows ? m.rows.toLocaleString('uk-UA') : 'немає даних'}</span>
    <span>Останнє засідання</span><span>${m && m.to ? h(fmtDT(m.to)) : ''}</span>
  </div>
  <p class="note">ДСА оновлює набір один раз на добу, вночі. Застосунок завантажує свіжі дані під час кожного відкриття. Дані мають довідковий характер. Перевіряйте дату засідання в суді або в Електронному суді.</p></div>`;
}
function render() {
  const v = S.view;
  $('#view').innerHTML = v === 'agenda' ? viewAgenda() : v === 'dec' ? viewDecisions() : v === 'docs' ? viewDocs() : v === 'cases' ? viewCases() : v === 'search' ? viewSearch() : viewSettings();
  document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
  const nb = $('#badge');
  const cnt = agenda(0).filter((x) => S.fresh.has(x.uid)).length;
  nb.hidden = !cnt;
  nb.textContent = cnt;
  const nd = $('#badgeD');
  const cd = decList().filter((d) => d.unread).length + esList().filter((x) => x.unread && !x.item.arch).length + archEvents().length;
  nd.hidden = !cd;
  nd.textContent = cd;
  const nk = $('#badgeK');
  const ck = docsOpen().length;
  nk.hidden = !ck;
  nk.textContent = ck;
}
// Перемальовує лише списки. Форми пошуку і налаштувань не чіпає, щоб не збити введення.
function softRender() {
  if ($('#dlg').open) return;
  if (S.view === 'agenda' || S.view === 'cases' || S.view === 'dec' || S.view === 'docs') render();
}
function setView(view) {
  if (S.view === 'agenda' && view !== 'agenda' && S.fresh.size) {
    S.fresh.clear();
    save();
  }
  S.view = view;
  render();
  window.scrollTo(0, 0);
}
// Навігація записується в історію: жест «назад» повертає до засідань і закриває вікно справи
function go(view) {
  if (view === S.view) return render();
  const st = history.state;
  if (view === 'agenda') {
    if (st && st.view) return history.back();
    return setView('agenda');
  }
  if (st && st.view) history.replaceState({ view }, '');
  else history.pushState({ view }, '');
  setView(view);
}
function showDlg(sheet) {
  const d = $('#dlg');
  d.classList.toggle('sheet', !!sheet);
  if (!d.open) {
    d.showModal();
    history.pushState({ dlg: 1, view: S.view === 'agenda' ? undefined : S.view }, '');
  }
  d.scrollTop = 0;
}
window.addEventListener('popstate', (e) => {
  const d = $('#dlg');
  if (d.open) {
    d.close();
    return;
  }
  setView((e.state && e.state.view) || 'agenda');
});

// ---------- Вікно справи ----------
const decX = {};
function openItem(id) {
  const it = S.items.find((i) => i.id === id && !i.del);
  if (!it) return;
  const now = kyivNowIso();
  let rows = it.t === 'case' ? itemHearings(it) : S.hearings[it.id] || [];
  let body;
  if (it.t === 'case') {
    const hc = (r) => hearingCard({ ...r, item: null }, { date: true, title: dayLabel(r.iso.slice(0, 10)).main })
      + (r.manual ? `<div class="btns" style="margin:-4px 0 12px"><button class="btn danger sm" data-act="mh-del" data-mid="${h(r.mid)}">Видалити цей запис</button></div>` : '');
    const hidden = S.mh.filter((m) => !m.del && m.item === it.id && !rows.some((r) => r.mid === m.id));
    const fut = rows.filter((r) => r.iso >= now);
    const past = rows.filter((r) => r.iso < now).reverse();
    const last = rows.filter((r) => r.involved).pop() || rows[rows.length - 1];
    const cards = cardsOf(it);
    const cardParts = (cards.filter((c) => c.parts).sort((x, y) => y.parts.length - x.parts.length)[0] || {}).parts || '';
    const stan = cards.length
      ? cards.map((c) => `<div class="card"><div class="t">${h(c.stage || c.result || 'Стадію не вказано')}${c.sd ? ` · ${h(fmtD(c.sd))}` : ''}</div>
          <div class="m">${h(c.court)}${c.proc ? ` · провадження № ${h(c.proc)}` : ''}</div>
          ${c.result && c.stage ? `<div class="m">Результат: ${h(c.result)}</div>` : ''}
          ${c.type ? `<div class="m">${h(c.type)}</div>` : ''}
          <div class="m">${c.judge ? `${h(c.judge)} · ` : ''}${c.reg ? `зареєстровано ${h(fmtD(c.reg))}` : ''}</div>
          ${c.desc ? `<div class="m clamp">${h(c.desc)}</div>` : ''}</div>`).join('')
      : `<p class="note">${!syncOn() ? 'Стадія та учасники для справ без засідань доступні після налаштування синхронізації.'
        : !S.cards ? 'Дані про стадію ще готуються. Вони зʼявляться приблизно за хвилину після додавання справи.'
          : 'У базі стану розгляду цієї справи ще немає.'}</p>`;
    const stanNote = S.cards && cards !== null ? `<p class="note">Дані ДСА про стан розгляду: файли від ${h(fmtD(S.cards.oldest))} до ${h(fmtD(S.cards.newest))}.${S.cards.remaining ? ' База ще наповнюється старішими даними.' : ''}</p>` : '';
    const baseline = it.rb || dateMinus(new Date(it.c || Date.now()).toISOString().slice(0, 10), 7);
    // Рішення архівних і щойно доданих справ завантажуємо під час відкриття вікна
    const dbase = caseBase(it.number);
    const tracked = dbase in S.dec;
    if (!tracked && dbase && !(dbase in decX)) {
      decX[dbase] = null;
      dc.decisions(dbase).then((rows) => {
        decX[dbase] = (rows || []).slice(0, 60);
        if (S.openId === it.id && $('#dlg').open) {
          const top = $('#dlg').scrollTop;
          openItem(it.id);
          $('#dlg').scrollTop = top;
        }
      }).catch(() => {
        delete decX[dbase];
      });
    }
    const decLoading = !tracked && decX[dbase] === null;
    const decs = ((tracked ? S.dec[dbase] : decX[dbase]) || []).map((d) => ({ ...d, unread: !it.arch && tracked && isUnread(d, baseline) }));
    const caseDocs = docList().filter((d) => d.item && d.item.id === it.id).sort(byRecv);
    body = `<div class="dh"><h1>${h(itemTitle(it))}</h1><button class="x" data-act="close" aria-label="Закрити">×</button></div>
      <div class="m">Справа № ${h(it.number)} <button class="btn ghost sm" data-act="copy" data-text="${h(it.number)}">копіювати</button></div>
      <label>Власна назва справи</label><input type="text" data-item="${h(it.id)}" data-field="title" placeholder="${h(itemTitle({ ...it, title: '' }))}" value="${h(it.title || '')}">
      <label>Нотатка</label><textarea rows="2" data-item="${h(it.id)}" data-field="note">${h(it.note || '')}</textarea>
      <label class="chk"><input type="checkbox" data-item="${h(it.id)}" data-field="nh" data-inv="1" ${it.nh ? '' : 'checked'}> Стежити за засіданнями цієї справи</label>
      <h2>Майбутні засідання</h2>${fut.length ? fut.map(hc).join('') : '<p class="note">Призначених засідань немає.</p>'}
      <form data-form="mh" data-id="${h(it.id)}" class="card">
        <div class="t">Додати засідання вручну</div>
        <div class="row" style="margin-top:8px"><input type="date" name="d" required min="${h(kyivToday())}" aria-label="Дата"><input type="time" name="t" required value="10:00" step="300" aria-label="Час"></div>
        <input type="text" name="note" maxlength="120" placeholder="Примітка: зал, суддя, що погоджено">
        <button class="btn sm">Додати</button>
        <p class="note">Запис зникне зі списку сам, коли суд внесе засідання на той самий день.</p>
      </form>
      ${hidden.length ? `<p class="note">Ручних записів, які суд уже підтвердив: ${hidden.length}. ${hidden.map((m) => `<button class="btn ghost sm" data-act="mh-del" data-mid="${h(m.id)}">видалити ${h(fmtDT(m.iso))}</button>`).join(' ')}</p>` : ''}
      ${past.length ? `<h2>Історія засідань (${past.length})</h2>${past.map(hc).join('')}` : ''}
      <h2>Судові рішення${decs.length ? ` (${decs.length})` : ''}</h2>${decs.length ? decs.map((d) => decCard(d, { noTitle: true })).join('') : decLoading ? '<p class="note">Завантажую рішення з реєстру…</p>' : `<p class="note">У реєстрі немає рішень у цій справі${S.decMeta ? ` з ${h(fmtD(S.decMeta.from))}` : ''}.</p>`}
      <p class="note">Застосунок має рішення${S.decMeta ? ` з ${h(fmtD(S.decMeta.from))}` : ''}. Старіші рішення шукайте в реєстрі за номером справи.</p>
      <div class="btns"><a class="btn sec sm" href="https://reyestr.court.gov.ua/" target="_blank" rel="noopener" data-act="copy" data-text="${h(it.number)}">Пошук у реєстрі (номер буде скопійовано)</a></div>
      <div class="btns"><a class="btn sec sm" href="https://court.gov.ua/fair/" target="_blank" rel="noopener" data-act="copy" data-text="${h(it.number)}">Стан розгляду на court.gov.ua (номер буде скопійовано)</a></div>
      ${caseDocs.length ? `<h2>Документи (${caseDocs.length})</h2>${caseDocs.slice(0, 40).map((d) => docCard(d, { noTitle: true })).join('')}` : ''}
      ${esOf(it) ? `<h2>Електронний суд</h2><div class="card"><div class="t">Останній документ: ${h(fmtD(esOf(it).last))} ${esUnread(it) ? '<span class="tag new">нове</span>' : ''}</div>
        <div class="m">Перший документ: ${h(fmtD(esOf(it).first))}${esOf(it).role ? ` · ${h(esOf(it).role)}` : ''}</div>
        <div class="m">Дані кабінету станом на ${h(fmtDT(S.esud.at))}</div>
        <div class="btns"><a class="btn sec sm" href="https://cabinet.court.gov.ua/cases" target="_blank" rel="noopener" data-act="copy" data-text="${h(it.number)}">Відкрити Електронний суд</a>${esUnread(it) ? `<button class="btn ghost sm" data-act="es-read" data-id="${h(it.id)}">Прочитано</button>` : ''}</div></div>` : ''}
      <h2>Стан розгляду</h2>${stan}${stanNote}
      ${(last && last.involved) || cardParts ? `<h2>Учасники</h2><div class="card m">${h((last && last.involved) || cardParts)}</div>` : ''}
      ${last && last.judges ? `<h2>Склад суду</h2><div class="card m">${h(last.judges)}</div>` : ''}
      <div class="btns">${!isNative && fut.length ? `<button class="btn sec" data-act="ics-item" data-id="${h(it.id)}">У Календар (.ics)</button>` : ''}<button class="btn sec" data-act="arch" data-id="${h(it.id)}">${it.arch ? 'Повернути з архіву' : 'В архів'}</button><button class="btn danger" data-act="del" data-id="${h(it.id)}">Видалити зі списку</button></div>
      <button class="btn wide" data-act="close">Закрити</button>`;
  } else {
    const fut = rows.filter((r) => r.iso >= now);
    body = `<div class="dh"><h1>${h(it.query)}</h1><button class="x" data-act="close" aria-label="Закрити">×</button></div>
      <div class="m">Запит за учасником або представником${it.court ? `. Суд: ${h(it.court)}` : ''}</div>
      <label class="chk"><input type="checkbox" data-item="${h(it.id)}" data-field="ag" ${it.ag === false ? '' : 'checked'}> Показувати в розділі «Засідання»</label>
      <label class="chk"><input type="checkbox" data-item="${h(it.id)}" data-field="rm" ${it.rm === false ? '' : 'checked'}> Це мої засідання: нагадувати і перевіряти накладки</label>
      <p class="note">Для засідань колеги зніміть другу позначку. Тоді вони будуть видні у списку, але без нагадувань.</p>
      <h2>Майбутні засідання (${fut.length})</h2>
      ${fut.length ? fut.slice(0, 100).map((r) => hearingCard({ ...r, item: null }, { date: true }) + `<div class="btns" style="margin:-4px 0 12px"><button class="btn ghost sm" data-act="watch-case" data-case="${h(r.case.split('(')[0])}">Стежити за справою окремо</button></div>`).join('') : '<p class="note">Майбутніх засідань немає.</p>'}
      <div class="btns"><button class="btn sec" data-act="arch" data-id="${h(it.id)}">${it.arch ? 'Повернути з архіву' : 'В архів'}</button><button class="btn danger" data-act="del" data-id="${h(it.id)}">Видалити запит</button></div>
      <button class="btn wide" data-act="close">Закрити</button>`;
  }
  $('#dlgBody').innerHTML = body;
  S.openId = it.id;
  showDlg();
}
function closeDlg() {
  const d = $('#dlg');
  if (!d.open) return render();
  if (history.state && history.state.dlg) history.back();
  else d.close();
}


// ---------- Меню засідання (натискання на засідання у розділі «Засідання») ----------
function openHearingMenu(uid) {
  const x = agenda().find((y) => y.uid === uid);
  if (!x) return;
  const it = x.item;
  const isCase = it.t === 'case';
  const d = x.iso.slice(0, 10);
  let btns = '';
  if (isCase) {
    btns += `<button class="mi" data-act="open" data-id="${h(it.id)}"><b>Відкрити справу</b><small>Рішення, стадія, учасники, історія</small></button>
      <button class="mi" data-act="hm-add"><b>Додати наступне засідання</b><small>Дата, яку суд погодив під час відкладення</small></button>
      <form data-form="mh" data-id="${h(it.id)}" data-sheet="1" class="card" id="hmForm" hidden>
        <div class="row"><input type="date" name="d" required min="${h(kyivToday())}" aria-label="Дата"><input type="time" name="t" required value="${h(x.iso.slice(11))}" step="300" aria-label="Час"></div>
        <input type="text" name="note" maxlength="120" placeholder="Примітка: зал, суддя, що погоджено">
        <button class="btn wide" style="margin-top:4px">Додати засідання</button>
      </form>
      ${x.manual ? `<button class="mi bad" data-act="mh-del" data-mid="${h(x.mid)}"><b>Видалити цей запис</b><small>Засідання введено вручну</small></button>` : ''}
      <button class="mi" data-act="hm-nh" data-id="${h(it.id)}"><b>Не стежити за засіданнями справи</b><small>Справа залишиться у списку. Рішення надходитимуть.</small></button>`;
  } else {
    btns += `<button class="mi" data-act="watch-case" data-case="${h(x.case.split('(')[0])}"><b>Стежити за цією справою</b><small>Додати справу до мого списку</small></button>
      <button class="mi" data-act="open" data-id="${h(it.id)}"><b>Відкрити запит «${h(it.query)}»</b><small>Усі засідання за цим запитом</small></button>`;
  }
  $('#dlgBody').innerHTML = `<div class="dh"><h1>${h(hTitle(x))}</h1><button class="x" data-act="close" aria-label="Закрити">×</button></div>
    <div class="m"><b>${h(dayLabel(d).main)}, ${h(x.iso.slice(11))}</b></div>
    <div class="m">№ ${h(x.case)}${x.room ? ` · зал ${h(x.room)}` : ''}</div>
    <div class="m">${h(x.court)}</div>
    ${x.desc ? `<div class="m clamp">${h(x.desc)}</div>` : ''}
    <div class="menu">${btns}</div>
    <button class="btn sec wide" data-act="close">Закрити</button>`;
  S.openId = null;
  showDlg(true);
}

// ---------- Нове засідання вручну (з вибором справи) ----------
function openManual() {
  const cases = live().filter((i) => i.t === 'case').map((it) => ({ it, title: itemTitle(it) }))
    .sort((a, b) => a.title.localeCompare(b.title, 'uk'));
  $('#dlgBody').innerHTML = `<div class="dh"><h1>Засідання вручну</h1><button class="x" data-act="close" aria-label="Закрити">×</button></div>
    ${cases.length ? `<form data-form="mh">
      <label for="mhItem">Справа</label>
      <select id="mhItem" name="item" required>${cases.map(({ it, title }) => `<option value="${h(it.id)}">${h(title.slice(0, 60))} · № ${h(it.number)}</option>`).join('')}</select>
      <label>Дата і час</label>
      <div class="row"><input type="date" name="d" required min="${h(kyivToday())}" aria-label="Дата"><input type="time" name="t" required value="10:00" step="300" aria-label="Час"></div>
      <label>Примітка</label>
      <input type="text" name="note" maxlength="120" placeholder="Зал, суддя, що погоджено">
      <button class="btn wide">Додати засідання</button>
    </form>` : '<p class="note">Спочатку додайте справу до списку.</p>'}
    <button class="btn sec wide" data-act="close">Закрити</button>`;
  S.openId = null;
  showDlg();
}
function submitManual(f) {
  const itemId = f.dataset.id || (f.item && f.item.value);
  const it = S.items.find((i) => i.id === itemId);
  if (!it || !f.d.value || !f.t.value) return;
  const iso = `${f.d.value}T${f.t.value.slice(0, 5)}`;
  if (it.nh) updateItem(it.id, { nh: false });
  addManual(it.id, iso, f.note.value.trim());
  const near = agenda(0).filter((x) => x.mine && x.clash && x.iso.slice(0, 10) === iso.slice(0, 10) && normCase(x.case) !== normCase(it.number));
  toast(near.length ? `Додано. Увага: накладка з засіданням о ${near[0].iso.slice(11)}` : 'Засідання додано');
  scheduleReminders();
  if (f.dataset.id && !f.dataset.sheet) openItem(it.id);
  else closeDlg();
}

// ---------- Імпорт справ ----------
const IMP = { found: [], src: '' };
function openImport() {
  IMP.found = [];
  IMP.src = '';
  renderImport();
  showDlg();
}
function renderImport() {
  const have = new Set(active().filter((i) => i.t === 'case').map((i) => normCase(i.number)));
  const fresh = IMP.found.filter((n) => !have.has(normCase(n)));
  $('#dlgBody').innerHTML = `<div class="dh"><h1>Імпорт справ</h1><button class="x" data-act="close" aria-label="Закрити">×</button></div>
    <p class="note">Застосунок шукає номери справ у файлі або в тексті. Підходить файл експорту зі старого застосунку (Excel), таблиця, документ Word або будь-який текст з номерами.</p>
    <label>Файл (xlsx, docx, csv, txt)</label>
    <input type="file" id="impFile" accept=".xlsx,.docx,.ods,.csv,.txt,.json,.html,.xml,text/*,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet">
    <label>Або вставте текст з номерами справ</label>
    <textarea id="impText" rows="4" placeholder="127/12345/26, 902/44/26 …"></textarea>
    <div class="btns"><button class="btn sec" data-act="imp-scan">Знайти номери</button></div>
    ${IMP.src ? `<h2>Знайдено номерів: ${IMP.found.length}${IMP.found.length !== fresh.length ? `, нових: ${fresh.length}` : ''}</h2>` : ''}
    ${fresh.map((n) => `<label class="chk"><input type="checkbox" class="impN" value="${h(n)}" checked> ${h(n)}</label>`).join('')}
    ${IMP.src && !IMP.found.length ? '<p class="note warn">Номерів справ не знайдено. Номер має вигляд 127/12345/26.</p>' : ''}
    ${fresh.length ? `<div class="btns"><button class="btn" data-act="imp-add">Додати вибрані справи</button></div>` : ''}`;
}
async function importScan() {
  const f = $('#impFile').files[0];
  let text = $('#impText').value;
  try {
    if (f) text += '\n' + (await fileToText(await f.arrayBuffer()));
  } catch (e) {
    return toast('Не вдалося прочитати файл: ' + e.message);
  }
  if (!text.trim()) return toast('Виберіть файл або вставте текст');
  IMP.found = extractCaseNumbers(text);
  IMP.src = 'x';
  renderImport();
}
async function importAdd() {
  const nums = [...document.querySelectorAll('.impN:checked')].map((x) => x.value);
  if (!nums.length) return;
  const items = nums.map((n) => addItem({ t: 'case', number: n }));
  S.view = 'cases';
  closeDlg();
  toast(`Додано справ: ${items.length}. Завантажую засідання…`);
  cardsSoon();
  await refreshAll({ force: true });
}

// ---------- Пошук ----------
async function runSearch() {
  const q = S.search;
  if (!q.q.trim()) return;
  q.busy = true;
  q.res = null;
  q.prog = '';
  render();
  try {
    if (q.mode === 'case') q.res = await dc.findCase(q.q);
    else {
      q.res = await dc.findName(q.q, {
        court: q.court,
        onProgress: (a, b) => {
          q.prog = `Перевірено судів: ${a} з ${b}`;
          const n = $('#view .note');
          if (n && S.view === 'search') n.textContent = q.prog;
        },
      });
    }
  } catch (e) {
    q.res = { rows: [], error: navigator.onLine === false ? 'Немає звʼязку з інтернетом.' : e.message };
  }
  q.busy = false;
  render();
}
async function watchCase(number) {
  const it = addItem({ t: 'case', number: number.trim() });
  toast(`Справу № ${it.number} додано до списку`);
  cardsSoon();
  try {
    await refreshItem(it);
    save();
    await scheduleReminders();
  } catch { /* оновиться пізніше */ }
  render();
}
async function watchKw() {
  const q = S.search;
  const it = addItem({ t: 'kw', query: q.q.trim(), court: q.court.trim() });
  toast('Запит додано до списку');
  try {
    await refreshItem(it);
    save();
    await scheduleReminders();
  } catch { /* оновиться пізніше */ }
  go('cases');
}

// ---------- Події ----------
document.addEventListener('click', async (e) => {
  const nav = e.target.closest('#nav button');
  if (nav) return go(nav.dataset.view);
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const a = el.dataset.act;
  if (a === 'refresh') refreshAll();
  else if (a === 'mh-new') openManual();
  else if (a === 'mh-del') {
    removeManual(el.dataset.mid);
    scheduleReminders();
    toast('Запис видалено');
    if ($('#dlg').open && S.openId) openItem(S.openId);
    else if ($('#dlg').open) closeDlg();
    else render();
  } else if (a === 'hmenu') openHearingMenu(el.dataset.uid);
  else if (a === 'hm-add') {
    const f = $('#hmForm');
    f.hidden = !f.hidden;
    if (!f.hidden) f.d.focus();
  } else if (a === 'hm-nh') {
    updateItem(el.dataset.id, { nh: true });
    scheduleReminders();
    closeDlg();
    toast('Засідання цієї справи більше не показуються. Повернути можна у вікні справи.');
  } else if (a === 'afilter') {
    S.afilter = el.dataset.f;
    render();
  }
  else if (a === 'go-search') go('search');
  else if (a === 'mode') {
    if (S.search.mode !== el.dataset.mode) S.search.q = '';
    S.search.mode = el.dataset.mode;
    S.search.res = null;
    render();
    const inp = $('#view input[name=q]');
    if (inp) inp.focus();
  } else if (a === 'open') {
    if (el.dataset.id) openItem(el.dataset.id);
  } else if (a === 'close') closeDlg();
  else if (a === 'copy') {
    try {
      await navigator.clipboard.writeText(el.dataset.text);
      toast('Скопійовано');
    } catch { /* без доступу до буфера */ }
  } else if (a === 'del') {
    if (confirm('Видалити зі списку?')) {
      removeItem(el.dataset.id);
      closeDlg();
      scheduleReminders();
    }
  } else if (a === 'watch-case') {
    await watchCase(el.dataset.case);
    if ($('#dlg').open) closeDlg();
  } else if (a === 'watch-kw') watchKw();
  else if (a === 'ics-all') downloadIcs(agenda(0));
  else if (a === 'ics-item') {
    const it = S.items.find((i) => i.id === el.dataset.id);
    const now = kyivNowIso();
    downloadIcs(itemHearings(it).filter((r) => r.iso >= now).map((r) => ({ ...r, item: it })), `sprava-${it.number.replace(/\W+/g, '-')}.ics`);
  } else if (a === 'arch') {
    const it = S.items.find((i) => i.id === el.dataset.id);
    if (!it) return;
    const toArch = !it.arch;
    if (toArch) S.aw[esKey(it.number)] = kyivToday();
    updateItem(it.id, { arch: toArch });
    save();
    closeDlg();
    toast(toArch ? 'Справу перенесено в архів' : 'Справу повернуто з архіву');
    if (toArch) scheduleReminders();
    else refreshAll({ force: true });
  } else if (a === 'cfilter') {
    S.cfilter = el.dataset.f;
    render();
  } else if (a === 'dec-open' || a === 'dec-read') {
    markRead(el.dataset.id, el.dataset.recv);
    setTimeout(() => {
      if ($('#dlg').open && S.openId) openItem(S.openId);
      else render();
    }, a === 'dec-open' ? 400 : 0);
  } else if (a === 'ac-open') openArchCandidates();
  else if (a === 'ac-arch' || a === 'ac-all') {
    const list = a === 'ac-all' ? archCandidates().filter((x) => x.st.code === el.dataset.g).map((x) => x.it) : [S.items.find((i) => i.id === el.dataset.id)].filter(Boolean);
    const top = $('#dlg').scrollTop;
    for (const it of list) toArchive(it);
    save();
    scheduleReminders();
    openArchCandidates();
    $('#dlg').scrollTop = top;
    toast(`Перенесено в архів: ${list.length}`);
  } else if (a === 'aw-read') {
    const it = S.items.find((i) => i.id === el.dataset.id);
    if (it) {
      S.aw[esKey(it.number)] = kyivToday();
      if (esOf(it)) S.es.seen[esKey(it.number)] = esOf(it).last;
      save();
      syncSoon();
    }
    render();
  } else if (a === 'es-missing') openEsMissing();
  else if (a === 'es-add') {
    const arch = !!el.dataset.arch;
    const top = $('#dlg').scrollTop;
    esAdd([el.dataset.k], arch);
    openEsMissing();
    $('#dlg').scrollTop = top;
    toast(arch ? 'Справу додано в архів.' : 'Справу додано. Дані завантажаться під час оновлення.');
  } else if (a === 'es-add-all') {
    const arch = !!el.dataset.arch;
    const n = esAdd(esMissing().map((x) => x.k), arch);
    closeDlg();
    toast(arch ? `Додано в архів: ${n}` : `Додано справ: ${n}`);
    cardsSoon();
    if (arch) render();
    else refreshAll({ force: true });
  } else if (a === 'es-read') {
    const it = S.items.find((i) => i.id === el.dataset.id);
    if (it) esMark(it);
    if ($('#dlg').open && S.openId) openItem(S.openId);
    else render();
  } else if (a === 'doc-open') openDoc(el.dataset.id);
  else if (a === 'doc-done' || a === 'doc-skip' || a === 'doc-reopen') {
    setMark(el.dataset.id, { s: a === 'doc-done' ? 'done' : a === 'doc-skip' ? 'skip' : 'open' });
    toast(a === 'doc-done' ? 'Позначено виконаним' : a === 'doc-skip' ? 'Позначено: реакція не потрібна' : 'Документ повернуто в роботу');
    if ($('#dlg').open) closeDlg();
    else render();
  } else if (a === 'dfilter') {
    S.dfilter = el.dataset.f;
    render();
  } else if (a === 'dec-all') markAllRead();
  else if (a === 'import') openImport();
  else if (a === 'imp-scan') importScan();
  else if (a === 'imp-add') importAdd();
  else if (a === 'notif-on') enableNotifications();
  else if (a === 'notif-test') testNotification();
  else if (a === 'sync') {
    el.disabled = true;
    await syncNow();
    await refreshAll({ force: true });
    render();
  }
});
document.addEventListener('submit', (e) => {
  const mf = e.target.closest('[data-form=mh]');
  if (mf) {
    e.preventDefault();
    submitManual(mf);
    return;
  }
  const f = e.target.closest('[data-form=search]');
  if (!f) return;
  e.preventDefault();
  S.search.q = f.q.value;
  S.search.court = f.court ? f.court.value : '';
  runSearch();
});
document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset.set) {
    S.set[t.dataset.set] = t.type === 'checkbox' ? t.checked : t.value.trim();
    save();
    if (t.type === 'checkbox') scheduleReminders();
    if (t.dataset.set === 'sort') render();
  } else if (t.dataset.item) {
    let val = t.type === 'checkbox' ? t.checked : t.value.trim();
    if (t.dataset.inv) val = !val;
    updateItem(t.dataset.item, { [t.dataset.field]: val });
    if (['ag', 'rm', 'nh'].includes(t.dataset.field)) scheduleReminders();
  } else if (t.dataset.doc) {
    setMark(t.dataset.doc, { [t.dataset.field]: t.value.trim() });
    if (t.dataset.field === 'due') openDoc(t.dataset.doc);
  }
});
$('#dlg').addEventListener('click', (e) => {
  if (e.target === $('#dlg')) closeDlg();
});
$('#dlg').addEventListener('close', () => {
  S.openId = null;
  if (history.state && history.state.dlg) history.back();
  render();
});

// Запасний відступ під рядок стану Android, якщо система не повідомила його розмір
if (isNative) {
  setTimeout(() => {
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;visibility:hidden;padding-top:var(--safe-area-inset-top, env(safe-area-inset-top, 0px))';
    document.body.appendChild(probe);
    const px = parseFloat(getComputedStyle(probe).paddingTop) || 0;
    probe.remove();
    if (px < 1) document.documentElement.style.setProperty('--safe-area-inset-top', '36px');
  }, 700);
}

// Оновлення під час кожного відкриття або повернення до застосунку
let lastRefresh = 0;
function autoRefresh() {
  if (Date.now() - lastRefresh < 60000) return;
  lastRefresh = Date.now();
  refreshAll();
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') autoRefresh();
});
window.addEventListener('online', autoRefresh);

// Android: жест або кнопка «назад» закриває вікно справи, потім повертає до засідань, потім згортає застосунок
if (isNative && cap.addListener) {
  try {
    cap.addListener('App', 'backButton', () => {
      if ($('#dlg').open) closeDlg();
      else if (S.view !== 'agenda') go('agenda');
      else cap.nativePromise('App', 'minimizeApp').catch(() => {});
    });
  } catch { /* стара версія APK без модуля App */ }
}

render();
autoRefresh();
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
