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

// v3 (2026-04-24) — theme-primary. Profile shape:
//   categories[], mainTileOrder[], mainTileHidden[], age → удаляются.
//   themes[] (ordered, toggle=include) + themeFieldOverrides{} + description (из age).
// См. v3-spec.md §4. One-way door — перед upgrade'ом bootstrap запускает
// runPreMigrationBackupIfNeeded() отдельным Dexie-instance'ом на v2 и дампит
// всю БД в JSON (см. runPreMigrationBackupIfNeeded ниже).
db.version(3).stores({
  config:  '&id',
  records: '++id, profileId, status, postedAt, sortMoment',
  events:  '++id, recordId, type, moment',
}).upgrade(async (trans) => {
  await trans.table('config').toCollection().modify(cfg => {
    if (!cfg.profiles) return;
    cfg.profiles = cfg.profiles.map(p => {
      if (p.themes) return p; // уже v3
      const hidden = new Set(p.mainTileHidden || []);
      const ordered = (p.mainTileOrder || []).filter(k => !hidden.has(k));
      return {
        id: p.id,
        name: p.name,
        description: p.age || '',
        themes: ordered,
        themeFieldOverrides: {},
      };
    });
  });
});

// v4 (2026-04-25) — Custom Types (фаза 2.5). Новая таблица userTypes с
// profileId-индексом. records/events/config без изменений. Темы per-profile.
// См. custom-types-spec.md §3.
db.version(4).stores({
  config:    '&id',
  records:   '++id, profileId, status, postedAt, sortMoment',
  events:    '++id, recordId, type, moment',
  userTypes: '&key, profileId, createdAt',
}); // upgrade пуст — таблица новая, существующие данные не трогаем

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

// Перед v3 upgrade'ом: если БД ещё на v2 и бэкап не делался —
// открыть временный Dexie-instance ТОЛЬКО с v2-схемой (без v3), снять дамп
// всей базы в JSON через KJMigrate.exportV2Backup, поставить флаг,
// закрыть. После этого основной `db` с v3-схемой откроется и запустит upgrade.
// Если navigator.share отменят — throw, чтобы upgrade НЕ запустился.
async function runPreMigrationBackupIfNeeded() {
  if (!window.indexedDB?.databases) return; // старые Safari — best-effort skip
  let storedIdbVersion = 0;
  try {
    const dbs = await indexedDB.databases();
    const ours = dbs.find(d => d.name === 'kidjournal-v5');
    storedIdbVersion = ours?.version || 0;
  } catch { return; }

  // Dexie хранит версию как dexieVersion * 10. v2 = IDB version 20.
  if (storedIdbVersion !== 20) return; // либо свежая (0), либо уже >=30 (v3+)

  const backupDb = new Dexie('kidjournal-v5');
  backupDb.version(2).stores({
    config:  '&id',
    records: '++id, profileId, status, postedAt, sortMoment',
    events:  '++id, recordId, type, moment',
  });
  await backupDb.open();

  const cfg = await backupDb.config.get(CONFIG_ID);
  if (cfg?.v2BackupDone) {
    await backupDb.close();
    return;
  }

  showBanner('Сохраняю бэкап v2 перед обновлением схемы…');
  try {
    const result = await window.KJMigrate.exportV2Backup(backupDb);
    const updated = { ...(cfg || { id: CONFIG_ID }), v2BackupDone: true, v2BackupAt: new Date().toISOString(), v2BackupMeta: result };
    await backupDb.config.put(updated);
    showBanner(`Бэкап v2 сохранён (${result.counts.records} записей, ${result.counts.events} событий). Продолжаю обновление.`, { variant: 'ok', autoHide: 4000 });
  } catch (e) {
    await backupDb.close();
    throw new Error(`Бэкап v2 не удалось сохранить (${e.message || e}). Обновление схемы НЕ запущено — перезапусти приложение и попробуй ещё раз.`);
  }
  await backupDb.close();
}

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

// ---------- custom types (phase 2.5) ----------

// Per-profile user types — держим в памяти только активного профиля.
// Перезагружаем на boot и при смене активного профиля.
// См. custom-types-spec.md §4.1.
window.USER_TYPES = [];

function rebuildTypeByKey() {
  const idx = {};
  for (const t of window.TYPES) idx[t.key] = Object.assign({}, t, { source: 'builtin' });
  for (const t of window.USER_TYPES) {
    if (idx[t.key]) console.warn('[custom-types] key collision:', t.key);
    idx[t.key] = Object.assign({}, t, { source: 'user' });
  }
  window.TYPE_BY_KEY = idx;
}

async function loadUserTypesForActiveProfile() {
  const profile = getActiveProfile();
  if (!profile) {
    window.USER_TYPES = [];
  } else {
    window.USER_TYPES = await db.userTypes
      .where('profileId').equals(profile.id)
      .sortBy('createdAt');
  }
  rebuildTypeByKey();
}

// Возвращает все доступные темы для активного профиля — builtin + user.
// Используется везде, где раньше был `window.TYPES`.
function allTypes() {
  return [...window.TYPES, ...window.USER_TYPES];
}

// Генерация id'ов: 8-char base36. Префиксы u_/f_/o_ — для отладки.
function randId(prefix) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return prefix + s;
}
function newTypeKey()  { return randId('u_'); }
function newFieldKey() { return randId('f_'); }
function newOptionKey(){ return randId('o_'); }

// Валидация типа. Возвращает массив ошибок (строки) или [] если всё ок.
function validateType(type) {
  const errs = [];
  const label = (type.label || '').trim();
  const icon = (type.icon || '').trim();
  if (!label) errs.push('Название темы не заполнено');
  if (!icon) errs.push('Иконка не выбрана');
  const fieldLabels = new Set();
  for (const f of (type.fields || [])) {
    const fl = (f.label || '').trim();
    if (!fl) { errs.push('Поле без названия'); continue; }
    if (fieldLabels.has(fl.toLowerCase())) errs.push(`Поле «${fl}» — дубль`);
    fieldLabels.add(fl.toLowerCase());
    if (f.kind === 'single' || f.kind === 'multi') {
      const opts = f.options || [];
      if (opts.length < 2) errs.push(`Поле «${fl}» — нужно ≥2 значений`);
      const optLabels = new Set();
      for (const o of opts) {
        const ol = (o.label || '').trim();
        if (!ol) { errs.push(`Поле «${fl}» — пустое значение`); continue; }
        if (optLabels.has(ol.toLowerCase())) errs.push(`Поле «${fl}» — дубль «${ol}»`);
        optLabels.add(ol.toLowerCase());
      }
    }
  }
  return errs;
}

// Сохранение нового или изменённого user type. Возвращает сохранённый type.
async function saveUserType(type, isNew) {
  const profile = getActiveProfile();
  if (!profile) throw new Error('Нет активного профиля');
  const record = {
    key: type.key,
    profileId: profile.id,
    label: type.label.trim(),
    icon: type.icon.trim(),
    description: (type.description || '').trim() || undefined,
    fields: (type.fields || []).map(f => ({
      key: f.key,
      label: f.label.trim(),
      kind: f.kind,
      required: !!f.required,
      ...(f.kind === 'text' && f.placeholder ? { placeholder: f.placeholder.trim() } : {}),
      ...((f.kind === 'single' || f.kind === 'multi') ? {
        options: (f.options || []).map(o => ({ key: o.key, label: o.label.trim() })),
      } : {}),
    })),
    createdAt: isNew ? Date.now() : (type.createdAt || Date.now()),
  };
  await db.userTypes.put(record);
  if (isNew) {
    // Автоматически включаем в активный профиль.
    const cur = state.config.profiles.find(p => p.id === profile.id);
    const themes = [...(cur.themes || []), record.key];
    await saveProfilePatch(profile.id, { themes });
  } else {
    // Очистим overrides от удалённых полей: для текущего профиля выдрать
    // лишние ключи из themeFieldOverrides[type.key].
    const cur = state.config.profiles.find(p => p.id === profile.id);
    const ov = (cur.themeFieldOverrides || {})[record.key];
    if (ov) {
      const validFieldKeys = new Set(record.fields.map(f => f.key));
      const cleaned = {};
      for (const [k, v] of Object.entries(ov)) {
        if (validFieldKeys.has(k)) cleaned[k] = v;
      }
      const overrides = { ...(cur.themeFieldOverrides || {}) };
      if (Object.keys(cleaned).length) overrides[record.key] = cleaned;
      else delete overrides[record.key];
      await saveProfilePatch(profile.id, { themeFieldOverrides: overrides });
    }
  }
  await loadUserTypesForActiveProfile();
  return record;
}

