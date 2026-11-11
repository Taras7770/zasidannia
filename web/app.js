import {
  DataClient, normCase, normText, tokenize, kyivDate, kyivToday, kyivNowIso, hearingUid, hash32,
  mergeItems, sameItems, utf8ToB64, b64ToUtf8, buildIcs, extractCaseNumbers, fileToText,
  caseBase, mergeRead, reviewUrl,
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
  set: Object.assign({ repo: '', token: '', r1d: true, r1h: true, sort: 'next' }, LS.get('ct.set', {})),
  dec: LS.get('ct.dec', {}),
  rd: Object.assign({ ra: '', read: {} }, LS.get('ct.rd', {})),
  decMeta: LS.get('ct.decmeta', null),
  cfilter: 'live',
  cards: LS.get('ct.cards', null),
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
        S.items = merged;
        S.rd = rd;
        save();
        const ok1 = (sameItems(merged, remoteItems) && !legacy) || (await ghPutJson('watch.json', { v: 1, items: merged }, w.sha, 'Оновлення списку справ'));
        const ok2 = sameItems(rd, remoteRd) || (await ghPutJson('state.json', { v: 1, ra: rd.ra, read: rd.read }, st.sha, 'Позначки прочитання'));
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
// ---------- Стан розгляду справ (cards.json у приватному репозиторії) ----------
async function loadCards() {
  if (!syncOn()) return;
  try {
    const r = await fetch(ghUrl('cards.json') + `?t=${Date.now()}`, { headers: { ...ghHeaders(), Accept: 'application/vnd.github.raw+json' }, cache: 'no-store' });
    if (r.status === 404) return;
    if (!r.ok) return;
    const j = await r.json();
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
    await scheduleReminders();
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
    ${d.unread ? `<button class="btn ghost sm" data-act="dec-read" data-id="${d.id}" data-recv="${h(d.recv)}">Прочитано</button>` : ''}</div></div>`;
}
function viewDecisions() {
  const list = decList();
  const unread = list.filter((d) => d.unread);
  const since = dateMinus(kyivToday(), 90);
  const rest = list.filter((d) => !d.unread && d.recv >= since);
  let out = `<div class="head"><h1>Рішення</h1><button class="btn sec sm" data-act="dec-all" ${unread.length ? '' : 'disabled'}>Усі прочитані</button></div>`;
  if (!S.decMeta) return out + `<div class="empty"><b>Даних про рішення ще немає</b>Застосунок завантажить їх під час наступного оновлення.</div>`;
  out += `<p class="sub">Нові рішення та прочитані за останні 90 днів. Усі рішення з ${h(fmtD(S.decMeta.from))} є у вікні справи. ДСА публікує ці дані із затримкою 1-3 дні.</p>`;
  if (!unread.length && !rest.length) return out + `<div class="empty"><b>Нових рішень немає</b>Старіші рішення відкрийте у вікні справи.</div>`;
  if (unread.length) out += `<h2>Нові (${unread.length})</h2>` + unread.map((d) => decCard(d)).join('');
  if (rest.length) out += `<h2>Прочитані</h2>` + rest.slice(0, 150).map((d) => decCard(d)).join('');
  return out;
}

function agenda(includePastHours = 3) {
  const from = kyivNowIso(Date.now() - includePastHours * 36e5);
  const map = new Map();
  for (const it of live()) {
    if (it.t === 'kw' && it.ag === false) continue;
    for (const r of S.hearings[it.id] || []) {
      if (r.iso < from) continue;
      const u = hearingUid(r);
      const prev = map.get(u);
      if (!prev || (prev.item.t === 'kw' && it.t === 'case')) map.set(u, { ...r, uid: u, item: it });
    }
  }
  // якщо справа є у списку, беремо її назву і для збігів за учасником
  const byCase = new Map(live().filter((i) => i.t === 'case').map((i) => [normCase(i.number), i]));
  const out = [...map.values()].map((x) => {
    const ci = byCase.get(normCase(x.case).split('(')[0]);
    return ci ? { ...x, item: ci } : x;
  });
  return out.sort((a, b) => (a.iso < b.iso ? -1 : a.iso > b.iso ? 1 : 0));
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
  for (const x of agenda(0).slice(0, 150)) {
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
      const pend = await LN('getPending');
      if (pend.notifications && pend.notifications.length) {
        await LN('cancel', { notifications: pend.notifications.map((n) => ({ id: n.id })) });
      }
      if (list.length) {
        await LN('schedule', {
          notifications: list.slice(0, 200).map((n) => ({
            id: n.id, title: n.title, body: n.body, largeBody: n.body, channelId: 'hearings',
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
  const isNew = S.fresh.has(x.uid || hearingUid(x));
  const past = x.iso < kyivNowIso();
  const n = dayDiff(x.iso.slice(0, 10));
  return `<button class="card" data-act="open" data-id="${h(x.item ? x.item.id : '')}" data-case="${h(x.case)}">
    <div class="row"><div class="time">${h(x.iso.slice(11))}${opts.date ? `<div class="m">${h(x.iso.slice(8, 10) + '.' + x.iso.slice(5, 7))}</div>` : ''}</div>
    <div class="grow"><div class="t">${h(opts.title ?? hTitle(x))}</div>
    <div class="m">№ ${h(x.case)}${x.room ? ` · зал ${h(x.room)}` : ''}</div>
    <div class="m">${h(x.court)}</div>
    <div class="m clamp">${h(x.desc)}</div>
    <div style="margin-top:4px">${isNew ? '<span class="tag new">нове</span>' : ''}${past ? '<span class="tag past">минуло</span>' : n <= 1 && !opts.noSoon ? `<span class="tag soon">${n === 0 ? 'сьогодні' : 'завтра'}</span>` : ''}${x.item && x.item.t === 'kw' ? `<span class="tag">за запитом: ${h(x.item.query)}</span>` : ''}</div>
    </div></div></button>`;
}
function viewAgenda() {
  const list = agenda();
  let out = `<div class="head"><h1>Засідання</h1><button class="btn sec sm" data-act="refresh" ${S.busy ? 'disabled' : ''}>Оновити</button></div>${statusLine()}`;
  if (!active().length) {
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
    out += hearingCard(x, { noSoon: true });
  }
  if (!isNative) out += `<div class="btns"><button class="btn sec" data-act="ics-all">Додати всі засідання в Календар (.ics)</button></div><p class="note">Файл містить нагадування за добу і за годину.</p>`;
  return out;
}
const SORTS = [['next', 'за наступним засіданням'], ['title', 'за назвою'], ['number', 'за номером'], ['added', 'за датою додавання'], ['court', 'за судом'], ['dec', 'за останнім рішенням'], ['stage', 'за датою стадії']];
function sortCases(cases) {
  const now = kyivNowIso();
  const info = cases.map((it) => {
    const rows = S.hearings[it.id] || [];
    const decs = S.dec[caseBase(it.number)] || [];
    const cards = cardsOf(it);
    const st = cards.find((c) => c.stage) || cards[0];
    return { it, next: rows.find((r) => r.iso >= now), court: rows.length ? rows[rows.length - 1].court : st ? st.court : '', dec: decs.length ? decs[0].recv : '', st };
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
  for (const { it, next, court, st } of sortCases(cases)) {
    const nu = unreadBy.get(caseBase(it.number)) || 0;
    out += `<button class="card" data-act="open" data-id="${h(it.id)}"><div class="t">${h(itemTitle(it))}</div>
      <div class="m">№ ${h(it.number)}${court ? ` · ${h(court)}` : ''}</div>
      ${arch ? '' : `<div class="m">${next ? `Наступне засідання: <b>${h(fmtDT(next.iso))}</b>` : 'Призначених засідань немає'}</div>`}
      ${st && st.stage ? `<div class="m">Стадія: <b>${h(st.stage)}</b>${st.sd ? ` (${h(fmtD(st.sd))})` : ''}</div>` : ''}
      ${it.note ? `<div class="m clamp">${h(it.note)}</div>` : ''}
      ${nu ? `<div style="margin-top:4px"><span class="tag new">нових рішень: ${nu}</span></div>` : ''}</button>`;
  }
  if (kws.length) out += `<h2>Запити за учасником або представником</h2>`;
  for (const it of kws) {
    const rows = (S.hearings[it.id] || []).filter((r) => r.iso >= now);
    out += `<button class="card" data-act="open" data-id="${h(it.id)}"><div class="t">${h(it.title || it.query)}</div>
      <div class="m">${it.court ? `Суд: ${h(it.court)} · ` : ''}${arch ? 'в архіві' : `майбутніх засідань: ${rows.length}`}</div></button>`;
  }
  if (!arch) out += `<div class="btns"><button class="btn sec" data-act="import">Імпорт справ зі старого застосунку</button></div>`;
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
  $('#view').innerHTML = v === 'agenda' ? viewAgenda() : v === 'dec' ? viewDecisions() : v === 'cases' ? viewCases() : v === 'search' ? viewSearch() : viewSettings();
  document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
  const nb = $('#badge');
  const cnt = agenda(0).filter((x) => S.fresh.has(x.uid)).length;
  nb.hidden = !cnt;
  nb.textContent = cnt;
  const nd = $('#badgeD');
  const cd = decList().filter((d) => d.unread).length;
  nd.hidden = !cd;
  nd.textContent = cd;
}
// Перемальовує лише списки. Форми пошуку і налаштувань не чіпає, щоб не збити введення.
function softRender() {
  if ($('#dlg').open) return;
  if (S.view === 'agenda' || S.view === 'cases' || S.view === 'dec') render();
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
function showDlg() {
  const d = $('#dlg');
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
function openItem(id) {
  const it = S.items.find((i) => i.id === id && !i.del);
  if (!it) return;
  const now = kyivNowIso();
  let rows = S.hearings[it.id] || [];
  let body;
  if (it.t === 'case') {
    const fut = rows.filter((r) => r.iso >= now);
    const past = rows.filter((r) => r.iso < now).reverse();
    const last = rows.filter((r) => r.involved).pop() || rows[rows.length - 1];
    const cards = cardsOf(it);
    const cardParts = (cards.filter((c) => c.parts).sort((x, y) => y.parts.length - x.parts.length)[0] || {}).parts || '';
    const stan = cards.length
      ? cards.map((c) => `<div class="card"><div class="t">${h(c.stage || 'Стадію не вказано')}${c.sd ? ` · ${h(fmtD(c.sd))}` : ''}</div>
          <div class="m">${h(c.court)}${c.proc ? ` · провадження № ${h(c.proc)}` : ''}</div>
          ${c.result ? `<div class="m">Результат: ${h(c.result)}</div>` : ''}
          ${c.type ? `<div class="m">${h(c.type)}</div>` : ''}
          <div class="m">${c.judge ? `${h(c.judge)} · ` : ''}${c.reg ? `зареєстровано ${h(fmtD(c.reg))}` : ''}</div>
          ${c.desc ? `<div class="m clamp">${h(c.desc)}</div>` : ''}</div>`).join('')
      : `<p class="note">${!syncOn() ? 'Стадія та учасники для справ без засідань доступні після налаштування синхронізації.'
        : !S.cards ? 'Дані про стадію ще готуються. Вони зʼявляться приблизно за хвилину після додавання справи.'
          : 'У базі стану розгляду цієї справи ще немає.'}</p>`;
    const stanNote = S.cards && cards !== null ? `<p class="note">Дані ДСА про стан розгляду: файли від ${h(fmtD(S.cards.oldest))} до ${h(fmtD(S.cards.newest))}.${S.cards.remaining ? ' База ще наповнюється старішими даними.' : ''}</p>` : '';
    const baseline = it.rb || dateMinus(new Date(it.c || Date.now()).toISOString().slice(0, 10), 7);
    const decs = (S.dec[caseBase(it.number)] || []).map((d) => ({ ...d, unread: !it.arch && isUnread(d, baseline) }));
    body = `<div class="dh"><h1>${h(itemTitle(it))}</h1><button class="x" data-act="close" aria-label="Закрити">×</button></div>
      <div class="m">Справа № ${h(it.number)} <button class="btn ghost sm" data-act="copy" data-text="${h(it.number)}">копіювати</button></div>
      <label>Власна назва справи</label><input type="text" data-item="${h(it.id)}" data-field="title" placeholder="${h(itemTitle({ ...it, title: '' }))}" value="${h(it.title || '')}">
      <label>Нотатка</label><textarea rows="2" data-item="${h(it.id)}" data-field="note">${h(it.note || '')}</textarea>
      <h2>Майбутні засідання</h2>${fut.length ? fut.map((r) => hearingCard({ ...r, item: null }, { date: true, title: dayLabel(r.iso.slice(0, 10)).main })).join('') : '<p class="note">Призначених засідань немає.</p>'}
      ${past.length ? `<h2>Історія засідань (${past.length})</h2>${past.map((r) => hearingCard({ ...r, item: null }, { date: true, title: dayLabel(r.iso.slice(0, 10)).main })).join('')}` : ''}
      <h2>Судові рішення${decs.length ? ` (${decs.length})` : ''}</h2>${decs.length ? decs.map((d) => decCard(d, { noTitle: true })).join('') : `<p class="note">У реєстрі немає рішень у цій справі${S.decMeta ? ` з ${h(fmtD(S.decMeta.from))}` : ''}.</p>`}
      <div class="btns"><a class="btn sec sm" href="https://court.gov.ua/fair/" target="_blank" rel="noopener" data-act="copy" data-text="${h(it.number)}">Стан розгляду на court.gov.ua (номер буде скопійовано)</a></div>
      <h2>Стан розгляду</h2>${stan}${stanNote}
      ${(last && last.involved) || cardParts ? `<h2>Учасники</h2><div class="card m">${h((last && last.involved) || cardParts)}</div>` : ''}
      ${last && last.judges ? `<h2>Склад суду</h2><div class="card m">${h(last.judges)}</div>` : ''}
      <div class="btns">${!isNative && fut.length ? `<button class="btn sec" data-act="ics-item" data-id="${h(it.id)}">У Календар (.ics)</button>` : ''}<button class="btn sec" data-act="arch" data-id="${h(it.id)}">${it.arch ? 'Повернути з архіву' : 'В архів'}</button><button class="btn danger" data-act="del" data-id="${h(it.id)}">Видалити зі списку</button></div>
      <button class="btn wide" data-act="close">Закрити</button>`;
  } else {
    const fut = rows.filter((r) => r.iso >= now);
    body = `<div class="dh"><h1>${h(it.query)}</h1><button class="x" data-act="close" aria-label="Закрити">×</button></div>
      <div class="m">Запит за учасником або представником${it.court ? `. Суд: ${h(it.court)}` : ''}</div>
      <label class="chk"><input type="checkbox" data-item="${h(it.id)}" data-field="ag" ${it.ag === false ? '' : 'checked'}> Показувати в засіданнях і нагадувати</label>
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
    downloadIcs((S.hearings[el.dataset.id] || []).filter((r) => r.iso >= now).map((r) => ({ ...r, item: it })), `sprava-${it.number.replace(/\W+/g, '-')}.ics`);
  } else if (a === 'arch') {
    const it = S.items.find((i) => i.id === el.dataset.id);
    if (!it) return;
    const toArch = !it.arch;
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
    const val = t.type === 'checkbox' ? t.checked : t.value.trim();
    updateItem(t.dataset.item, { [t.dataset.field]: val });
    if (t.dataset.field === 'ag') scheduleReminders();
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
