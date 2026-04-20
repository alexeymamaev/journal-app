'use strict';

// ---------- visible error / status overlay (so mobile без DevTools тоже видно) ----------

function errBar() {
  let bar = document.getElementById('err-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'err-bar';
    bar.style.cssText = 'position:fixed;left:0;right:0;bottom:0;padding:10px 14px;font:13px/1.4 -apple-system,sans-serif;color:#fff;z-index:9999;white-space:pre-wrap;max-height:40vh;overflow:auto';
    document.body.appendChild(bar);
  }
  return bar;
}

function showError(e) {
  const bar = errBar();
  bar.style.background = '#a13030';
  const msg = e && e.stack ? e.stack : String(e);
  bar.textContent = (bar.textContent ? bar.textContent + '\n\n' : '') + msg;
}

function showBanner(msg, { variant = 'info', autoHide = 0 } = {}) {
  const bar = errBar();
  bar.style.background = variant === 'ok' ? '#2d6a4f' : '#3b5a80';
  bar.textContent = msg;
  if (autoHide) {
    const snapshot = msg;
    setTimeout(() => {
      const b = document.getElementById('err-bar');
      if (b && b.textContent === snapshot) b.remove();
    }, autoHide);
  }
}

// WebKit роняет IndexedDB-соединение, если страница долго в фоне. Следующая же операция
// падает с "UnknownError: Connection to Indexed Database server lost". Ловим именно это.
function isIdbDisconnectError(e) {
  if (!e) return false;
  const name = e.name || '';
  const msg = String(e.message || e);
  if (name === 'DatabaseClosedError') return true;
  return /Connection to Indexed Database server lost/i.test(msg);
}

async function handleGlobalError(rawErr, ev) {
  if (isIdbDisconnectError(rawErr)) {
    ev?.preventDefault?.();
    await recoverDb();
    return;
  }
  showError(rawErr);
}
window.addEventListener('error', (e) => handleGlobalError(e.error || e.message, e));
window.addEventListener('unhandledrejection', (e) => handleGlobalError(e.reason || e, e));

// ---------- DB ----------

// DB name — отдельное от v4 («kidjournal»), чтобы не конфликтовать с остатками старой схемы.
const db = new Dexie('kidjournal-v5');

// v1 — исходная схема v5 (subjectId + profileId-как-категория).
db.version(1).stores({
  config:  '&id',
  records: '++id, subjectId, status, postedAt, sortMoment',
  events:  '++id, recordId, type, moment',
});

// v2 (2026-04-19, решение 29) — переименование:
//   records.subjectId → records.profileId (человек)
//   records.profileId (старое, = категория) → удаляется
//   config.contexts[] + child + activeIndex + mainTiles + activeTypeKeys →
//     config.profiles[{id, name, age, categories[], mainTileOrder[]}] + activeProfileId
db.version(2).stores({
  config:  '&id',
  records: '++id, profileId, status, postedAt, sortMoment',
  events:  '++id, recordId, type, moment',
}).upgrade(async (trans) => {
  // records: переименование полей
  await trans.table('records').toCollection().modify(r => {
    const person = r.subjectId;
    delete r.subjectId;
    delete r.profileId; // было категорией — выбрасываем
    if (person) r.profileId = person;
  });
  // config: миграция структуры
  await trans.table('config').toCollection().modify(cfg => {
    if (cfg.profiles && cfg.activeProfileId) return; // уже на v2
    const ctx = (cfg.contexts || [])[cfg.activeIndex || 0] || {};
    const profileId = ctx.subjectId || 'child';
    const categoryKey = ctx.profileId || 'gi';
    const profile = {
      id: profileId,
      name: cfg.child?.name || profileId,
      age: cfg.child?.age || '',
      categories: [categoryKey],
      mainTileOrder: Array.isArray(cfg.mainTiles) ? cfg.mainTiles.slice() : [],
    };
    cfg.profiles = [profile];
    cfg.activeProfileId = profile.id;
    delete cfg.contexts;
    delete cfg.activeIndex;
    delete cfg.mainTiles;
    delete cfg.child;
    delete cfg.activeTypeKeys;
  });
});

async function ensureDbOpen() {
  if (db.isOpen()) return;
  await db.open();
}

let recovering = false;
async function recoverDb() {
  if (recovering) return;
  recovering = true;
  showBanner('Переподключение к базе…');
  try {
    try { db.close(); } catch {}
    await db.open();
    showBanner('База снова на связи. Повтори действие.', { variant: 'ok', autoHide: 4000 });
  } catch (e) {
    showError(e);
  } finally {
    recovering = false;
  }
}

// Safari убивает IDB-соединение пока страница в фоне — переоткрываем при возврате.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') ensureDbOpen().catch(() => {});
});
window.addEventListener('pageshow', () => { ensureDbOpen().catch(() => {}); });

// Просим у браузера persistent storage — иначе Safari может выгнать IndexedDB
// при нехватке места, и все записи Лёвы исчезнут. Best-effort, не блокирует boot.
async function requestPersistentStorage() {
  if (!navigator.storage?.persist) return;
  try {
    const already = await navigator.storage.persisted?.();
    if (already) return;
    const granted = await navigator.storage.persist();
    console.log(`[kidjournal] storage.persist granted: ${granted}`);
  } catch (e) {
    console.warn('[kidjournal] storage.persist failed:', e);
  }
}

async function getStorageStatus() {
  if (!navigator.storage?.persisted) return 'неизвестно';
  try {
    const persisted = await navigator.storage.persisted();
    return persisted ? 'надёжное' : 'обычное';
  } catch {
    return 'неизвестно';
  }
}

const CONFIG_ID = 1;

async function loadConfig() {
  return (await db.config.get(CONFIG_ID)) || null;
}
async function saveConfig(cfg) {
  cfg.id = CONFIG_ID;
  await db.config.put(cfg);
}

// ---------- utilities ----------

const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

function cloneTpl(id) {
  const t = document.getElementById(id);
  return t.content.firstElementChild.cloneNode(true);
}

function fmtTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}
function fmtDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: 'short' });
}
function startOfDayIso(d=new Date()) {
  const x = new Date(d); x.setHours(0,0,0,0); return x.toISOString();
}
function endOfDayIso(d=new Date()) {
  const x = new Date(d); x.setHours(23,59,59,999); return x.toISOString();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

function slugify(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9а-яё]+/g, '-').replace(/^-|-$/g, '');
}