// Удаление user type — из userTypes + из themes + themeFieldOverrides активного профиля.
// Старые events остаются (labelSnapshot хранит имя темы — история рендерит readonly).
async function deleteUserType(key) {
  const profile = getActiveProfile();
  if (!profile) return;
  await db.userTypes.delete(key);
  const cur = state.config.profiles.find(p => p.id === profile.id);
  const themes = (cur.themes || []).filter(k => k !== key);
  const overrides = { ...(cur.themeFieldOverrides || {}) };
  delete overrides[key];
  await saveProfilePatch(profile.id, { themes, themeFieldOverrides: overrides });
  await loadUserTypesForActiveProfile();
}

// Сколько events висит на теме — для confirm-диалога удаления.
async function countEventsForType(key) {
  return db.events.where('type').equals(key).count();
}

// v3: темы = profile.themes (упорядоченный массив, toggle=include, порядок=drag на главной).
// Категории больше не state, используются только как пресет в «+ Добавить»/онбординге.
function getProfileThemeKeys(profile) {
  return profile?.themes ? profile.themes.slice() : [];
}

function getMainTileOrder(profile) {
  return getProfileThemeKeys(profile);
}

function getMainTiles(profile) {
  return getProfileThemeKeys(profile);
}

// Для onboarding/«+ Добавить»: union тем из выбранных категорий-пресетов.
function unionThemesFromCategories(categoryKeys) {
  const set = new Set();
  for (const key of categoryKeys || []) {
    const cat = window.CATEGORY_BY_KEY[key];
    if (!cat) continue;
    for (const t of (cat.themes || cat.activeTypes || [])) set.add(t);
  }
  return [...set];
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
      const arr = Array.isArray(v) ? v : [v];
      const labels = arr.map(k => opts.find(o => o.key === k)?.label).filter(Boolean);
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
    await runPreMigrationBackupIfNeeded();
    await ensureDbOpen();
    requestPersistentStorage();
    state.config = await loadConfig();
    await loadUserTypesForActiveProfile();
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
    description: prefill?.description || prefill?.age || '',
    categories: prefill?.categories ? prefill.categories.slice() : [],
    themes: [],
  };
  renderOnboarding();
}

function renderOnboarding() {
  state.screen = 'onboarding';
  const node = cloneTpl('tpl-onboarding');
  const step = state.onb.step;
  const titles = ['Профиль', 'Что будешь отмечать'];
  const subs = [
    'Кого наблюдаем. Имя и короткое описание.',
    'Тап по категории — включит её набор. Или выбери темы по одной.',
  ];
  $('[data-step]', node).textContent = `Шаг ${step + 1} из 2`;
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
        <span class="lbl">Описание</span>
        <input type="text" id="onb-desc" placeholder="например, 3 года, ЖКТ" value="${escapeHtml(state.onb.description)}">
      </label>
    `;
  } else if (step === 1) {
    renderOnboardingThemesStep(body);
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
  next.textContent = step === 1 ? 'Начать' : 'Далее';
  next.addEventListener('click', async () => {
    if (step === 0) {
      const name = $('#onb-name').value.trim();
      const description = $('#onb-desc').value.trim();
      if (!name) { alert('Имя обязательно'); return; }
      state.onb.name = name;
      state.onb.description = description;
      state.onb.step = 1;
      renderOnboarding();
    } else {
      if (state.onb.themes.length === 0) { alert('Добавь хотя бы одну тему'); return; }
      await finishOnboarding();
    }
  });

  setScreen(node);
}

// v3: онбординг шаг 2 — карточки категорий-пресетов + полный список тем с UISwitch.
// То же что «+ Добавить» sheet в Profile detail, но в full-screen form.
function renderOnboardingThemesStep(body) {
  const activeSet = new Set(state.onb.themes);

  const wrap = document.createElement('div');
  wrap.className = 'onb-themes';

  const catsLbl = document.createElement('div');
  catsLbl.className = 'v3-sheet-section-lbl';
  catsLbl.textContent = 'КАТЕГОРИИ-ПРЕСЕТЫ';
  wrap.appendChild(catsLbl);

  const catsCard = document.createElement('div');
  catsCard.className = 'v3-cats-card';
  for (const c of window.CATEGORIES) {
    const themes = c.themes || c.activeTypes || [];
    const onCount = themes.filter(k => activeSet.has(k)).length;
    const row = document.createElement('div');
    row.className = 'v3-cat-row';
    row.innerHTML = `
      <span class="v3-cat-icon">${c.icon}</span>
      <div class="v3-cat-info">
        <span class="v3-cat-label">${escapeHtml(c.label)}</span>
        <span class="v3-cat-sub">${themes.length} тем · ${escapeHtml(c.description || '')}</span>
      </div>
      <button type="button" class="link">${onCount === themes.length ? '✓ Все' : '+ Все'}</button>
    `;
    row.querySelector('button').addEventListener('click', () => {
      const preset = c.themes || c.activeTypes || [];
      const set = new Set(state.onb.themes);
      for (const k of preset) set.add(k);
      state.onb.themes = [...set];
      renderOnboarding();
    });
    catsCard.appendChild(row);
  }
  wrap.appendChild(catsCard);

  const themesLbl = document.createElement('div');
  themesLbl.className = 'v3-sheet-section-lbl';
  themesLbl.textContent = `ВЫБРАНО · ${state.onb.themes.length} ИЗ ${window.TYPES.length}`;
  wrap.appendChild(themesLbl);

  const themesCard = document.createElement('div');
  themesCard.className = 'v3-themes-card';
  for (const t of window.TYPES) {
    const isOn = activeSet.has(t.key);
    const row = document.createElement('div');
    row.className = 'v3-theme-toggle-row';
    row.innerHTML = `
      <span class="v3-theme-icon">${t.icon}</span>
      <span class="v3-theme-label">${escapeHtml(t.label)}</span>
      <button type="button" class="uiswitch ${isOn ? 'on' : 'off'}">
        <span class="uiswitch-knob"></span>
      </button>
    `;
    row.querySelector('.uiswitch').addEventListener('click', () => {
      const set = new Set(state.onb.themes);
      if (set.has(t.key)) set.delete(t.key);
      else set.add(t.key);
      state.onb.themes = [...set];
      renderOnboarding();
    });
    themesCard.appendChild(row);
  }
  wrap.appendChild(themesCard);

  body.appendChild(wrap);
}

// v2-compat: старое имя, делегирует в v3-версию.
function unionThemeKeysFromCategories(categoryKeys) {
  return unionThemesFromCategories(categoryKeys);
}

async function finishOnboarding() {
  const { name, description, themes, mode } = state.onb;

  if (mode === 'new-profile' && state.config) {
    const existingIds = state.config.profiles.map(p => p.id);
    const newProfile = {
      id: genProfileId(name, existingIds),
      name,
      description,
      themes: themes.slice(),
      themeFieldOverrides: {},
    };
    const updated = {
      ...state.config,
      profiles: [...state.config.profiles, newProfile],
      activeProfileId: newProfile.id,
    };
    await saveConfig(updated);
    state.config = await loadConfig();
    await loadUserTypesForActiveProfile();
    state.onb = null;
    await renderMain();
    return;
  }

  const profile = {
    id: genProfileId(name, []),
    name,
    description,
    themes: themes.slice(),
    themeFieldOverrides: {},
  };
  const cfg = {
    profiles: [profile],
    activeProfileId: profile.id,
  };
  await saveConfig(cfg);
  state.config = await loadConfig();
  await loadUserTypesForActiveProfile();
  state.onb = null;
  await renderMain();
}

// ---------- main screen ----------

// v3 баннеры на главной: пустой профиль, новые темы в types.js.
// Возвращает DOM-ноду с баннером(ами) или null.
function renderV3Banners(profile) {
  const cfg = state.config;
  const dismissed = new Set(cfg.dismissedThemeBanners || []);
  const profileThemes = new Set(profile.themes || []);
  const newThemes = window.TYPES.filter(t => !profileThemes.has(t.key) && !dismissed.has(t.key));

  const isEmpty = (profile.themes || []).length === 0;
  if (!isEmpty && newThemes.length === 0) return null;

  const wrap = document.createElement('div');
  wrap.className = 'v3-banner-wrap';

  if (isEmpty) {
    const b = document.createElement('div');
    b.className = 'v3-banner v3-banner-empty';
    b.innerHTML = `
      <span class="v3-banner-icon">📭</span>
      <div class="v3-banner-body">
        <span class="v3-banner-title">В профиле нет тем</span>
        <span class="v3-banner-sub">Добавь набор из категории или выбери темы по одной.</span>
      </div>
      <button type="button" class="link" data-open-add>Открыть</button>
    `;
    b.querySelector('[data-open-add]').addEventListener('click', () => openAddThemesSheet(profile.id));
    wrap.appendChild(b);
  } else if (newThemes.length > 0) {
    const names = newThemes.map(t => t.label).join(', ');
    const b = document.createElement('div');
    b.className = 'v3-banner v3-banner-new';
    b.innerHTML = `
      <span class="v3-banner-icon">✨</span>
      <div class="v3-banner-body">
        <span class="v3-banner-title">Новая тема: ${escapeHtml(names)}</span>
        <span class="v3-banner-sub">Добавь в профиль если нужно.</span>
      </div>
      <button type="button" class="link" data-open-add>Открыть</button>
      <button type="button" class="link muted" data-dismiss>Позже</button>
    `;
    b.querySelector('[data-open-add]').addEventListener('click', () => openAddThemesSheet(profile.id));
    b.querySelector('[data-dismiss]').addEventListener('click', async () => {
      const updatedDismiss = [...dismissed, ...newThemes.map(t => t.key)];
      await saveConfig({ ...cfg, dismissedThemeBanners: updatedDismiss });
      state.config = await loadConfig();
      await renderMain();
    });
    wrap.appendChild(b);
  }

  return wrap;
}

async function renderMain() {
  state.screen = 'main';
  const node = cloneTpl('tpl-main');
  const profile = getActiveProfile();
  if (!profile) { startOnboarding(); return; }

  $('[data-profile-name]', node).textContent = profile.name;
  $('[data-profile-switcher]', node).addEventListener('click', () => openProfileSwitcher());
  $('[data-settings]', node).addEventListener('click', () => renderSettings());

  // v3 баннеры — пустой профиль / новые темы в types.js
  const v3Banners = renderV3Banners(profile);
  if (v3Banners) {
    const head = $('.main-head', node);
    head.after(v3Banners);
  }

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
    const themesCount = (p.themes || []).length;
    const descBit = p.description ? `${p.description} · ` : '';
    const sub = `${descBit}${themesCount} тем`;
    row.innerHTML = `
      <span class="ps-dot ${active ? 'on' : 'off'}" aria-hidden="true"></span>
      <div class="ps-main">
        <span class="ps-name">${escapeHtml(p.name)}</span>
        <span class="ps-sub">${escapeHtml(sub)}</span>
      </div>
      ${active ? '<span class="ps-check" aria-hidden="true">✓</span>' : ''}
    `;
    row.addEventListener('click', async () => {
      if (!active) {
        const upd = { ...cfg, activeProfileId: p.id };
        await saveConfig(upd);
        state.config = await loadConfig();
        await loadUserTypesForActiveProfile();
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
    const themesCount = (p.themes || []).length;
    const sub = (p.description ? p.description + ' · ' : '') + `${themesCount} тем`;
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

  // v3: «Темы на главном» как отдельный экран удалён — управление темами теперь
  // в Profile detail (flat list + UISwitch), порядок — long-press на главной.

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
  aboutGroup.appendChild(sgRow({
    title: 'Сохранить бэкап',
    sub: 'JSON-дамп всех записей через share-sheet',
    chev: true,
    onTap: async () => {
      try {
        const res = await window.KJMigrate.exportCurrentBackup(db);
        showBanner(
          `Бэкап сохранён: ${res.filename} (${res.counts.records} записей, ${res.counts.events} событий).`,
          { variant: 'ok', autoHide: 5000 }
        );
      } catch (e) {
        if (e && e.name === 'AbortError') return; // пользователь отменил share
        showError(e);
      }
    },
  }));
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

// --- settings: profile detail (v3) ---
//
// v3: flat theme list с UISwitch. Галка = добавить/убрать из profile.themes.
// Тап по телу строки = Field-toggle sheet (TODO). «+ Добавить» — sheet с
// категориями-пресетами для bulk-add (TODO). Пока чистый on/off toggle.

async function saveProfilePatch(profileId, patch) {
  const cfg = state.config;
  const profiles = cfg.profiles.map(p => p.id === profileId ? { ...p, ...patch } : p);
  await saveConfig({ ...cfg, profiles });
  state.config = await loadConfig();
}

function renderSettingsProfile(profileId) {
  state.screen = 'settings-profile';
  const cfg = state.config;
  const profile = cfg.profiles.find(p => p.id === profileId);
  if (!profile) { renderSettings(); return; }

  const node = document.createElement('section');
  node.className = 'settings';

  // Header
  const head = document.createElement('header');
  head.className = 'sub-head';
  head.innerHTML = `<button class="btn-back" data-back>←</button><h1>${escapeHtml(profile.name)}</h1>`;
  node.appendChild(head);

  // Name + Description card
  const metaLbl = sgLabel('О профиле');
  node.appendChild(metaLbl);
  const metaGroup = sgGroup();
  metaGroup.innerHTML = `
    <div class="sg-input-row"><span class="lbl">Имя</span><input type="text" data-name value="${escapeHtml(profile.name)}"></div>
    <div class="sg-input-row"><span class="lbl">Описание</span><input type="text" data-desc value="${escapeHtml(profile.description || '')}" placeholder="3 года, ЖКТ"></div>
  `;
  node.appendChild(metaGroup);

  // Themes section
  const themesHeader = document.createElement('div');
  themesHeader.className = 'sg-label sg-label-row';
  const themes = (profile.themes || []).slice();
  themesHeader.innerHTML = `<span>ТЕМЫ · ${themes.length}</span><button type="button" class="link" data-add-themes>+ Добавить</button>`;
  node.appendChild(themesHeader);

  const themesGroup = sgGroup();
  themesGroup.className = 'sg-group themes-group';
  if (themes.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'sg-row static';
    empty.innerHTML = `<div class="sg-row-main"><span class="sg-row-sub">Пока нет тем. Добавь набор через «+ Добавить».</span></div>`;
    themesGroup.appendChild(empty);
  } else {
    for (const key of themes) {
      const t = window.TYPE_BY_KEY[key];
      if (!t) continue;
      const row = document.createElement('div');
      row.className = 'theme-row-v3';
      row.innerHTML = `
        <button type="button" class="theme-row-body" data-key="${escapeHtml(key)}">
          <span class="theme-row-icon">${t.icon}</span>
          <span class="theme-row-label">${escapeHtml(t.label)}</span>
        </button>
        <button type="button" class="uiswitch on" data-toggle="${escapeHtml(key)}" aria-label="Переключить тему ${escapeHtml(t.label)}">
          <span class="uiswitch-knob"></span>
        </button>
      `;
      themesGroup.appendChild(row);
    }
    // Off-themes (defined но не в profile) — показываем в той же группе, off-state.
    // Включаем и builtin, и user types активного профиля (allTypes()).
    const onSet = new Set(themes);
    for (const t of allTypes()) {
      if (onSet.has(t.key)) continue;
      const row = document.createElement('div');
      row.className = 'theme-row-v3 off';
      row.innerHTML = `
        <button type="button" class="theme-row-body" data-key="${escapeHtml(t.key)}">
          <span class="theme-row-icon">${t.icon}</span>
          <span class="theme-row-label">${escapeHtml(t.label)}</span>
        </button>
        <button type="button" class="uiswitch off" data-toggle="${escapeHtml(t.key)}" aria-label="Переключить тему ${escapeHtml(t.label)}">
          <span class="uiswitch-knob"></span>
        </button>
      `;
      themesGroup.appendChild(row);
    }
  }
  node.appendChild(themesGroup);

  // Delete profile
  node.appendChild(sgLabel(' '));
  const dangerGroup = sgGroup();
  dangerGroup.appendChild(sgRow({
    title: 'Удалить профиль',
    sub: 'записи этого профиля тоже удалятся',
    danger: true,
    onTap: async () => {
      const last = cfg.profiles.length === 1;
      const msg = last
        ? 'Удалить единственный профиль? После удаления откроется онбординг (записи удалятся).'
        : `Удалить профиль «${profile.name}»? Все записи этого профиля будут удалены.`;
      if (!confirm(msg)) return;
      if (!confirm('Точно удалить? Действие необратимое.')) return;
      const toDelete = await db.records.where('profileId').equals(profileId).toArray();
      for (const r of toDelete) {
        await db.events.where('recordId').equals(r.id).delete();
      }
      await db.records.where('profileId').equals(profileId).delete();
      await db.userTypes.where('profileId').equals(profileId).delete(); // custom types cascade
      const remaining = cfg.profiles.filter(p => p.id !== profileId);
      if (remaining.length === 0) {
        await db.config.delete(CONFIG_ID);
        state.config = null;
        window.USER_TYPES = [];
        rebuildTypeByKey();
        startOnboarding();
        return;
      }
      const newActive = cfg.activeProfileId === profileId ? remaining[0].id : cfg.activeProfileId;
      await saveConfig({ ...cfg, profiles: remaining, activeProfileId: newActive });
      state.config = await loadConfig();
      await loadUserTypesForActiveProfile();
      renderSettings();
    },
  }));
  node.appendChild(dangerGroup);

  // --- wiring ---
  const nameEl = $('[data-name]', node);
  const descEl = $('[data-desc]', node);

  async function saveMeta() {
    const name = nameEl.value.trim() || profile.name;
    const description = descEl.value.trim();
    await saveProfilePatch(profileId, { name, description });
  }

  // Toggle switches
  node.addEventListener('click', async (e) => {
    const toggleBtn = e.target.closest('[data-toggle]');
    if (toggleBtn) {
      const key = toggleBtn.dataset.toggle;
      const cur = state.config.profiles.find(p => p.id === profileId);
      const curThemes = cur?.themes || [];
      const isOn = curThemes.includes(key);
      const next = isOn ? curThemes.filter(k => k !== key) : [...curThemes, key];
      await saveProfilePatch(profileId, { themes: next });
      renderSettingsProfile(profileId); // re-render
      return;
    }
    const bodyBtn = e.target.closest('[data-key]');
    if (bodyBtn) {
      const key = bodyBtn.dataset.key;
      await saveMeta();
      openFieldToggleSheet(profileId, key);
      return;
    }
  });

  // + Add
  $('[data-add-themes]', node)?.addEventListener('click', async () => {
    await saveMeta();
    openAddThemesSheet(profileId);
  });

  $('[data-back]', node).addEventListener('click', async () => {
    await saveMeta();
    renderSettings();
  });

  setScreen(node);
}

// v3: Field-toggle bottom sheet — per-profile on/off для optional полей темы.
// Required поля показаны disabled'ом с лейблом «обязательно».
// Save-on-toggle: каждый клик пишет в profile.themeFieldOverrides[themeKey][fieldKey].
function openFieldToggleSheet(profileId, themeKey) {
  const type = window.TYPE_BY_KEY[themeKey];
  if (!type) return;
  const cfg = state.config;
  const profile = cfg.profiles.find(p => p.id === profileId);
  if (!profile) return;

  const backdrop = document.createElement('div');
  backdrop.className = 'v3-sheet-backdrop';
  const sheet = document.createElement('div');
  sheet.className = 'v3-sheet';
  backdrop.appendChild(sheet);

  const close = () => backdrop.remove();

  function render() {
    const overrides = (profile.themeFieldOverrides || {})[themeKey] || {};
    sheet.innerHTML = `
      <div class="v3-sheet-handle" aria-hidden="true"></div>
      <div class="v3-sheet-title-row">
        <h2>Поля · ${escapeHtml(type.label)}</h2>
        <button type="button" class="link" data-done>Готово</button>
      </div>
      <p class="v3-sheet-hint">Что показывать в форме записи для этого профиля. Обязательные нельзя выключить.</p>
      <div class="v3-fields-card"></div>
    `;
    const card = sheet.querySelector('.v3-fields-card');
    for (const f of type.fields) {
      const row = document.createElement('div');
      row.className = 'v3-field-row';
      const optionsText = fieldOptionsText(f);
      row.innerHTML = `
        <div class="v3-field-info">
          <span class="v3-field-title">${escapeHtml(f.label)}</span>
          ${optionsText ? `<span class="v3-field-sub">${escapeHtml(optionsText)}</span>` : ''}
        </div>
      `;
      if (f.required) {
        const tag = document.createElement('span');
        tag.className = 'v3-field-required';
        tag.textContent = 'обязательно';
        row.appendChild(tag);
      } else {
        const isOff = overrides[f.key] === false;
        const sw = document.createElement('button');
        sw.type = 'button';
        sw.className = 'uiswitch ' + (isOff ? 'off' : 'on');
        sw.innerHTML = '<span class="uiswitch-knob"></span>';
        sw.dataset.field = f.key;
        row.appendChild(sw);
      }
      card.appendChild(row);
    }
  }

  sheet.addEventListener('click', async (e) => {
    if (e.target.closest('[data-done]')) { close(); return; }
    const swBtn = e.target.closest('[data-field]');
    if (!swBtn) return;
    const fieldKey = swBtn.dataset.field;
    const curProfile = state.config.profiles.find(p => p.id === profileId);
    const overrides = { ...(curProfile.themeFieldOverrides || {}) };
    const themeOv = { ...(overrides[themeKey] || {}) };
    const currentlyOff = themeOv[fieldKey] === false;
    if (currentlyOff) {
      delete themeOv[fieldKey]; // включить = убрать override
    } else {
      themeOv[fieldKey] = false;
    }
    if (Object.keys(themeOv).length === 0) {
      delete overrides[themeKey];
    } else {
      overrides[themeKey] = themeOv;
    }
    await saveProfilePatch(profileId, { themeFieldOverrides: overrides });
    // update local reference
    Object.assign(profile, state.config.profiles.find(p => p.id === profileId));
    render();
  });

  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });

  render();
  document.body.appendChild(backdrop);
}

// Хелпер: формирует строку опций поля для подписи (e.g. «норма / запор / диарея»).
function fieldOptionsText(f) {
  if (f.kind === 'text') return 'свободный текст';
  if (Array.isArray(f.options)) {
    return f.options.map(o => o.label).join(' / ');
  }
  return '';
}

// v3: «+ Добавить» sheet — категории-пресеты + плоский список всех тем.
function openAddThemesSheet(profileId) {
  const cfg = state.config;
  const profile = cfg.profiles.find(p => p.id === profileId);
  if (!profile) return;

  // Работаем с локальной копией tempThemes, коммитим на Готово.
  let tempThemes = (profile.themes || []).slice();

  const backdrop = document.createElement('div');
  backdrop.className = 'v3-sheet-backdrop';
  const sheet = document.createElement('div');
  sheet.className = 'v3-sheet v3-sheet-tall';
  backdrop.appendChild(sheet);

  const close = () => backdrop.remove();

  function render() {
    const activeSet = new Set(tempThemes);
    sheet.innerHTML = `
      <div class="v3-sheet-handle" aria-hidden="true"></div>
      <div class="v3-sheet-title-row">
        <h2>Добавить темы</h2>
        <button type="button" class="link" data-apply>Готово</button>
      </div>
      <p class="v3-sheet-hint">Тап «+ Все» — включит весь пресет категории. Или выбери по одной ниже.</p>
      <div class="v3-sheet-section-lbl">КАТЕГОРИИ-ПРЕСЕТЫ</div>
      <div class="v3-cats-card"></div>
      <div class="v3-sheet-section-lbl">ВСЕ ТЕМЫ</div>
      <div class="v3-themes-card"></div>
      <div class="v3-sheet-section-lbl" data-own-lbl>СВОИ ТЕМЫ · 0</div>
      <div class="v3-own-card" data-own-card></div>
      <button type="button" class="v3-create-own-btn" data-create-own>+ Создать свою тему</button>
      <p class="v3-sheet-hint">Свои темы видны только в этом профиле.</p>
    `;

    const catsCard = sheet.querySelector('.v3-cats-card');
    for (const c of window.CATEGORIES) {
      const themes = c.themes || c.activeTypes || [];
      const onCount = themes.filter(k => activeSet.has(k)).length;
      const row = document.createElement('div');
      row.className = 'v3-cat-row';
      row.innerHTML = `
        <span class="v3-cat-icon">${c.icon}</span>
        <div class="v3-cat-info">
          <span class="v3-cat-label">${escapeHtml(c.label)}</span>
          <span class="v3-cat-sub">${themes.length} тем · ${escapeHtml(c.description || '')}</span>
        </div>
        <button type="button" class="link" data-preset="${escapeHtml(c.key)}">
          ${onCount === themes.length ? '✓ Все' : '+ Все'}
        </button>
      `;
      catsCard.appendChild(row);
    }

    const themesCard = sheet.querySelector('.v3-themes-card');
    for (const t of window.TYPES) {
      const isOn = activeSet.has(t.key);
      const row = document.createElement('div');
      row.className = 'v3-theme-toggle-row';
      row.innerHTML = `
        <span class="v3-theme-icon">${t.icon}</span>
        <span class="v3-theme-label">${escapeHtml(t.label)}</span>
        <button type="button" class="uiswitch ${isOn ? 'on' : 'off'}" data-theme="${escapeHtml(t.key)}">
          <span class="uiswitch-knob"></span>
        </button>
      `;
      themesCard.appendChild(row);
    }

    // СВОИ ТЕМЫ — user types активного профиля.
    const ownLbl = sheet.querySelector('[data-own-lbl]');
    const ownCard = sheet.querySelector('[data-own-card]');
    ownLbl.textContent = `СВОИ ТЕМЫ · ${window.USER_TYPES.length}`;
    if (window.USER_TYPES.length === 0) {
      ownCard.style.display = 'none';
    } else {
      ownCard.style.display = '';
      for (const t of window.USER_TYPES) {
        const isOn = activeSet.has(t.key);
        const row = document.createElement('div');
        row.className = 'v3-theme-toggle-row v3-own-row';
        row.innerHTML = `
          <span class="v3-theme-icon">${t.icon}</span>
          <span class="v3-theme-label">${escapeHtml(t.label)}</span>
          <button type="button" class="link v3-own-edit" data-edit-own="${escapeHtml(t.key)}">Редактировать</button>
          <button type="button" class="uiswitch ${isOn ? 'on' : 'off'}" data-theme="${escapeHtml(t.key)}">
            <span class="uiswitch-knob"></span>
          </button>
        `;
        ownCard.appendChild(row);
      }
    }
  }

  sheet.addEventListener('click', async (e) => {
    if (e.target.closest('[data-apply]')) {
      await saveProfilePatch(profileId, { themes: tempThemes });
      close();
      renderSettingsProfile(profileId);
      return;
    }
    const presetBtn = e.target.closest('[data-preset]');
    if (presetBtn) {
      const c = window.CATEGORY_BY_KEY[presetBtn.dataset.preset];
      if (!c) return;
      const preset = c.themes || c.activeTypes || [];
      const set = new Set(tempThemes);
      for (const k of preset) set.add(k);
      tempThemes = [...set];
      render();
      return;
    }
    const swBtn = e.target.closest('[data-theme]');
    if (swBtn) {
      const key = swBtn.dataset.theme;
      const idx = tempThemes.indexOf(key);
      if (idx >= 0) tempThemes.splice(idx, 1);
      else tempThemes.push(key);
      render();
      return;
    }
    if (e.target.closest('[data-create-own]')) {
      // Сохраним текущий прогресс сheet-а, потом уйдём в конструктор.
      await saveProfilePatch(profileId, { themes: tempThemes });
      close();
      openTypeConstructor(null, profileId);
      return;
    }
    const editBtn = e.target.closest('[data-edit-own]');
    if (editBtn) {
      await saveProfilePatch(profileId, { themes: tempThemes });
      close();
      const key = editBtn.dataset.editOwn;
      const type = window.USER_TYPES.find(t => t.key === key);
      if (type) openTypeConstructor(type, profileId);
      return;
    }
  });

  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });

  render();
  document.body.appendChild(backdrop);
}

// v3: экран «Темы на главном» (renderSettingsThemes) удалён.
// Управление темами → Profile detail (flat list + UISwitch).
// Порядок тем → long-press + drag на главной (пакет B).

// ---------- custom types: конструктор темы + конструктор поля ----------

// Полноэкранный sheet для создания/редактирования user type.
// existing=null — create mode; existing=UserType — edit mode.
// profileId — возвращаемся в его «+ Добавить» после сохранения/отмены.
function openTypeConstructor(existing, profileId) {
  const isNew = !existing;
  // In-memory draft. Коммитится целиком по «Сохранить».
  const draft = existing ? JSON.parse(JSON.stringify(existing)) : {
    key: newTypeKey(),
    label: '',
    icon: '',
    description: '',
    fields: [],
    createdAt: Date.now(),
  };

  const backdrop = document.createElement('div');
  backdrop.className = 'v3-fullscreen';

  const close = () => {
    backdrop.remove();
    // Вернуть «+ Добавить» с актуальным состоянием.
    openAddThemesSheet(profileId);
  };

  function render() {
    backdrop.innerHTML = `
      <div class="tc-head">
        <button type="button" class="tc-back" data-back aria-label="Назад">←</button>
        <div class="tc-head-title">${isNew ? 'Новая тема' : escapeHtml(draft.label || 'Тема')}</div>
        <button type="button" class="tc-save ${isSaveReady(draft) ? 'active' : ''}" data-save>Сохранить</button>
      </div>
      <div class="tc-body">
        <div class="tc-meta-card">
          <div class="tc-meta-row">
            <span class="tc-meta-lbl">Иконка</span>
            <input class="tc-meta-icon" type="text" data-icon maxlength="2" placeholder="🎯" value="${escapeHtml(draft.icon || '')}">
          </div>
          <div class="tc-meta-row">
            <span class="tc-meta-lbl">Название</span>
            <input class="tc-meta-input" type="text" data-label maxlength="40" placeholder="например, Завтрак" value="${escapeHtml(draft.label || '')}">
          </div>
          <div class="tc-meta-row">
            <span class="tc-meta-lbl">Описание</span>
            <input class="tc-meta-input" type="text" data-desc maxlength="80" placeholder="не обязательно" value="${escapeHtml(draft.description || '')}">
          </div>
        </div>

        <div class="tc-fields-head">
          <span class="tc-fields-lbl">ПОЛЯ · ${draft.fields.length}</span>
          <button type="button" class="link" data-add-field>+ Поле</button>
        </div>

        <div class="tc-fields-list"></div>

        ${!isNew ? `
          <div class="tc-spacer"></div>
          <button type="button" class="tc-delete-btn" data-delete>Удалить тему</button>
        ` : ''}
      </div>
    `;

    const list = backdrop.querySelector('.tc-fields-list');
    if (draft.fields.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'tc-fields-empty';
      empty.innerHTML = `
        <div class="tc-fields-empty-title">Поля пока не добавлены</div>
        <div class="tc-fields-empty-sub">Тап «+ Поле» чтобы настроить что будешь фиксировать</div>
      `;
      list.appendChild(empty);
    } else {
      draft.fields.forEach((f, i) => {
        const row = document.createElement('div');
        row.className = 'tc-field-row';
        row.innerHTML = `
          <div class="tc-field-info">
            <span class="tc-field-title">${escapeHtml(f.label || '(без названия)')}</span>
            <span class="tc-field-sub">${escapeHtml(fieldSummary(f))}</span>
          </div>
          <div class="tc-field-actions">
            <button type="button" class="tc-field-btn" data-move="${i}:-1" aria-label="Вверх" ${i === 0 ? 'disabled' : ''}>↑</button>
            <button type="button" class="tc-field-btn" data-move="${i}:1" aria-label="Вниз" ${i === draft.fields.length - 1 ? 'disabled' : ''}>↓</button>
            <button type="button" class="tc-field-btn" data-edit-field="${i}" aria-label="Редактировать">✎</button>
          </div>
        `;
        list.appendChild(row);
      });
    }
  }

  function readMetaFromInputs() {
    draft.label = backdrop.querySelector('[data-label]')?.value || '';
    draft.icon = backdrop.querySelector('[data-icon]')?.value || '';
    draft.description = backdrop.querySelector('[data-desc]')?.value || '';
  }

  backdrop.addEventListener('input', () => {
    readMetaFromInputs();
    // Обновим active-state кнопки Сохранить.
    const saveBtn = backdrop.querySelector('[data-save]');
    if (saveBtn) saveBtn.classList.toggle('active', isSaveReady(draft));
    // Обновим заголовок в edit-mode.
    if (!isNew) {
      const title = backdrop.querySelector('.tc-head-title');
      if (title) title.textContent = draft.label || 'Тема';
    }
  });

  backdrop.addEventListener('click', async (e) => {
    if (e.target.closest('[data-back]')) {
      readMetaFromInputs();
      if (hasChanges(existing, draft)) {
        if (!confirm(isNew ? 'Отменить создание темы?' : 'Отменить изменения?')) return;
      }
      close();
      return;
    }
    if (e.target.closest('[data-save]')) {
      readMetaFromInputs();
      const errs = validateType(draft);
      if (errs.length) { alert(errs.join('\n')); return; }
      try {
        await saveUserType(draft, isNew);
        close();
      } catch (err) { showError(err); }
      return;
    }
    if (e.target.closest('[data-add-field]')) {
      readMetaFromInputs();
      openFieldEditor(null, (newField) => {
        draft.fields.push(newField);
        render();
      });
      return;
    }
    const moveBtn = e.target.closest('[data-move]');
    if (moveBtn) {
      readMetaFromInputs();
      const [iStr, dirStr] = moveBtn.dataset.move.split(':');
      const i = +iStr;
      const dir = +dirStr;
      const j = i + dir;
      if (j < 0 || j >= draft.fields.length) return;
      const tmp = draft.fields[i]; draft.fields[i] = draft.fields[j]; draft.fields[j] = tmp;
      render();
      return;
    }
    const editBtn = e.target.closest('[data-edit-field]');
    if (editBtn) {
      readMetaFromInputs();
      const i = +editBtn.dataset.editField;
      openFieldEditor(draft.fields[i], (updated, del) => {
        if (del) draft.fields.splice(i, 1);
        else draft.fields[i] = updated;
        render();
      });
      return;
    }
    if (e.target.closest('[data-delete]')) {
      if (isNew) return;
      const n = await countEventsForType(draft.key);
      const msg = n > 0
        ? `Удалить тему «${draft.label}»?\n\nНа этой теме ${n} ${pluralRecords(n)}. Они останутся в истории с лейблом «${draft.label}», но редактировать их будет нельзя.`
        : `Удалить тему «${draft.label}»?\n\nЗаписей на этой теме нет.`;
      if (!confirm(msg)) return;
      try {
        await deleteUserType(draft.key);
        close();
      } catch (err) { showError(err); }
    }
  });

  render();
  document.body.appendChild(backdrop);
}

function isSaveReady(draft) {
  return !!(draft.label && draft.label.trim() && draft.icon && draft.icon.trim());
}

function hasChanges(original, draft) {
  if (!original) {
    // In create mode: any input considered change.
    return !!(draft.label || draft.icon || draft.description || draft.fields.length);
  }
  return JSON.stringify({
    label: original.label, icon: original.icon, description: original.description || '', fields: original.fields || [],
  }) !== JSON.stringify({
    label: draft.label, icon: draft.icon, description: draft.description || '', fields: draft.fields || [],
  });
}

function fieldSummary(f) {
  const parts = [];
  if (f.kind === 'single') parts.push('одно значение');
  else if (f.kind === 'multi') parts.push('несколько значений');
  else parts.push('текст');
  if (f.kind === 'single' || f.kind === 'multi') {
    const n = (f.options || []).length;
    parts.push(`${n} ${pluralOptions(n)}`);
  }
  if (f.required) parts.push('обязательное');
  return parts.join(' · ');
}

function pluralOptions(n) {
  const m = n % 10, h = n % 100;
  if (m === 1 && h !== 11) return 'опция';
  if (m >= 2 && m <= 4 && (h < 10 || h >= 20)) return 'опции';
  return 'опций';
}

function pluralRecords(n) {
  const m = n % 10, h = n % 100;
  if (m === 1 && h !== 11) return 'запись';
  if (m >= 2 && m <= 4 && (h < 10 || h >= 20)) return 'записи';
  return 'записей';
}

// Bottom-sheet для создания/редактирования поля.
// existing=null — create; existing=Field — edit.
// onSave(updatedField, deleted=false) вызывается на «Готово» / «Удалить».
function openFieldEditor(existing, onSave) {
  const isNew = !existing;
  const draft = existing ? JSON.parse(JSON.stringify(existing)) : {
    key: newFieldKey(),
    label: '',
    kind: 'single',
    required: false,
    options: [],
  };

  const backdrop = document.createElement('div');
  backdrop.className = 'v3-sheet-backdrop';
  const sheet = document.createElement('div');
  sheet.className = 'v3-sheet v3-sheet-tall fe-sheet';
  backdrop.appendChild(sheet);

  const close = () => backdrop.remove();

  function readNameInput() {
    const el = sheet.querySelector('[data-fe-name]');
    if (el) draft.label = el.value;
    const ph = sheet.querySelector('[data-fe-ph]');
    if (ph) draft.placeholder = ph.value;
  }

  function render() {
    sheet.innerHTML = `
      <div class="v3-sheet-handle" aria-hidden="true"></div>
      <div class="v3-sheet-title-row">
        <h2>${isNew ? 'Поле · создание' : 'Поле · редактирование'}</h2>
        <button type="button" class="link" data-cancel>Отмена</button>
      </div>

      <div class="fe-name-card">
        <div class="fe-name-lbl">НАЗВАНИЕ ПОЛЯ</div>
        <input class="fe-name-input" type="text" data-fe-name maxlength="40" value="${escapeHtml(draft.label || '')}" placeholder="например, Творог">
      </div>

      <div class="v3-sheet-section-lbl">ТИП</div>
      <div class="fe-kind-seg">
        <button type="button" class="fe-kind ${draft.kind === 'single' ? 'active' : ''}" data-kind="single">Одно значение</button>
        <button type="button" class="fe-kind ${draft.kind === 'multi' ? 'active' : ''}" data-kind="multi">Несколько</button>
        <button type="button" class="fe-kind ${draft.kind === 'text' ? 'active' : ''}" data-kind="text">Текст</button>
      </div>

      <div class="fe-req-row">
        <span class="fe-req-lbl">Обязательное поле</span>
        <button type="button" class="uiswitch ${draft.required ? 'on' : 'off'}" data-fe-req>
          <span class="uiswitch-knob"></span>
        </button>
      </div>

      <div data-fe-kind-body></div>

      <div class="fe-cta-row">
        ${!isNew ? '<button type="button" class="fe-del-btn" data-fe-del>Удалить</button>' : ''}
        <button type="button" class="fe-done-btn" data-fe-done>Готово</button>
      </div>
    `;

    const body = sheet.querySelector('[data-fe-kind-body]');
    if (draft.kind === 'single' || draft.kind === 'multi') {
      body.innerHTML = `
        <div class="fe-opt-head">
          <span class="v3-sheet-section-lbl">ЗНАЧЕНИЯ · ${(draft.options || []).length}</span>
          <button type="button" class="link" data-fe-add-opt>+ Значение</button>
        </div>
        <div class="fe-opt-card" data-fe-opts></div>
      `;
      const opts = body.querySelector('[data-fe-opts]');
      (draft.options || []).forEach((o, i) => {
        const row = document.createElement('div');
        row.className = 'fe-opt-row';
        row.innerHTML = `
          <input type="text" class="fe-opt-input" data-fe-opt-input="${i}" maxlength="40" value="${escapeHtml(o.label || '')}" placeholder="значение">
          <button type="button" class="tc-field-btn" data-fe-opt-move="${i}:-1" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button type="button" class="tc-field-btn" data-fe-opt-move="${i}:1" ${i === draft.options.length - 1 ? 'disabled' : ''}>↓</button>
          <button type="button" class="tc-field-btn" data-fe-opt-del="${i}">✕</button>
        `;
        opts.appendChild(row);
      });
    } else {
      // text
      body.innerHTML = `
        <div class="fe-name-card">
          <div class="fe-name-lbl">ПОДСКАЗКА (ОПЦИОНАЛЬНО)</div>
          <input class="fe-name-input" type="text" data-fe-ph maxlength="60" value="${escapeHtml(draft.placeholder || '')}" placeholder="например, по желанию">
        </div>
      `;
    }
  }

  sheet.addEventListener('input', (e) => {
    const idx = e.target.dataset?.feOptInput;
    if (idx !== undefined) {
      draft.options[+idx].label = e.target.value;
      return;
    }
    if (e.target.dataset?.feName !== undefined) {
      draft.label = e.target.value;
      return;
    }
    if (e.target.dataset?.fePh !== undefined) {
      draft.placeholder = e.target.value;
    }
  });

  sheet.addEventListener('click', (e) => {
    if (e.target.closest('[data-cancel]')) { close(); return; }
    if (e.target.closest('[data-fe-done]')) {
      readNameInput();
      const label = (draft.label || '').trim();
      if (!label) { alert('Название поля не заполнено'); return; }
      if (draft.kind === 'single' || draft.kind === 'multi') {
        const opts = (draft.options || []).filter(o => (o.label || '').trim());
        if (opts.length < 2) { alert('Нужно минимум 2 значения'); return; }
        draft.options = opts;
        delete draft.placeholder;
      } else {
        delete draft.options;
      }
      onSave(draft, false);
      close();
      return;
    }
    if (e.target.closest('[data-fe-del]')) {
      if (!confirm('Удалить поле?')) return;
      onSave(draft, true);
      close();
      return;
    }
    const kBtn = e.target.closest('[data-kind]');
    if (kBtn) {
      readNameInput();
      const next = kBtn.dataset.kind;
      if (next === draft.kind) return;
      // choice→text с заполненными options — confirm
      const fromChoice = (draft.kind === 'single' || draft.kind === 'multi');
      const hasOpts = fromChoice && (draft.options || []).some(o => (o.label || '').trim());
      if (fromChoice && next === 'text' && hasOpts) {
        if (!confirm(`Удалить ${draft.options.length} значений?`)) return;
        draft.options = [];
      }
      if (next !== 'text' && !draft.options) draft.options = [];
      draft.kind = next;
      render();
      return;
    }
    if (e.target.closest('[data-fe-req]')) {
      readNameInput();
      draft.required = !draft.required;
      render();
      return;
    }
    if (e.target.closest('[data-fe-add-opt]')) {
      readNameInput();
      if (!draft.options) draft.options = [];
      draft.options.push({ key: newOptionKey(), label: '' });
      render();
      return;
    }
    const moveBtn = e.target.closest('[data-fe-opt-move]');
    if (moveBtn) {
      readNameInput();
      const [iStr, dirStr] = moveBtn.dataset.feOptMove.split(':');
      const i = +iStr, dir = +dirStr;
      const j = i + dir;
      if (j < 0 || j >= draft.options.length) return;
      const tmp = draft.options[i]; draft.options[i] = draft.options[j]; draft.options[j] = tmp;
      render();
      return;
    }
    const delOpt = e.target.closest('[data-fe-opt-del]');
    if (delOpt) {
      readNameInput();
      const i = +delOpt.dataset.feOptDel;
      draft.options.splice(i, 1);
      render();
      return;
    }
  });

  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });

  render();
  document.body.appendChild(backdrop);
}

// ---------- bottom sheet (theme / type) ----------

async function openTypeSheet({ recordId, eventId, typeKey }) {
  const type = window.TYPE_BY_KEY[typeKey];
  if (!type) {
    // Orphan event: тема была удалена (обычно user type), но событие есть в истории.
    // labelSnapshot в карточке истории всё ещё показывается; редактировать нельзя.
    // См. custom-types-spec.md §7.2.
    alert('Эта тема удалена. Запись видна в истории, но редактировать её уже нельзя.');
    return;
  }
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
  const activeProfile = getActiveProfile();
  const overrides = activeProfile?.themeFieldOverrides?.[st.typeKey] || {};
  for (const f of type.fields) {
    // v3: optional поле может быть выключено на уровне профиля.
    // Required поля игнорируют override.
    if (!f.required && overrides[f.key] === false) continue;
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
      const arr = Array.isArray(v) ? v : [v];
      const labels = arr.map(k => (f.options || []).find(o => o.key === k)?.label).filter(Boolean);
      if (labels.length) out.push([f.label, labels.join(', ')]);
    } else if (f.kind === 'text') {
      if (String(v).trim()) out.push([f.label, String(v).trim()]);
    }
  }
  if (ev.note) out.push(['Комментарий к теме', ev.note]);
  return out;
}

function profileCategoriesLabel(profile) {
  // v3: категории не хранятся в профиле. В экспорт кладём описание профиля
  // (свободный текст пользователя — например «3 года, ЖКТ»). Функция сохранена
  // для совместимости сигнатуры, возвращает description.
  return profile?.description || '';
}

function profileSummaryLine(profile) {
  // Строка для шапки экспорта: «Лёва · 3 года, ЖКТ · 7 тем».
  const parts = [profile.name];
  if (profile.description) parts.push(profile.description);
  if (Array.isArray(profile.themes)) parts.push(`${profile.themes.length} тем`);
  return parts.join(' · ');
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
  lines.push(`Профиль: ${profileSummaryLine(profile)}`);
  if (meta.templateKey && meta.templateKey !== 'free') {
    lines.push(`Шаблон: ${TEMPLATE_LABELS[meta.templateKey] || meta.templateKey}`);
  }
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

function eventValuesResolved(ev) {
  const type = window.TYPE_BY_KEY[ev.type];
  if (!type) return null;
  const out = {};
  for (const f of type.fields) {
    const v = ev.fields?.[f.key];
    if (v == null || (Array.isArray(v) && v.length === 0) || v === '') continue;
    if (f.kind === 'single') {
      const o = (f.options || []).find(o => o.key === v);
      if (o) out[f.label] = o.label;
    } else if (f.kind === 'multi') {
      const arr = Array.isArray(v) ? v : [v];
      const labels = arr.map(k => (f.options || []).find(o => o.key === k)?.label).filter(Boolean);
      if (labels.length) out[f.label] = labels;
    } else if (f.kind === 'text') {
      const s = String(v).trim();
      if (s) out[f.label] = s;
    }
  }
  return out;
}

function buildJsonExport(meta, periodKey, data) {
  const { profile } = meta;
  const { records, eventsByRec, fromIso, toIso } = data;
  const periodLabel = {
    today: 'Сегодня',
    '7d': '7 дней',
    '30d': '30 дней',
    all: 'всё время',
  }[periodKey];

  const usedTypeKeys = new Set();
  for (const evs of eventsByRec.values()) {
    for (const ev of evs) usedTypeKeys.add(ev.type);
  }
  const allTypes = [...(window.TYPES || []), ...(window.USER_TYPES || [])];
  const themes = allTypes
    .filter(t => usedTypeKeys.has(t.key))
    .map(t => ({
      key: t.key,
      label: t.label,
      icon: t.icon || null,
      description: t.description || null,
      source: window.USER_TYPES?.some(u => u.key === t.key) ? 'user' : 'builtin',
      fields: (t.fields || []).map(f => ({
        key: f.key,
        label: f.label,
        kind: f.kind,
        required: !!f.required,
        ...(f.kind === 'single' || f.kind === 'multi'
          ? { options: (f.options || []).map(o => ({ key: o.key, label: o.label })) }
          : {}),
        ...(f.placeholder ? { placeholder: f.placeholder } : {}),
      })),
    }));

  const totalEvents = Array.from(eventsByRec.values()).reduce((s, a) => s + a.length, 0);
  const effFromIso = fromIso || (records[0] && records[0].sortMoment) || toIso;

  const recordsOut = records.map(r => {
    const evs = eventsByRec.get(r.id) || [];
    return {
      id: r.id,
      moment: r.sortMoment,
      comment: (r.comment || '').trim() || null,
      events: evs.map(ev => {
        const resolved = eventValuesResolved(ev);
        const base = {
          type: ev.type,
          typeLabel: ev.labelSnapshot || window.TYPE_BY_KEY[ev.type]?.label || ev.type,
          moment: ev.moment,
          note: ev.note || null,
        };
        if (resolved === null) {
          return { ...base, orphan: true, rawValues: ev.fields || {} };
        }
        return { ...base, values: resolved };
      }),
    };
  });

  const out = {
    instructions: 'Структурированный экспорт журнала наблюдений Kid Journal. Каждая запись (records[]) — сессия наблюдений в момент `moment`, содержит одно или несколько событий разных тем. Структура полей каждой темы описана в `themes[]`. Значения в `events[].values` уже расшифрованы как человекочитаемые лейблы (ключ = label поля, значение = label опции; для multi-полей значение — массив; для text-полей — строка).',
    meta: {
      app: 'Kid Journal',
      schemaVersion: 'v5',
      exportedAt: new Date().toISOString(),
      profile: {
        id: profile.id,
        name: profile.name,
        description: profile.description || null,
      },
      period: {
        key: periodKey,
        label: periodLabel,
        fromIso: effFromIso,
        toIso,
      },
      template: meta.templateKey || 'free',
      counts: {
        records: records.length,
        events: totalEvents,
      },
    },
    themes,
    records: recordsOut,
  };

  return JSON.stringify(out, null, 2);
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
  const tplLabel = meta.templateKey && meta.templateKey !== 'free'
    ? TEMPLATE_LABELS[meta.templateKey] || meta.templateKey
    : null;
  metaEl.innerHTML = [
    `Профиль: ${escapeHtml(profileSummaryLine(profile))}`,
    tplLabel ? `Шаблон: ${escapeHtml(tplLabel)}` : null,
    `Период: ${periodLabel} (${fmtExportDateShort(effFrom)} – ${fmtExportDateShort(toIso)})`,
    `Записей: ${records.length} · событий: ${totalEvents}`,
    `Экспорт: ${fmtExportNow()}`,
  ].filter(Boolean).map(l => `<div>${l}</div>`).join('');
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

function exportFilename(profile, periodKey, data, ext, templateKey) {
  const { records, fromIso, toIso } = data;
  const subj = profile.id || 'export';
  const tpl = templateKey && templateKey !== 'free' ? `-${templateKey}` : '';
  const toStr = fmtExportDateShort(toIso);
  if (periodKey === 'today') return `kid-journal-${subj}${tpl}-${toStr}.${ext}`;
  const fromStr = fromIso
    ? fmtExportDateShort(fromIso)
    : fmtExportDateShort((records[0] && records[0].sortMoment) || toIso);
  return `kid-journal-${subj}${tpl}-${fromStr}-to-${toStr}.${ext}`;
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

async function deliverJson(filename, jsonString) {
  const blob = new Blob([jsonString], { type: 'application/json;charset=utf-8' });
  const file = new File([blob], filename, { type: 'application/json' });
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

const TEMPLATE_LABELS = {
  free: 'Свободный',
  gi: 'Для гастроэнтеролога',
  neuro: 'Для невролога',
  allergy: 'Для аллерголога',
};

function openExport() {
  const profile = getActiveProfile();
  const node = cloneTpl('tpl-export');
  const periodRow = $('[data-period]', node);
  const formatRow = $('[data-format]', node);
  const templateRow = $('[data-template]', node);
  const summary = $('[data-summary]', node);
  const runBtn = $('[data-run]', node);

  let periodKey = 'today';
  let formatKey = 'txt';
  let templateKey = 'free';
  const meta = { profile, get templateKey() { return templateKey; } };
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
  if (templateRow) {
    $$('button', templateRow).forEach(b => {
      b.addEventListener('click', () => {
        templateKey = b.dataset.templateKey;
        pickOpt(templateRow, b);
      });
    });
  }

  const close = () => node.remove();
  $('[data-cancel]', node).addEventListener('click', close);
  node.addEventListener('click', (e) => {
    if (e.target === node) close();
  });

  runBtn.addEventListener('click', async () => {
    if (!currentData || currentData.records.length === 0) return;
    const filename = exportFilename(profile, periodKey, currentData, formatKey, templateKey);
    if (formatKey === 'txt') {
      await deliverTxt(filename, buildTxt(meta, periodKey, currentData));
    } else if (formatKey === 'json') {
      await deliverJson(filename, buildJsonExport(meta, periodKey, currentData));
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