function genProfileId(name, existingIds) {
  const base = slugify(name) || 'profile';
  if (!existingIds.includes(base)) return base;
  let i = 2;
  while (existingIds.includes(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

// ---------- config helpers ----------

function getActiveProfile(cfg) {
  cfg = cfg || state.config;
  if (!cfg || !cfg.profiles) return null;
  return cfg.profiles.find(p => p.id === cfg.activeProfileId) || cfg.profiles[0] || null;
}

// Объединение тем из всех включённых категорий профиля, сохраняя порядок mainTileOrder.
function getProfileThemeKeys(profile) {
  if (!profile) return [];
  const set = new Set();
  for (const catKey of (profile.categories || [])) {
    const cat = window.CATEGORY_BY_KEY[catKey];
    if (!cat) continue;
    for (const t of cat.activeTypes) set.add(t);
  }
  return [...set];
}

// Порядок плиток на главном = пересечение mainTileOrder с доступными темами минус явно скрытые;
// новые темы, которые не в order и не в hidden, добавляются в конец.
function getMainTileOrder(profile) {
  const available = new Set(getProfileThemeKeys(profile));
  const hidden = new Set(profile?.mainTileHidden || []);
  const ordered = (profile?.mainTileOrder || []).filter(k => available.has(k) && !hidden.has(k));
  for (const k of available) {
    if (!hidden.has(k) && !ordered.includes(k)) ordered.push(k);
  }
  return ordered;
}

function getMainTiles(profile) {
  return getMainTileOrder(profile);
}

function eventSummary(ev) {
  const type = window.TYPE_BY_KEY[ev.type];
  if (!type) return ev.labelSnapshot || ev.type;
  const parts = [];
  for (const f of type.fields) {
    if (f.kind === 'text') continue;
    const v = ev.fields?.[f.key];
    if (v == null || (Array.isArray(v) && v.length === 0)) continue;
    const opts = f.options || [];
    if (f.kind === 'single') {
      const o = opts.find(o => o.key === v);
      if (o) parts.push(o.label);
    } else if (f.kind === 'multi') {
      const labels = v.map(k => opts.find(o => o.key === k)?.label).filter(Boolean);
      if (labels.length) parts.push(labels.join(', '));
    }
  }
  if (ev.note) parts.push('«' + ev.note + '»');
  return parts.join(' · ');
}

function isRequiredFilled(type, fields) {
  for (const f of type.fields) {
    if (!f.required) continue;
    const v = fields?.[f.key];
    if (f.kind === 'multi') {
      if (!Array.isArray(v) || v.length === 0) return false;
    } else if (f.kind === 'text') {
      if (!v || !String(v).trim()) return false;
    } else {
      if (!v) return false;
    }
  }
  return true;
}

// ---------- state ----------

const state = {
  config: null,             // { id, profiles: [{id,name,age,categories[],mainTileOrder[]}], activeProfileId }
  screen: 'onboarding',
  onb: null,                // { step, mode, profileId?, name, age, categories[], themes[] }
  composer: null,           // { recordId }
  sheet: null,              // { recordId, eventId?, typeKey, draft:{fields,note,moment}, originalMoment }
  editRecord: null,         // { recordId }
};

// ---------- boot ----------

async function boot(retry = 0) {
  try {
    await ensureDbOpen();
    requestPersistentStorage();
    state.config = await loadConfig();
    if (!state.config) {
      startOnboarding();
    } else {
      await renderMain();
    }
  } catch (e) {
    if (isIdbDisconnectError(e) && retry < 2) {
      await recoverDb();
      return boot(retry + 1);
    }
    showError(e);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

function setScreen(node) {
  const root = $('#app');
  root.replaceChildren(node);
}

// ---------- onboarding ----------

function startOnboarding(mode, prefill) {
  // mode: undefined (first-run) | 'new-profile' (add profile from settings)
  state.onb = {
    step: 0,
    mode: mode || 'first',
    name: prefill?.name || '',
    age: prefill?.age || '',
    categories: prefill?.categories ? prefill.categories.slice() : [],
    themes: [],
  };
  renderOnboarding();
}

function renderOnboarding() {
  state.screen = 'onboarding';
  const node = cloneTpl('tpl-onboarding');
  const step = state.onb.step;
  const titles = ['Профиль', 'Категории', 'Темы на главном'];
  const subs = [
    'Кого будем наблюдать.',
    'Под что наблюдаем. Можно выбрать несколько.',
    'Что будет на главном экране. Можно менять позже.',
  ];
  $('[data-step]', node).textContent = `Шаг ${step + 1} из 3`;
  $('[data-title]', node).textContent = titles[step];
  $('[data-sub]', node).textContent = subs[step];

  const body = $('.onb-body', node);
  if (step === 0) {
    body.innerHTML = `
      <label class="field">
        <span class="lbl">Имя</span>
        <input type="text" id="onb-name" placeholder="например, Лёва" value="${escapeHtml(state.onb.name)}">
      </label>
      <label class="field">
        <span class="lbl">Возраст</span>
        <input type="text" id="onb-age" placeholder="например, 3 года" value="${escapeHtml(state.onb.age)}">
      </label>
    `;
  } else if (step === 1) {
    const grid = document.createElement('div');
    grid.className = 'tile-grid';
    for (const c of window.CATEGORIES) {
      const selected = state.onb.categories.includes(c.key);
      const tile = document.createElement('button');
      tile.type = 'button';
      tile.className = 'tile' + (selected ? ' selected' : '');
      tile.dataset.category = c.key;
      tile.innerHTML = `
        <span class="tile-icon">${c.icon}</span>
        <span class="tile-label">${c.label}</span>
        <span class="tile-sub">${c.description}</span>
      `;
      tile.addEventListener('click', () => {
        const set = new Set(state.onb.categories);
        if (set.has(c.key)) set.delete(c.key); else set.add(c.key);
        state.onb.categories = [...set];
        renderOnboarding();
      });
      grid.appendChild(tile);
    }
    body.appendChild(grid);
  } else if (step === 2) {
    const themeKeys = unionThemeKeysFromCategories(state.onb.categories);
    if (state.onb.themes.length === 0) {
      state.onb.themes = themeKeys.slice(); // default — все
    }
    const grid = document.createElement('div');
    grid.className = 'tile-grid';
    for (const k of themeKeys) {
      const t = window.TYPE_BY_KEY[k];
      if (!t) continue;
      const selected = state.onb.themes.includes(k);
      const tile = document.createElement('button');
      tile.type = 'button';
      tile.className = 'tile' + (selected ? ' selected' : '');
      tile.innerHTML = `
        <span class="tile-icon">${t.icon}</span>
        <span class="tile-label">${t.label}</span>
        <span class="tile-sub">${t.description}</span>
      `;
      tile.addEventListener('click', () => {
        const set = new Set(state.onb.themes);
        if (set.has(k)) set.delete(k); else set.add(k);
        state.onb.themes = [...set];
        renderOnboarding();
      });
      grid.appendChild(tile);
    }
    body.appendChild(grid);
  }

  const back = $('[data-back]', node);
  const next = $('[data-next]', node);
  const isNewProfileMode = state.onb.mode === 'new-profile';
  if (step === 0) {
    if (isNewProfileMode) {
      back.disabled = false;
      back.textContent = 'Отмена';
    } else {
      back.disabled = true;
    }
  } else {
    back.disabled = false;
    back.textContent = 'Назад';
  }
  back.addEventListener('click', () => {
    if (step === 0 && isNewProfileMode) {
      state.onb = null;
      renderSettings();
      return;
    }
    state.onb.step = Math.max(0, step - 1);
    renderOnboarding();
  });
  next.textContent = step === 2 ? 'Готово' : 'Далее';
  next.addEventListener('click', async () => {
    if (step === 0) {
      const name = $('#onb-name').value.trim();
      const age = $('#onb-age').value.trim();
      if (!name) { alert('Имя обязательно'); return; }
      state.onb.name = name;
      state.onb.age = age;
      state.onb.step = 1;
      renderOnboarding();
    } else if (step === 1) {
      if (state.onb.categories.length === 0) { alert('Выбери хотя бы одну категорию'); return; }
      state.onb.step = 2;
      state.onb.themes = []; // reset — пересчитать default под новые категории
      renderOnboarding();
    } else {
      if (state.onb.themes.length === 0) { alert('Выбери хотя бы одну тему'); return; }
      await finishOnboarding();
    }
  });

  setScreen(node);
}

function unionThemeKeysFromCategories(categoryKeys) {
  const set = new Set();
  for (const k of categoryKeys) {
    const c = window.CATEGORY_BY_KEY[k];
    if (!c) continue;
    for (const t of c.activeTypes) set.add(t);
  }
  return [...set];
}

function buildMainTileOrder(categories, themes) {
  // default order: по первому категории в списке, затем остальные темы
  const primaryCat = window.CATEGORY_BY_KEY[categories[0]];
  const primary = (primaryCat?.defaultMainTiles || []).filter(k => themes.includes(k));
  const rest = themes.filter(k => !primary.includes(k));
  return [...primary, ...rest];
}

async function finishOnboarding() {
  const { name, age, categories, themes, mode } = state.onb;
  const mainTileOrder = buildMainTileOrder(categories, themes);

  if (mode === 'new-profile' && state.config) {
    // добавить новый профиль в существующий конфиг
    const existingIds = state.config.profiles.map(p => p.id);
    const newProfile = {
      id: genProfileId(name, existingIds),
      name, age,
      categories: categories.slice(),
      mainTileOrder,
    };
    const updated = {
      ...state.config,
      profiles: [...state.config.profiles, newProfile],
      activeProfileId: newProfile.id,
    };
    await saveConfig(updated);
    state.config = await loadConfig();
    state.onb = null;
    await renderMain();
    return;
  }

  // первый запуск либо повторный онбординг
  const profile = {
    id: genProfileId(name, []),
    name, age,
    categories: categories.slice(),
    mainTileOrder,
  };
  const cfg = {
    profiles: [profile],
    activeProfileId: profile.id,
  };
  await saveConfig(cfg);
  state.config = await loadConfig();
  state.onb = null;
  await renderMain();
}

// ---------- main screen ----------

async function renderMain() {
  state.screen = 'main';
  const node = cloneTpl('tpl-main');
  const profile = getActiveProfile();
  if (!profile) { startOnboarding(); return; }

  $('[data-profile-name]', node).textContent = profile.name;
  $('[data-profile-switcher]', node).addEventListener('click', () => openProfileSwitcher());
  $('[data-settings]', node).addEventListener('click', () => renderSettings());

  // draft recovery
  const draft = await db.records
    .where('profileId').equals(profile.id)
    .filter(r => r.status === 'draft')
    .first();

  const draftBanner = $('[data-draft-banner]', node);
  if (draft && !(state.composer && state.composer.recordId === draft.id)) {
    draftBanner.classList.remove('hidden');
    $('[data-draft-label]', draftBanner).textContent = `Черновик от ${fmtTime(draft.postedAt)}`;
    $('[data-draft-continue]', draftBanner).addEventListener('click', async () => {
      state.composer = { recordId: draft.id };
      await renderMain();
    });
    $('[data-draft-drop]', draftBanner).addEventListener('click', async () => {
      await deleteRecord(draft.id);
      await renderMain();
    });
  }

  // tile grid
  const tilesEl = $('[data-tiles]', node);
  renderTileGrid(tilesEl, getMainTiles(profile), (typeKey) => {
    const rid = state.composer?.recordId || null;
    openTypeSheet({ recordId: rid, typeKey });
  });

  // composer block — always visible; draft создаётся лениво
  const composerEl = $('[data-composer]', node);
  await renderComposerInto(composerEl, state.composer?.recordId || null);

  // today list
  const todayEl = $('[data-today]', node);
  const from = startOfDayIso();
  const to = endOfDayIso();
  const todayRecords = await db.records
    .where('sortMoment').between(from, to, true, true)
    .filter(r => r.status === 'saved' && r.profileId === profile.id)
    .toArray();
  todayRecords.sort((a, b) => (b.sortMoment > a.sortMoment ? 1 : -1));
  if (todayRecords.length === 0) {
    todayEl.innerHTML = '<p class="muted empty">Сегодня записей нет.</p>';
  } else {
    for (const r of todayRecords) {
      todayEl.appendChild(await renderRecordCard(r));
    }
  }

  // inline history link
  $('[data-history]', node).addEventListener('click', () => renderHistory());

  setScreen(node);
}

function renderTileGrid(root, typeKeys, onTap) {
  root.innerHTML = '';
  for (const k of typeKeys) {
    const t = window.TYPE_BY_KEY[k];
    if (!t) continue;
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'tile';
    tile.innerHTML = `
      <span class="tile-icon">${t.icon}</span>
      <span class="tile-label">${t.label}</span>
      <span class="tile-sub">${t.description}</span>
    `;
    tile.addEventListener('click', () => onTap(k));
    root.appendChild(tile);
  }
}

async function createDraftRecord() {
  const profile = getActiveProfile();
  const now = new Date().toISOString();
  return await db.records.add({
    profileId: profile.id,
    postedAt: now,
    status: 'draft',
    comment: '',
    sortMoment: now,
  });
}

async function renderComposerInto(root, recordId) {
  const record = recordId ? await db.records.get(recordId) : null;
  const events = recordId
    ? (await db.events.where('recordId').equals(recordId).toArray()).sort((a,b) => (a.moment > b.moment ? 1 : -1))
    : [];

  const stream = $('[data-chip-stream]', root);
  stream.innerHTML = '';
  for (const ev of events) stream.appendChild(renderEventChip(ev));

  const commentEl = $('[data-comment]', root);
  commentEl.value = record?.comment || '';

  const saveBtn = $('[data-save]', root);
  const discardBtn = $('[data-discard]', root);

  function updateSaveBtn() {
    const hasContent = events.length > 0 || commentEl.value.trim().length > 0;
    saveBtn.disabled = !hasContent;
    saveBtn.textContent = events.length > 0
      ? `Сохранить запись · ${events.length}`
      : 'Сохранить запись';
  }
  updateSaveBtn();

  if (recordId) {
    discardBtn.classList.remove('hidden');
    discardBtn.addEventListener('click', async () => {
      if (!confirm('Отменить запись? Всё, что набрано, будет удалено.')) return;
      await deleteRecord(recordId);
      state.composer = null;
      await renderMain();
    });
  }

  let commentTimer = null;
  const flushComment = async () => {
    const txt = commentEl.value;
    let rid = state.composer?.recordId;
    if (!rid) {
      if (!txt.trim()) return null;
      rid = await createDraftRecord();
      state.composer = { recordId: rid };
    }
    await db.records.update(rid, { comment: txt });
    return rid;
  };
  commentEl.addEventListener('input', () => {
    updateSaveBtn();
    clearTimeout(commentTimer);
    commentTimer = setTimeout(flushComment, 500);
  });

  saveBtn.addEventListener('click', async () => {
    clearTimeout(commentTimer);
    await flushComment();
    const rid = state.composer?.recordId;
    if (!rid) return;
    const evts = await db.events.where('recordId').equals(rid).toArray();
    const moments = evts.map(e => e.moment).sort();
    const now = new Date().toISOString();
    await db.records.update(rid, {
      status: 'saved',
      sortMoment: moments[0] || now,
      comment: commentEl.value,
      postedAt: now,
    });
    state.composer = null;
    await renderMain();
  });
}

function renderEventChip(ev) {
  const t = window.TYPE_BY_KEY[ev.type];
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'chip';
  const summary = eventSummary(ev);
  const tm = fmtTime(ev.moment);
  el.innerHTML = `
    <span class="chip-icon">${t ? t.icon : '•'}</span>
    <span class="chip-main">
      <span class="chip-label">${ev.labelSnapshot || t?.label || ev.type} · ${tm}</span>
      ${summary ? `<span class="chip-sub">${escapeHtml(summary)}</span>` : ''}
    </span>
  `;
  el.addEventListener('click', () => {
    openTypeSheet({ recordId: ev.recordId, eventId: ev.id, typeKey: ev.type });
  });
  return el;
}

async function deleteRecord(recordId) {
  await db.events.where('recordId').equals(recordId).delete();
  await db.records.delete(recordId);
}

// ---------- profile switcher ----------

function openProfileSwitcher() {
  const cfg = state.config;
  const node = cloneTpl('tpl-profile-switcher');
  const list = $('[data-profiles]', node);
  list.innerHTML = '';

  for (const p of cfg.profiles) {
    const active = p.id === cfg.activeProfileId;
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'ps-row' + (active ? ' active' : '');
    const sub = p.categories.map(k => window.CATEGORY_BY_KEY[k]?.label).filter(Boolean).join(', ');
    const ageBit = p.age ? `${p.age} · ` : '';
    row.innerHTML = `
      <span class="ps-dot ${active ? 'on' : 'off'}" aria-hidden="true"></span>
      <div class="ps-main">
        <span class="ps-name">${escapeHtml(p.name)}</span>
        <span class="ps-sub">${escapeHtml(ageBit + sub)}</span>
      </div>
      ${active ? '<span class="ps-check" aria-hidden="true">✓</span>' : ''}
    `;
    row.addEventListener('click', async () => {
      if (!active) {
        const upd = { ...cfg, activeProfileId: p.id };
        await saveConfig(upd);
        state.config = await loadConfig();
      }
      close();
      if (!active) await renderMain();
    });
    list.appendChild(row);
  }

  const addRow = document.createElement('button');
  addRow.type = 'button';
  addRow.className = 'ps-row add';
  addRow.innerHTML = `
    <span class="ps-plus" aria-hidden="true">+</span>
    <div class="ps-main">
      <span class="ps-name">Новый профиль</span>
    </div>
  `;
  addRow.addEventListener('click', () => {
    close();
    startOnboarding('new-profile');
  });
  list.appendChild(addRow);

  const close = () => node.remove();
  $('[data-done]', node).addEventListener('click', close);
  node.addEventListener('click', (e) => {
    if (e.target === node) close();
  });

  document.body.appendChild(node);
}

// ---------- settings ----------

async function renderSettings() {
  state.screen = 'settings';
  const node = cloneTpl('tpl-settings');
  const root = $('[data-root]', node);
  root.innerHTML = '';

  // Профили
  root.appendChild(sgLabel('Профили'));
  const profilesGroup = sgGroup();
  const active = getActiveProfile();
  for (const p of state.config.profiles) {
    const isActive = p.id === state.config.activeProfileId;
    const sub = (p.age ? p.age + ' · ' : '')
      + p.categories.map(k => window.CATEGORY_BY_KEY[k]?.label).filter(Boolean).join(', ');
    const row = sgRow({
      dot: isActive ? 'on' : 'off',
      title: p.name,
      sub,
      chev: true,
      onTap: () => renderSettingsProfile(p.id),
    });
    profilesGroup.appendChild(row);
  }
  profilesGroup.appendChild(sgRow({
    add: true,
    title: '+ Добавить профиль',
    onTap: () => startOnboarding('new-profile'),
  }));
  root.appendChild(profilesGroup);

  // Главный экран
  root.appendChild(sgLabel('Главный экран'));
  const mainGroup = sgGroup();
  const themeKeys = getProfileThemeKeys(active);
  const mainCount = getMainTiles(active).length;
  mainGroup.appendChild(sgRow({
    title: 'Темы на главном',
    sub: 'для активного профиля',
    value: `${mainCount} из ${themeKeys.length}`,
    chev: true,
    onTap: () => renderSettingsThemes(active.id),
  }));
  root.appendChild(mainGroup);

  // Данные
  root.appendChild(sgLabel('Данные'));
  const dataGroup = sgGroup();
  dataGroup.appendChild(sgRow({
    title: 'Повторить онбординг',
    sub: 'не удаляет записи',
    chev: true,
    onTap: async () => {
      if (!confirm('Пройти онбординг заново? Записи останутся на месте, но текущий конфиг профиля будет перезаписан.')) return;
      state.composer = null;
      startOnboarding('first');
    },
  }));
  dataGroup.appendChild(sgRow({
    title: 'Очистить все данные',
    danger: true,
    onTap: async () => {
      if (!confirm('Удалить ВСЕ записи и настройки? Действие необратимое.')) return;
      if (!confirm('Точно? Это выкинет все записи Лёвы и других профилей.')) return;
      await clearAllData();
    },
  }));
  root.appendChild(dataGroup);

  // О приложении
  root.appendChild(sgLabel('О приложении'));
  const aboutGroup = sgGroup();
  aboutGroup.appendChild(sgRow({
    title: 'Версия',
    value: '0.6.0',
    staticRow: true,
  }));
  const storageRow = sgRow({
    title: 'Хранение',
    value: '…',
    sub: 'надёжное = Safari не выгонит при нехватке места',
    staticRow: true,
  });
  aboutGroup.appendChild(storageRow);
  (async () => {
    const status = await getStorageStatus();
    const valueEl = storageRow.querySelector('.sg-row-value');
    if (valueEl) valueEl.textContent = status;
  })();
  root.appendChild(aboutGroup);

  $('[data-back]', node).addEventListener('click', () => renderMain());

  setScreen(node);
}

function sgLabel(text) {
  const el = document.createElement('div');
  el.className = 'sg-label';
  el.textContent = text;
  return el;
}

function sgGroup() {
  const el = document.createElement('div');
  el.className = 'sg-group';
  return el;
}

function sgRow(opts) {
  const { dot, title, sub, value, chev, danger, add, staticRow, onTap } = opts;
  const row = document.createElement(staticRow ? 'div' : 'button');
  if (!staticRow) row.type = 'button';
  row.className = 'sg-row'
    + (danger ? ' danger' : '')
    + (add ? ' add' : '')
    + (staticRow ? ' static' : '');
  if (dot) {
    const d = document.createElement('span');
    d.className = `sg-dot ${dot === 'on' ? 'on' : 'off'}`;
    d.setAttribute('aria-hidden', 'true');
    row.appendChild(d);
  }
  const main = document.createElement('div');
  main.className = 'sg-row-main';
  const t = document.createElement('span');
  t.className = 'sg-row-title';
  t.textContent = title;
  main.appendChild(t);
  if (sub) {
    const s = document.createElement('span');
    s.className = 'sg-row-sub';
    s.textContent = sub;
    main.appendChild(s);
  }
  row.appendChild(main);
  if (value) {
    const v = document.createElement('span');
    v.className = 'sg-row-value';
    v.textContent = value;
    row.appendChild(v);
  }
  if (chev) {
    const c = document.createElement('span');
    c.className = 'sg-row-chev';
    c.setAttribute('aria-hidden', 'true');
    c.textContent = '›';
    row.appendChild(c);
  }
  if (onTap && !staticRow) row.addEventListener('click', onTap);
  return row;
}

async function clearAllData() {
  db.close();
  await Dexie.delete('kidjournal-v5');
  // hard reload — state reset, Dexie reopen fresh
  location.reload();
}

// --- settings: profile detail ---

function renderSettingsProfile(profileId) {
  state.screen = 'settings-profile';
  const node = cloneTpl('tpl-settings-profile');
  const cfg = state.config;
  const existing = cfg.profiles.find(p => p.id === profileId);
  if (!existing) { renderSettings(); return; }

  $('[data-title]', node).textContent = existing.name;

  const nameEl = $('[data-name]', node);
  const ageEl = $('[data-age]', node);
  nameEl.value = existing.name;
  ageEl.value = existing.age || '';

  // categories multi-check
  const catGroup = $('[data-categories]', node);
  catGroup.innerHTML = '';
  const selectedCats = new Set(existing.categories);
  for (const c of window.CATEGORIES) {
    const on = selectedCats.has(c.key);
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'cat-row' + (on ? '' : ' off');
    row.innerHTML = `
      <span class="cat-check ${on ? 'on' : ''}" aria-hidden="true"></span>
      <span class="cat-icon">${c.icon}</span>
      <div class="cat-main">
        <span class="cat-label">${c.label}</span>
        <span class="cat-sub">${escapeHtml(c.description)}</span>
      </div>
    `;
    row.addEventListener('click', () => {
      if (selectedCats.has(c.key)) selectedCats.delete(c.key);
      else selectedCats.add(c.key);
      const nowOn = selectedCats.has(c.key);
      row.classList.toggle('off', !nowOn);
      $('.cat-check', row).classList.toggle('on', nowOn);
    });
    catGroup.appendChild(row);
  }

  // themes-count подпись
  const themesCountEl = $('[data-themes-count]', node);
  const themeKeys = getProfileThemeKeys(existing);
  const mainTiles = getMainTiles(existing);
  themesCountEl.textContent = `${mainTiles.length} из ${themeKeys.length}`;

  $('[data-themes-open]', node).addEventListener('click', async () => {
    await saveProfileEdits();
    renderSettingsThemes(profileId);
  });

  $('[data-delete]', node).addEventListener('click', async () => {
    const last = cfg.profiles.length === 1;
    const msg = last
      ? 'Удалить единственный профиль? После удаления откроется онбординг заново (записи удалятся).'
      : `Удалить профиль «${existing.name}»? Все записи этого профиля будут удалены.`;
    if (!confirm(msg)) return;
    if (!confirm('Точно удалить? Действие необратимое.')) return;
    // delete records of this profile
    const toDelete = await db.records.where('profileId').equals(profileId).toArray();
    for (const r of toDelete) {
      await db.events.where('recordId').equals(r.id).delete();
    }
    await db.records.where('profileId').equals(profileId).delete();
    const remaining = cfg.profiles.filter(p => p.id !== profileId);
    if (remaining.length === 0) {
      // конфиг пустой — стираем и начинаем заново
      await db.config.delete(CONFIG_ID);
      state.config = null;
      startOnboarding();
      return;
    }
    const newActive = cfg.activeProfileId === profileId ? remaining[0].id : cfg.activeProfileId;
    const upd = { ...cfg, profiles: remaining, activeProfileId: newActive };
    await saveConfig(upd);
    state.config = await loadConfig();
    renderSettings();
  });

  async function saveProfileEdits() {
    const name = nameEl.value.trim() || existing.name;
    const age = ageEl.value.trim();
    const categories = [...selectedCats];
    if (categories.length === 0) {
      alert('У профиля должна быть хотя бы одна категория.');
      return false;
    }
    // подрезаем mainTileOrder под новые категории; добавляем новые темы в конец
    const themeKeys = new Set(unionThemeKeysFromCategories(categories));
    const order = (existing.mainTileOrder || []).filter(k => themeKeys.has(k));
    for (const k of themeKeys) if (!order.includes(k)) order.push(k);
    const updated = { ...existing, name, age, categories, mainTileOrder: order };
    const profiles = cfg.profiles.map(p => p.id === profileId ? updated : p);
    await saveConfig({ ...cfg, profiles });
    state.config = await loadConfig();
    return true;
  }

  $('[data-back]', node).addEventListener('click', async () => {
    await saveProfileEdits();
    renderSettings();
  });

  setScreen(node);
}

// --- settings: themes (drag list) ---

function renderSettingsThemes(profileId) {
  state.screen = 'settings-themes';
  const node = cloneTpl('tpl-settings-themes');
  const cfg = state.config;
  const profile = cfg.profiles.find(p => p.id === profileId);
  if (!profile) { renderSettings(); return; }

  const available = getProfileThemeKeys(profile);
  const hiddenList = (profile.mainTileHidden || []).filter(k => available.includes(k));
  const hiddenSet = new Set(hiddenList);
  const order = (profile.mainTileOrder || []).filter(k => available.includes(k) && !hiddenSet.has(k));
  for (const k of available) {
    if (!hiddenSet.has(k) && !order.includes(k)) order.push(k);
  }

  const listEl = $('[data-list]', node);

  const saveState = async () => {
    const updated = {
      ...profile,
      mainTileOrder: order.slice(),
      mainTileHidden: hiddenList.slice(),
    };
    const profiles = cfg.profiles.map(p => p.id === profileId ? updated : p);
    await saveConfig({ ...cfg, profiles });
    state.config = await loadConfig();
  };

  function themeRow(key, { isHidden }) {
    const t = window.TYPE_BY_KEY[key];
    if (!t) return null;
    const row = document.createElement('div');
    row.className = 'theme-row' + (isHidden ? ' hidden-theme' : '');
    row.dataset.key = key;
    row.innerHTML = `
      <span class="theme-icon">${t.icon}</span>
      <div class="theme-row-main">
        <span class="theme-row-label">${t.label}</span>
        <span class="theme-row-sub">${escapeHtml(t.description || '')}</span>
      </div>
    `;
    return row;
  }

  function render() {
    listEl.innerHTML = '';

    const visibleHdr = document.createElement('div');
    visibleHdr.className = 'sg-label';
    visibleHdr.textContent = `На главном · ${order.length}`;
    listEl.appendChild(visibleHdr);

    order.forEach((key, idx) => {
      const row = themeRow(key, { isHidden: false });
      if (!row) return;
      const ctrl = document.createElement('div');
      ctrl.className = 'theme-ctrl';

      const up = document.createElement('button');
      up.type = 'button';
      up.className = 'theme-btn';
      up.textContent = '↑';
      up.disabled = idx === 0;
      up.addEventListener('click', async () => {
        if (idx === 0) return;
        [order[idx-1], order[idx]] = [order[idx], order[idx-1]];
        await saveState();
        render();
      });

      const down = document.createElement('button');
      down.type = 'button';
      down.className = 'theme-btn';
      down.textContent = '↓';
      down.disabled = idx === order.length - 1;
      down.addEventListener('click', async () => {
        if (idx === order.length - 1) return;
        [order[idx], order[idx+1]] = [order[idx+1], order[idx]];
        await saveState();
        render();
      });

      const hide = document.createElement('button');
      hide.type = 'button';
      hide.className = 'theme-btn theme-btn-text';
      hide.textContent = 'Скрыть';
      hide.addEventListener('click', async () => {
        if (order.length === 1) {
          alert('Нужна хотя бы одна тема на главном.');
          return;
        }
        order.splice(idx, 1);
        hiddenList.push(key);
        hiddenSet.add(key);
        await saveState();
        render();
      });

      ctrl.appendChild(up);
      ctrl.appendChild(down);
      ctrl.appendChild(hide);
      row.appendChild(ctrl);
      listEl.appendChild(row);
    });

    if (hiddenList.length > 0) {
      const hiddenHdr = document.createElement('div');
      hiddenHdr.className = 'sg-label';
      hiddenHdr.textContent = `Скрытые · ${hiddenList.length}`;
      listEl.appendChild(hiddenHdr);

      hiddenList.slice().forEach((key) => {
        const row = themeRow(key, { isHidden: true });
        if (!row) return;
        const show = document.createElement('button');
        show.type = 'button';
        show.className = 'theme-btn theme-btn-text';
        show.textContent = 'На главный';
        show.addEventListener('click', async () => {
          const i = hiddenList.indexOf(key);
          if (i >= 0) hiddenList.splice(i, 1);
          hiddenSet.delete(key);
          order.push(key);
          await saveState();
          render();
        });
        row.appendChild(show);
        listEl.appendChild(row);
      });
    }
  }
  render();

  $('[data-back]', node).addEventListener('click', () => renderSettings());
  setScreen(node);
}

// ---------- bottom sheet (theme / type) ----------

async function openTypeSheet({ recordId, eventId, typeKey }) {
  const type = window.TYPE_BY_KEY[typeKey];
  if (!type) return;
  let ev;
  if (eventId) {
    ev = await db.events.get(eventId);
  } else {
    ev = {
      recordId,
      type: typeKey,
      moment: new Date().toISOString(),
      fields: {},
      note: '',
      labelSnapshot: type.label,
    };
  }
  state.sheet = {
    recordId,
    eventId: eventId || null,
    typeKey,
    draft: {
      fields: JSON.parse(JSON.stringify(ev.fields || {})),
      note: ev.note || '',
      moment: ev.moment,
    },
    baseMoment: new Date().toISOString(),
  };
  renderSheet();
}

function renderSheet() {
  const st = state.sheet;
  const type = window.TYPE_BY_KEY[st.typeKey];
  const node = cloneTpl('tpl-sheet');
  $('[data-sheet-title]', node).textContent = type.label;
  $('[data-sheet-desc]', node).textContent = type.description;

  const body = $('[data-fields]', node);
  for (const f of type.fields) {
    body.appendChild(renderField(f));
  }

  const ticksEl = $('[data-retro-ticks]', node);
  const momentEl = $('[data-moment]', node);
  const exactLbl = $('[data-retro-custom]', node);
  const exactInput = $('[data-retro-time]', node);

  const TICK_MINUTES = [120, 90, 60, 30, 0];
  const PRESET_TOLERANCE = 7;

  const tickButtons = () => $$('button.time-chip', ticksEl);

  const updateReadout = () => {
    momentEl.textContent = fmtTime(st.draft.moment);
  };

  const activateTickByMin = (min) => {
    tickButtons().forEach(b => {
      b.classList.toggle('active', +b.dataset.retroMin === min);
    });
    exactLbl.classList.remove('active');
  };

  const activateExact = () => {
    tickButtons().forEach(b => b.classList.remove('active'));
    exactLbl.classList.add('active');
  };

  const applyTickByMin = (mins) => {
    st.draft.moment = new Date(Date.now() - mins * 60 * 1000).toISOString();
    activateTickByMin(mins);
    updateReadout();
  };

  tickButtons().forEach(b => {
    b.addEventListener('click', () => applyTickByMin(+b.dataset.retroMin));
  });

  exactInput.addEventListener('change', () => {
    const val = exactInput.value;
    if (!val) return;
    const [h, m] = val.split(':').map(Number);
    const picked = new Date();
    picked.setHours(h, m, 0, 0);
    if (picked.getTime() > Date.now()) picked.setDate(picked.getDate() - 1);
    let snapMin = Math.round(picked.getMinutes() / 15) * 15;
    if (snapMin === 60) { picked.setHours(picked.getHours() + 1); snapMin = 0; }
    picked.setMinutes(snapMin, 0, 0);
    st.draft.moment = picked.toISOString();
    activateExact();
    updateReadout();
  });

  const initDate = new Date(st.draft.moment);
  exactInput.value = `${String(initDate.getHours()).padStart(2, '0')}:${String(initDate.getMinutes()).padStart(2, '0')}`;
  const initDiff = Math.round((Date.now() - initDate.getTime()) / 60000);
  const matchMin = TICK_MINUTES.find(v => Math.abs(v - initDiff) <= PRESET_TOLERANCE);
  if (matchMin !== undefined) {
    activateTickByMin(matchMin);
  } else {
    activateExact();
  }
  updateReadout();

  const inEditFlow = !!state.editRecord;
  const commitEvent = async () => {
    if (!isRequiredFilled(type, st.draft.fields)) {
      alert('Заполни обязательные поля');
      return null;
    }
    let recordId = st.recordId;
    if (!recordId) {
      recordId = await createDraftRecord();
      state.composer = { recordId };
    }
    const payload = {
      recordId,
      type: st.typeKey,
      moment: st.draft.moment,
      fields: st.draft.fields,
      note: st.draft.note,
      labelSnapshot: type.label,
    };
    if (st.eventId) await db.events.update(st.eventId, payload);
    else await db.events.add(payload);
    const events = await db.events.where('recordId').equals(recordId).toArray();
    if (events.length) {
      const moments = events.map(e => e.moment).sort();
      await db.records.update(recordId, { sortMoment: moments[0] });
    }
    return recordId;
  };

  const saveBtn = $('[data-commit-save]', node);
  const continueBtn = $('[data-commit-continue]', node);

  if (inEditFlow) {
    saveBtn.textContent = 'Готово';
    continueBtn.classList.add('hidden');
  }

  saveBtn.addEventListener('click', async () => {
    const recordId = await commitEvent();
    if (!recordId) return;
    state.sheet = null;
    if (inEditFlow) {
      await openRecordEdit(recordId);
      return;
    }
    const events = await db.events.where('recordId').equals(recordId).toArray();
    const moments = events.map(e => e.moment).sort();
    const now = new Date().toISOString();
    const rec = await db.records.get(recordId);
    await db.records.update(recordId, {
      status: 'saved',
      sortMoment: moments[0] || now,
      comment: rec?.comment || '',
      postedAt: now,
    });
    state.composer = null;
    await renderMain();
  });

  continueBtn.addEventListener('click', async () => {
    const recordId = await commitEvent();
    if (!recordId) return;
    state.sheet = null;
    await renderMain();
  });

  const remove = $('[data-remove]', node);
  if (st.eventId) {
    remove.classList.remove('hidden');
    remove.addEventListener('click', async () => {
      if (!confirm('Удалить это наблюдение из записи?')) return;
      await db.events.delete(st.eventId);
      const leftover = await db.events.where('recordId').equals(st.recordId).count();
      if (leftover === 0) {
        const r = await db.records.get(st.recordId);
        if (r && r.status === 'draft') {
          await db.records.delete(st.recordId);
          state.composer = null;
        }
      }
      state.sheet = null;
      if (state.editRecord && state.editRecord.recordId === st.recordId) {
        const stillThere = await db.records.get(st.recordId);
        if (!stillThere) { state.editRecord = null; await renderMain(); }
        else await openRecordEdit(st.recordId);
      } else {
        await renderMain();
      }
    });
  }

  $('[data-cancel]', node).addEventListener('click', () => {
    state.sheet = null;
    if (state.editRecord) {
      openRecordEdit(state.editRecord.recordId);
    } else {
      renderMain();
    }
  });
  node.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) {
      state.sheet = null;
      if (state.editRecord) openRecordEdit(state.editRecord.recordId);
      else renderMain();
    }
  });

  setScreen(node);
}

function renderField(f) {
  const wrap = document.createElement('div');
  wrap.className = 'field';
  const lbl = document.createElement('div');
  lbl.className = 'lbl';
  lbl.textContent = f.label + (f.required ? ' *' : '');
  wrap.appendChild(lbl);

  const draft = state.sheet.draft;

  if (f.kind === 'single') {
    const row = document.createElement('div');
    row.className = 'opt-row';
    for (const o of f.options) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'opt' + (draft.fields[f.key] === o.key ? ' selected' : '');
      b.textContent = o.label;
      b.addEventListener('click', () => {
        draft.fields[f.key] = o.key;
        $$('.opt', row).forEach(x => x.classList.remove('selected'));
        b.classList.add('selected');
      });
      row.appendChild(b);
    }
    wrap.appendChild(row);
  } else if (f.kind === 'multi') {
    const row = document.createElement('div');
    row.className = 'opt-row';
    if (!Array.isArray(draft.fields[f.key])) draft.fields[f.key] = [];
    for (const o of f.options) {
      const b = document.createElement('button');
      b.type = 'button';
      const sel = () => draft.fields[f.key].includes(o.key);
      b.className = 'opt' + (sel() ? ' selected' : '');
      b.textContent = o.label;
      b.addEventListener('click', () => {
        const arr = draft.fields[f.key];
        const i = arr.indexOf(o.key);
        if (i === -1) arr.push(o.key); else arr.splice(i, 1);
        b.classList.toggle('selected');
      });
      row.appendChild(b);
    }
    wrap.appendChild(row);
  } else if (f.kind === 'text') {
    const ta = document.createElement('textarea');
    ta.rows = 2;
    ta.placeholder = f.placeholder || '';
    if (f.key === 'note') {
      ta.value = draft.note || '';
      ta.addEventListener('input', () => { draft.note = ta.value; });
    } else {
      ta.value = draft.fields[f.key] || '';
      ta.addEventListener('input', () => { draft.fields[f.key] = ta.value; });
    }
    wrap.appendChild(ta);
  }

  return wrap;
}

// ---------- record edit ----------

async function openRecordEdit(recordId) {
  state.editRecord = { recordId };
  const record = await db.records.get(recordId);
  if (!record) { state.editRecord = null; await renderMain(); return; }
  const events = await db.events.where('recordId').equals(recordId).toArray();
  events.sort((a,b) => (a.moment > b.moment ? 1 : -1));

  const node = cloneTpl('tpl-record-edit');
  $('[data-record-sub]', node).textContent = `${fmtDate(record.sortMoment)} · ${fmtTime(record.sortMoment)}`;

  const stream = $('[data-chip-stream]', node);
  if (events.length === 0) {
    stream.innerHTML = '<p class="muted">Нет наблюдений. Добавь тему снизу или удали запись.</p>';
  } else {
    for (const ev of events) stream.appendChild(renderEventChip(ev));
  }

  const tiles = $('[data-tiles]', node);
  const profile = getActiveProfile();
  renderTileGrid(tiles, getMainTiles(profile), (typeKey) => {
    openTypeSheet({ recordId, typeKey });
  });

  const commentEl = $('[data-comment]', node);
  commentEl.value = record.comment || '';

  $('[data-cancel]', node).addEventListener('click', async () => {
    state.editRecord = null;
    await renderMain();
  });
  node.addEventListener('click', async (e) => {
    if (e.target === e.currentTarget) { state.editRecord = null; await renderMain(); }
  });
  $('[data-save]', node).addEventListener('click', async () => {
    await db.records.update(recordId, { comment: commentEl.value });
    state.editRecord = null;
    await renderMain();
  });
  $('[data-delete]', node).addEventListener('click', async () => {
    if (!confirm('Удалить запись целиком?')) return;
    await deleteRecord(recordId);
    state.editRecord = null;
    await renderMain();
  });

  setScreen(node);
}

async function renderRecordCard(record) {
  const events = await db.events.where('recordId').equals(record.id).toArray();
  events.sort((a,b) => (a.moment > b.moment ? 1 : -1));
  const card = document.createElement('article');
  card.className = 'record-card';
  const head = document.createElement('div');
  head.className = 'record-head';
  head.innerHTML = `
    <span class="record-time">${fmtTime(record.sortMoment)}</span>
    <span class="record-date muted">${fmtDate(record.sortMoment)}</span>
    <span class="grow"></span>
    <span class="edit-hint">✎</span>
  `;
  card.appendChild(head);
  const chips = document.createElement('div');
  chips.className = 'chip-stream readonly';
  for (const ev of events) {
    const type = window.TYPE_BY_KEY[ev.type];
    const chip = document.createElement('div');
    chip.className = 'chip';
    const sum = eventSummary(ev);
    chip.innerHTML = `
      <span class="chip-icon">${type ? type.icon : '•'}</span>
      <span class="chip-main">
        <span class="chip-label">${ev.labelSnapshot || type?.label || ev.type} · ${fmtTime(ev.moment)}</span>
        ${sum ? `<span class="chip-sub">${escapeHtml(sum)}</span>` : ''}
      </span>
    `;
    chips.appendChild(chip);
  }
  card.appendChild(chips);
  if (record.comment) {
    const c = document.createElement('p');
    c.className = 'record-comment';
    c.textContent = record.comment;
    card.appendChild(c);
  }
  card.addEventListener('click', () => openRecordEdit(record.id));
  return card;
}

// ---------- history ----------

async function renderHistory() {
  state.screen = 'history';
  const node = cloneTpl('tpl-history');
  const profile = getActiveProfile();
  const records = await db.records
    .where('profileId').equals(profile.id)
    .filter(r => r.status === 'saved')
    .toArray();
  records.sort((a,b) => (b.sortMoment > a.sortMoment ? 1 : -1));
  const list = $('[data-records]', node);
  const strip = $('[data-day-strip]', node);
  const stripInner = $('[data-day-strip-inner]', node);

  if (records.length === 0) {
    list.innerHTML = '<p class="muted empty">Пока пусто.</p>';
  } else {
    const filledDays = new Set();
    for (const r of records) filledDays.add(dayKey(r.sortMoment));

    let lastDay = null;
    for (const r of records) {
      const day = new Date(r.sortMoment).toDateString();
      if (day !== lastDay) {
        const hdr = document.createElement('h3');
        hdr.className = 'day-header';
        hdr.dataset.dayKey = dayKey(r.sortMoment);
        hdr.textContent = fmtDayHeader(r.sortMoment);
        list.appendChild(hdr);
        lastDay = day;
      }
      list.appendChild(await renderRecordCard(r));
    }

    renderDayStrip(stripInner, filledDays, 60, (key) => onDayChipTap(key, list, stripInner));
    strip.classList.remove('hidden');
  }

  $('[data-back]', node).addEventListener('click', () => renderMain());
  $('[data-export]', node).addEventListener('click', () => openExport());
  setScreen(node);
  window.scrollTo(0, 0);

  if (records.length) {
    requestAnimationFrame(() => {
      stripInner.scrollLeft = stripInner.scrollWidth;
      const firstKey = list.querySelector('.day-header')?.dataset.dayKey;
      if (firstKey) {
        stripInner.querySelectorAll('.day-chip').forEach(c => {
          c.classList.toggle('active', c.dataset.dayKey === firstKey);
        });
      }
      setupDayStripObserver(list, stripInner);
    });
  }
}

function dayKey(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const WEEKDAY_RU = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

function renderDayStrip(root, filledDays, daysBack, onTap) {
  root.innerHTML = '';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayKey = dayKey(today.toISOString());
  for (let i = daysBack - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = dayKey(d.toISOString());
    const isToday = key === todayKey;
    const isFilled = filledDays.has(key);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'day-chip' + (isToday ? ' today' : '') + (isFilled ? ' filled' : '');
    btn.dataset.dayKey = key;
    const wd = document.createElement('span');
    wd.className = 'day-chip-wd';
    wd.textContent = WEEKDAY_RU[d.getDay()];
    const circle = document.createElement('span');
    circle.className = 'day-chip-circle';
    circle.textContent = d.getDate();
    btn.appendChild(wd);
    btn.appendChild(circle);
    btn.addEventListener('click', () => onTap(key));
    root.appendChild(btn);
  }
}

function onDayChipTap(key, list, stripInner) {
  const header = list.querySelector(`.day-header[data-day-key="${key}"]`);
  const chip = stripInner.querySelector(`.day-chip[data-day-key="${key}"]`);
  if (!header) {
    // пустой день — короткий bounce, чтобы стало понятно «здесь ничего нет»
    if (chip) {
      chip.classList.remove('bump');
      void chip.offsetWidth;
      chip.classList.add('bump');
    }
    return;
  }
  header.scrollIntoView({ behavior: 'smooth', block: 'start' });
  header.classList.remove('flash');
  void header.offsetWidth;
  header.classList.add('flash');
  setActiveChip(stripInner, key);
}

function setActiveChip(stripInner, key) {
  stripInner.querySelectorAll('.day-chip').forEach(c => {
    c.classList.toggle('active', c.dataset.dayKey === key);
  });
  const active = stripInner.querySelector('.day-chip.active');
  if (!active) return;
  const sRect = stripInner.getBoundingClientRect();
  const aRect = active.getBoundingClientRect();
  if (aRect.left < sRect.left + 20 || aRect.right > sRect.right - 20) {
    active.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  }
}

function setupDayStripObserver(list, stripInner) {
  if (!('IntersectionObserver' in window)) return;
  const headers = list.querySelectorAll('.day-header');
  if (!headers.length) return;
  const observer = new IntersectionObserver((entries) => {
    let topMost = null;
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      if (!topMost || e.boundingClientRect.top < topMost.boundingClientRect.top) {
        topMost = e;
      }
    }
    if (topMost?.target.dataset.dayKey) setActiveChip(stripInner, topMost.target.dataset.dayKey);
  }, {
    rootMargin: '-80px 0px -70% 0px',
    threshold: 0,
  });
  headers.forEach(h => observer.observe(h));
}

function fmtDayHeader(iso) {
  const d = new Date(iso);
  const today = new Date(); today.setHours(0,0,0,0);
  const yst = new Date(today); yst.setDate(yst.getDate() - 1);
  const x = new Date(d); x.setHours(0,0,0,0);
  if (x.getTime() === today.getTime()) return 'Сегодня';
  if (x.getTime() === yst.getTime()) return 'Вчера';
  return d.toLocaleDateString('ru-RU', { weekday: 'short', day: '2-digit', month: 'long' });
}

// ---------- export ----------

function periodRange(key) {
  const now = new Date();
  const endIso = now.toISOString();
  if (key === 'all') return { fromIso: null, toIso: endIso };
  const startToday = new Date(now); startToday.setHours(0,0,0,0);
  const daysBack = key === 'today' ? 0 : key === '7d' ? 6 : 29;
  const start = new Date(startToday); start.setDate(start.getDate() - daysBack);
  return { fromIso: start.toISOString(), toIso: endIso };
}

async function collectExportData(profile, periodKey) {
  const { fromIso, toIso } = periodRange(periodKey);
  let records = await db.records
    .where('profileId').equals(profile.id)
    .filter(r => r.status === 'saved')
    .toArray();
  if (fromIso) {
    records = records.filter(r => r.sortMoment >= fromIso && r.sortMoment <= toIso);
  }
  records.sort((a,b) => (a.sortMoment > b.sortMoment ? 1 : -1));
  const recordIds = records.map(r => r.id);
  const allEvents = recordIds.length
    ? await db.events.where('recordId').anyOf(recordIds).toArray()
    : [];
  const eventsByRec = new Map();
  for (const ev of allEvents) {
    if (!eventsByRec.has(ev.recordId)) eventsByRec.set(ev.recordId, []);
    eventsByRec.get(ev.recordId).push(ev);
  }
  for (const evs of eventsByRec.values()) {
    evs.sort((a,b) => (a.moment > b.moment ? 1 : -1));
  }
  return { records, eventsByRec, fromIso, toIso };
}

function fmtExportDay(iso) {
  return new Date(iso).toLocaleDateString('ru-RU', {
    day: 'numeric', month: 'long', year: 'numeric', weekday: 'long',
  });
}
function fmtExportDateShort(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function fmtExportNow() {
  return new Date().toLocaleString('ru-RU', {
    day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function eventFieldLines(ev) {
  const type = window.TYPE_BY_KEY[ev.type];
  if (!type) return [];
  const out = [];
  for (const f of type.fields) {
    const v = ev.fields?.[f.key];
    if (v == null || (Array.isArray(v) && v.length === 0) || v === '') continue;
    if (f.kind === 'single') {
      const o = (f.options || []).find(o => o.key === v);
      if (o) out.push([f.label, o.label]);
    } else if (f.kind === 'multi') {
      const labels = v.map(k => (f.options || []).find(o => o.key === k)?.label).filter(Boolean);
      if (labels.length) out.push([f.label, labels.join(', ')]);
    } else if (f.kind === 'text') {
      if (String(v).trim()) out.push([f.label, String(v).trim()]);
    }
  }
  if (ev.note) out.push(['Комментарий к теме', ev.note]);
  return out;
}

function profileCategoriesLabel(profile) {
  return (profile.categories || [])
    .map(k => window.CATEGORY_BY_KEY[k]?.label)
    .filter(Boolean)
    .join(', ');
}

function buildTxt(meta, periodKey, data) {
  const { profile } = meta;
  const { records, eventsByRec, fromIso, toIso } = data;
  const periodLabel = {
    today: 'Сегодня',
    '7d': '7 дней',
    '30d': '30 дней',
    all: 'всё время',
  }[periodKey];
  const totalEvents = Array.from(eventsByRec.values()).reduce((s, a) => s + a.length, 0);
  const lines = [];
  lines.push(`Журнал · ${profile.name}`);
  const catLbl = profileCategoriesLabel(profile);
  lines.push(`Профиль: ${profile.name}${profile.age ? ' · ' + profile.age : ''}${catLbl ? ' · категории: ' + catLbl : ''}`);
  const effFrom = fromIso || (records[0] && records[0].sortMoment) || toIso;
  lines.push(`Период: ${periodLabel} (${fmtExportDateShort(effFrom)} – ${fmtExportDateShort(toIso)})`);
  lines.push(`Записей: ${records.length} · событий: ${totalEvents}`);
  lines.push(`Экспорт: ${fmtExportNow()}`);
  lines.push('');
  lines.push('─'.repeat(36));

  if (records.length === 0) {
    lines.push('');
    lines.push('Нет записей за выбранный период.');
    return lines.join('\n');
  }

  let lastDay = null;
  for (const r of records) {
    const d = new Date(r.sortMoment);
    const dayKey = d.toDateString();
    if (dayKey !== lastDay) {
      lines.push('');
      lines.push(fmtExportDay(r.sortMoment));
      lastDay = dayKey;
    }
    const evs = eventsByRec.get(r.id) || [];
    const time = fmtTime(r.sortMoment);
    if (evs.length === 0) {
      lines.push('');
      const comment = (r.comment || '').trim() || '(пустая запись)';
      lines.push(`${time}  ${comment}`);
      continue;
    }
    const typeLabels = evs.map(e => e.labelSnapshot || window.TYPE_BY_KEY[e.type]?.label || e.type);
    lines.push('');
    lines.push(`${time}  ${typeLabels.join(' + ')}`);
    for (const ev of evs) {
      const fields = eventFieldLines(ev);
      if (evs.length > 1) {
        lines.push(`  [${ev.labelSnapshot || ev.type}]`);
      }
      for (const [k, v] of fields) {
        lines.push(`    ${k}: ${v}`);
      }
    }
    if ((r.comment || '').trim()) {
      lines.push(`  — ${r.comment.trim()}`);
    }
  }
  return lines.join('\n');
}

function renderExportDom(meta, periodKey, data) {
  const { profile } = meta;
  const { records, eventsByRec, fromIso, toIso } = data;
  const periodLabel = {
    today: 'Сегодня',
    '7d': '7 дней',
    '30d': '30 дней',
    all: 'всё время',
  }[periodKey];
  const totalEvents = Array.from(eventsByRec.values()).reduce((s, a) => s + a.length, 0);
  const root = document.createElement('div');
  root.className = 'export-view';

  const h1 = document.createElement('h1');
  h1.textContent = `Журнал · ${profile.name}`;
  root.appendChild(h1);

  const metaEl = document.createElement('div');
  metaEl.className = 'export-meta';
  const effFrom = fromIso || (records[0] && records[0].sortMoment) || toIso;
  const catLbl = profileCategoriesLabel(profile);
  metaEl.innerHTML = [
    `Профиль: ${escapeHtml(profile.name)}${profile.age ? ' · ' + escapeHtml(profile.age) : ''}${catLbl ? ' · категории: ' + escapeHtml(catLbl) : ''}`,
    `Период: ${periodLabel} (${fmtExportDateShort(effFrom)} – ${fmtExportDateShort(toIso)})`,
    `Записей: ${records.length} · событий: ${totalEvents}`,
    `Экспорт: ${fmtExportNow()}`,
  ].map(l => `<div>${l}</div>`).join('');
  root.appendChild(metaEl);

  if (records.length === 0) {
    const empty = document.createElement('p');
    empty.textContent = 'Нет записей за выбранный период.';
    root.appendChild(empty);
    return root;
  }

  let lastDay = null;
  for (const r of records) {
    const d = new Date(r.sortMoment);
    const dayKey = d.toDateString();
    if (dayKey !== lastDay) {
      const h = document.createElement('h2');
      h.className = 'export-day';
      h.textContent = fmtExportDay(r.sortMoment);
      root.appendChild(h);
      lastDay = dayKey;
    }
    const evs = eventsByRec.get(r.id) || [];
    const rec = document.createElement('div');
    rec.className = 'export-record';
    const head = document.createElement('div');
    head.className = 'export-record-head';
    const time = fmtTime(r.sortMoment);
    const typeLabels = evs.length
      ? evs.map(e => e.labelSnapshot || window.TYPE_BY_KEY[e.type]?.label || e.type).join(' + ')
      : 'Заметка';
    head.innerHTML = `<span class="t">${time}</span>${escapeHtml(typeLabels)}`;
    rec.appendChild(head);

    for (const ev of evs) {
      if (evs.length > 1) {
        const sub = document.createElement('div');
        sub.className = 'export-field';
        sub.innerHTML = `<span class="fl">[${escapeHtml(ev.labelSnapshot || ev.type)}]</span>`;
        rec.appendChild(sub);
      }
      for (const [k, v] of eventFieldLines(ev)) {
        const line = document.createElement('div');
        line.className = 'export-field';
        line.innerHTML = `<span class="fl">${escapeHtml(k)}:</span> ${escapeHtml(v)}`;
        rec.appendChild(line);
      }
    }
    if ((r.comment || '').trim()) {
      const c = document.createElement('div');
      c.className = 'export-comment';
      c.textContent = `— ${r.comment.trim()}`;
      rec.appendChild(c);
    }
    root.appendChild(rec);
  }
  return root;
}

function exportFilename(profile, periodKey, data, ext) {
  const { records, fromIso, toIso } = data;
  const subj = profile.id || 'export';
  const toStr = fmtExportDateShort(toIso);
  if (periodKey === 'today') return `kid-journal-${subj}-${toStr}.${ext}`;
  const fromStr = fromIso
    ? fmtExportDateShort(fromIso)
    : fmtExportDateShort((records[0] && records[0].sortMoment) || toIso);
  return `kid-journal-${subj}-${fromStr}-to-${toStr}.${ext}`;
}

async function deliverTxt(filename, text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const file = new File([blob], filename, { type: 'text/plain' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename });
      return;
    } catch (e) {
      if (e && e.name === 'AbortError') return;
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function deliverPdfViaPrint(filename, dom) {
  const prevTitle = document.title;
  document.title = filename.replace(/\.pdf$/, '');
  document.body.appendChild(dom);
  const cleanup = () => {
    dom.remove();
    document.title = prevTitle;
    window.removeEventListener('afterprint', cleanup);
  };
  window.addEventListener('afterprint', cleanup);
  window.print();
  setTimeout(cleanup, 60000);
}

function openExport() {
  const profile = getActiveProfile();
  const meta = { profile };
  const node = cloneTpl('tpl-export');
  const periodRow = $('[data-period]', node);
  const formatRow = $('[data-format]', node);
  const summary = $('[data-summary]', node);
  const runBtn = $('[data-run]', node);

  let periodKey = 'today';
  let formatKey = 'txt';
  let currentData = null;

  const pickOpt = (row, selectedBtn) => {
    $$('button', row).forEach(b => b.classList.toggle('selected', b === selectedBtn));
  };

  const refresh = async () => {
    currentData = await collectExportData(profile, periodKey);
    const totalEvents = Array.from(currentData.eventsByRec.values()).reduce((s, a) => s + a.length, 0);
    const n = currentData.records.length;
    if (n === 0) {
      summary.textContent = 'Нет записей за выбранный период.';
      runBtn.disabled = true;
    } else {
      summary.textContent = `${n} ${pluralRu(n, ['запись','записи','записей'])} · ${totalEvents} ${pluralRu(totalEvents, ['событие','события','событий'])}`;
      runBtn.disabled = false;
    }
  };

  $$('button', periodRow).forEach(b => {
    b.addEventListener('click', () => {
      periodKey = b.dataset.periodKey;
      pickOpt(periodRow, b);
      refresh();
    });
  });
  $$('button', formatRow).forEach(b => {
    b.addEventListener('click', () => {
      formatKey = b.dataset.formatKey;
      pickOpt(formatRow, b);
    });
  });

  const close = () => node.remove();
  $('[data-cancel]', node).addEventListener('click', close);
  node.addEventListener('click', (e) => {
    if (e.target === node) close();
  });

  runBtn.addEventListener('click', async () => {
    if (!currentData || currentData.records.length === 0) return;
    const filename = exportFilename(profile, periodKey, currentData, formatKey);
    if (formatKey === 'txt') {
      await deliverTxt(filename, buildTxt(meta, periodKey, currentData));
    } else {
      deliverPdfViaPrint(filename, renderExportDom(meta, periodKey, currentData));
    }
    close();
  });

  document.body.appendChild(node);
  refresh();
}

function pluralRu(n, forms) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return forms[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return forms[1];
  return forms[2];
}
