'use strict';

// ---------- visible error overlay (so mobile без DevTools тоже видно) ----------

function showError(e) {
  let bar = document.getElementById('err-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'err-bar';
    bar.style.cssText = 'position:fixed;left:0;right:0;bottom:0;background:#a13030;color:#fff;padding:10px 14px;font:13px/1.4 -apple-system,sans-serif;z-index:9999;white-space:pre-wrap;max-height:40vh;overflow:auto';
    document.body.appendChild(bar);
  }
  const msg = e && e.stack ? e.stack : String(e);
  bar.textContent = (bar.textContent ? bar.textContent + '\n\n' : '') + msg;
}
window.addEventListener('error', (e) => showError(e.error || e.message));
window.addEventListener('unhandledrejection', (e) => showError(e.reason || e));

// ---------- DB ----------

// DB name — отдельное от v4 («kidjournal»), чтобы не конфликтовать с остатками старой схемы.
const db = new Dexie('kidjournal-v5');
db.version(1).stores({
  config:  '&id',
  records: '++id, subjectId, status, postedAt, sortMoment',
  events:  '++id, recordId, type, moment',
});
db.open().catch(err => showError(err));

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
function fmtDelta(iso) {
  const diffMin = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (diffMin < 1) return '';
  const h = Math.floor(diffMin / 60);
  const m = diffMin % 60;
  if (h === 0) return `−${m}м`;
  if (m === 0) return `−${h}ч`;
  return `−${h}ч ${m}м`;
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
  config: null,             // { id, child, contexts, activeIndex, mainTiles }
  screen: 'onboarding',
  onb: { step: 0, name: '', age: '', profileKeys: [], typeKeys: [] },
  composer: null,           // { recordId } — when main is in compose mode
  sheet: null,              // { recordId, eventId?, typeKey, draft:{fields,note,moment}, originalMoment }
  editRecord: null,         // { recordId }
};

// ---------- boot ----------

async function boot() {
  try {
    state.config = await loadConfig();
    if (!state.config) renderOnboarding();
    else await renderMain();
  } catch (e) {
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

function renderOnboarding() {
  state.screen = 'onboarding';
  const node = cloneTpl('tpl-onboarding');
  const step = state.onb.step;
  const titles = ['Ребёнок', 'Профиль', 'Тэги на главном'];
  const subs = [
    'С чего начнём — кого ведём.',
    'Под что профилируем. Потом можно добавить ещё.',
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
        <input type="text" id="onb-name" placeholder="например, Лёва" value="${state.onb.name || ''}">
      </label>
      <label class="field">
        <span class="lbl">Возраст</span>
        <input type="text" id="onb-age" placeholder="например, 11 лет" value="${state.onb.age || ''}">
      </label>
    `;
  } else if (step === 1) {
    const grid = document.createElement('div');
    grid.className = 'tile-grid';
    for (const p of window.PROFILES) {
      const selected = state.onb.profileKeys.includes(p.key);
      const tile = document.createElement('button');
      tile.type = 'button';
      tile.className = 'tile' + (selected ? ' selected' : '');
      tile.dataset.profile = p.key;
      tile.innerHTML = `
        <span class="tile-icon">${p.icon}</span>
        <span class="tile-label">${p.label}</span>
        <span class="tile-sub">${p.description}</span>
      `;
      tile.addEventListener('click', () => {
        const set = new Set(state.onb.profileKeys);
        if (set.has(p.key)) set.delete(p.key); else set.add(p.key);
        state.onb.profileKeys = [...set];
        renderOnboarding();
      });
      grid.appendChild(tile);
    }
    body.appendChild(grid);
  } else if (step === 2) {
    const chosenProfiles = state.onb.profileKeys.map(k => window.PROFILE_BY_KEY[k]);
    const typeKeySet = new Set();
    for (const p of chosenProfiles) p.activeTypes.forEach(k => typeKeySet.add(k));
    const typeKeys = [...typeKeySet];
    if (state.onb.typeKeys.length === 0) {
      state.onb.typeKeys = typeKeys.slice(); // default — all active
    }
    const grid = document.createElement('div');
    grid.className = 'tile-grid';
    for (const k of typeKeys) {
      const t = window.TYPE_BY_KEY[k];
      if (!t) continue;
      const selected = state.onb.typeKeys.includes(k);
      const tile = document.createElement('button');
      tile.type = 'button';
      tile.className = 'tile' + (selected ? ' selected' : '');
      tile.innerHTML = `
        <span class="tile-icon">${t.icon}</span>
        <span class="tile-label">${t.label}</span>
        <span class="tile-sub">${t.description}</span>
      `;
      tile.addEventListener('click', () => {
        const set = new Set(state.onb.typeKeys);
        if (set.has(k)) set.delete(k); else set.add(k);
        state.onb.typeKeys = [...set];
        renderOnboarding();
      });
      grid.appendChild(tile);
    }
    body.appendChild(grid);
  }

  const back = $('[data-back]', node);
  const next = $('[data-next]', node);
  back.disabled = step === 0;
  back.addEventListener('click', () => { state.onb.step = Math.max(0, step - 1); renderOnboarding(); });
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
      if (state.onb.profileKeys.length === 0) { alert('Выбери хотя бы один профиль'); return; }
      state.onb.step = 2;
      state.onb.typeKeys = []; // reset so defaults recompute with new profile set
      renderOnboarding();
    } else {
      if (state.onb.typeKeys.length === 0) { alert('Выбери хотя бы один тэг'); return; }
      await finishOnboarding();
    }
  });

  setScreen(node);
}

async function finishOnboarding() {
  const primaryProfile = state.onb.profileKeys[0];
  const subjectId = slugify(state.onb.name) || 'child';
  const profileObj = window.PROFILE_BY_KEY[primaryProfile];
  // default main tiles = profile's default order filtered by chosen types
  const defaultOrder = profileObj.defaultMainTiles.filter(k => state.onb.typeKeys.includes(k));
  const remaining = state.onb.typeKeys.filter(k => !defaultOrder.includes(k));
  const mainTiles = [...defaultOrder, ...remaining];
  const cfg = {
    child: { name: state.onb.name, age: state.onb.age },
    contexts: [{ subjectId, profileId: primaryProfile, label: profileObj.label, icon: profileObj.icon }],
    activeIndex: 0,
    mainTiles,
    activeTypeKeys: state.onb.typeKeys,
  };
  await saveConfig(cfg);
  state.config = await loadConfig();
  await renderMain();
}

function slugify(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9а-яё]+/g, '-').replace(/^-|-$/g, '');
}

// ---------- main screen ----------

async function renderMain() {
  state.screen = 'main';
  const node = cloneTpl('tpl-main');
  const cfg = state.config;
  const ctx = cfg.contexts[cfg.activeIndex];
  $('[data-subject]', node).textContent = cfg.child.name;
  const pp = $('[data-profile]', node);
  pp.textContent = `${ctx.icon} ${ctx.label}`;

  // draft recovery
  const draft = await db.records
    .where('subjectId').equals(ctx.subjectId)
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

  // tile grid (compose)
  const tilesEl = $('[data-tiles]', node);
  renderTileGrid(tilesEl, (typeKey) => {
    const rid = state.composer?.recordId || null;
    openTypeSheet({ recordId: rid, typeKey });
  });

  // composer block — always visible; draft is created lazily on first tile commit or first comment keystroke
  const composerEl = $('[data-composer]', node);
  await renderComposerInto(composerEl, state.composer?.recordId || null);

  // today list
  const todayEl = $('[data-today]', node);
  const from = startOfDayIso();
  const to = endOfDayIso();
  const todayRecords = await db.records
    .where('sortMoment').between(from, to, true, true)
    .filter(r => r.status === 'saved' && r.subjectId === ctx.subjectId)
    .toArray();
  todayRecords.sort((a, b) => (b.sortMoment > a.sortMoment ? 1 : -1));
  if (todayRecords.length === 0) {
    todayEl.innerHTML = '<p class="muted empty">Сегодня записей нет.</p>';
  } else {
    for (const r of todayRecords) {
      todayEl.appendChild(await renderRecordCard(r));
    }
  }

  // history link
  $('[data-history]', node).addEventListener('click', () => renderHistory());

  setScreen(node);
}

function renderTileGrid(root, onTap) {
  root.innerHTML = '';
  for (const k of state.config.mainTiles) {
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
  const cfg = state.config;
  const ctx = cfg.contexts[cfg.activeIndex];
  const now = new Date().toISOString();
  return await db.records.add({
    subjectId: ctx.subjectId,
    postedAt: now,
    profileId: ctx.profileId,
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

  // Discard shown only when a draft exists
  if (recordId) {
    discardBtn.classList.remove('hidden');
    discardBtn.addEventListener('click', async () => {
      if (!confirm('Отменить запись? Всё, что набрано, будет удалено.')) return;
      await deleteRecord(recordId);
      state.composer = null;
      await renderMain();
    });
  }

  // Comment autosave (lazily creates a draft record on first keystroke if text non-empty)
  let commentTimer = null;
  const flushComment = async () => {
    const txt = commentEl.value;
    let rid = state.composer?.recordId;
    if (!rid) {
      if (!txt.trim()) return null;           // empty comment, don't create empty draft
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
    // flush any pending comment write
    clearTimeout(commentTimer);
    await flushComment();
    const rid = state.composer?.recordId;
    if (!rid) return;                          // nothing to save
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

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

async function deleteRecord(recordId) {
  await db.events.where('recordId').equals(recordId).delete();
  await db.records.delete(recordId);
}

// ---------- bottom sheet (type) ----------

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

  // retro: компактный chip-row из пресетов + кнопка «точное» с нативным time picker
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

  // «точное» → нативный time picker (через label+hidden input)
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

  // init
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

  // commit: two outcomes — сохранить запись целиком, или добавить ещё тег
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
    // refresh record sortMoment
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
    // Edit-mode: single-action — commit and return to record-edit form.
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
    // commit the whole record as saved
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

  // remove (only when editing existing event)
  const remove = $('[data-remove]', node);
  if (st.eventId) {
    remove.classList.remove('hidden');
    remove.addEventListener('click', async () => {
      if (!confirm('Удалить это наблюдение из записи?')) return;
      await db.events.delete(st.eventId);
      // if record now empty and is draft, drop it too
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
  // node itself is the .sheet-backdrop — dismiss on tap outside the sheet body
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
    stream.innerHTML = '<p class="muted">Нет наблюдений. Добавь тип снизу или удали запись.</p>';
  } else {
    for (const ev of events) stream.appendChild(renderEventChip(ev));
  }

  const tiles = $('[data-tiles]', node);
  renderTileGrid(tiles, (typeKey) => {
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
  const cfg = state.config;
  const ctx = cfg.contexts[cfg.activeIndex];
  const records = await db.records
    .where('subjectId').equals(ctx.subjectId)
    .filter(r => r.status === 'saved')
    .toArray();
  records.sort((a,b) => (b.sortMoment > a.sortMoment ? 1 : -1));
  const list = $('[data-records]', node);
  if (records.length === 0) {
    list.innerHTML = '<p class="muted empty">Пока пусто.</p>';
  } else {
    // group by day
    let lastDay = null;
    for (const r of records) {
      const day = new Date(r.sortMoment).toDateString();
      if (day !== lastDay) {
        const hdr = document.createElement('h3');
        hdr.className = 'day-header';
        hdr.textContent = fmtDayHeader(r.sortMoment);
        list.appendChild(hdr);
        lastDay = day;
      }
      list.appendChild(await renderRecordCard(r));
    }
  }
  $('[data-back]', node).addEventListener('click', () => renderMain());
  $('[data-export]', node).addEventListener('click', () => openExport());
  setScreen(node);
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

async function collectExportData(ctx, periodKey) {
  const { fromIso, toIso } = periodRange(periodKey);
  let records = await db.records
    .where('subjectId').equals(ctx.subjectId)
    .filter(r => r.status === 'saved')
    .toArray();
  if (fromIso) {
    records = records.filter(r => r.sortMoment >= fromIso && r.sortMoment <= toIso);
  }
  records.sort((a,b) => (a.sortMoment > b.sortMoment ? 1 : -1)); // chronological, old → new
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
  if (ev.note) out.push(['Тег-коммент', ev.note]);
  return out;
}

function buildTxt(meta, periodKey, data) {
  const { ctx, subjectName } = meta;
  const { records, eventsByRec, fromIso, toIso } = data;
  const periodLabel = {
    today: 'Сегодня',
    '7d': '7 дней',
    '30d': '30 дней',
    all: 'всё время',
  }[periodKey];
  const totalEvents = Array.from(eventsByRec.values()).reduce((s, a) => s + a.length, 0);
  const lines = [];
  lines.push(`Журнал · ${subjectName || ctx.subjectId}`);
  lines.push(`Субъект: ${ctx.subjectId} · профиль: ${ctx.label || ctx.profileId || '—'}`);
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
  const { ctx, subjectName } = meta;
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
  h1.textContent = `Журнал · ${subjectName || ctx.subjectId}`;
  root.appendChild(h1);

  const metaEl = document.createElement('div');
  metaEl.className = 'export-meta';
  const effFrom = fromIso || (records[0] && records[0].sortMoment) || toIso;
  metaEl.innerHTML = [
    `Субъект: ${ctx.subjectId} · профиль: ${ctx.label || ctx.profileId || '—'}`,
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
    head.innerHTML = `<span class="t">${time}</span>${typeLabels}`;
    rec.appendChild(head);

    for (const ev of evs) {
      if (evs.length > 1) {
        const sub = document.createElement('div');
        sub.className = 'export-field';
        sub.innerHTML = `<span class="fl">[${ev.labelSnapshot || ev.type}]</span>`;
        rec.appendChild(sub);
      }
      for (const [k, v] of eventFieldLines(ev)) {
        const line = document.createElement('div');
        line.className = 'export-field';
        line.innerHTML = `<span class="fl">${k}:</span> ${v}`;
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

function exportFilename(ctx, periodKey, data, ext) {
  const { records, fromIso, toIso } = data;
  const subj = ctx.subjectId || 'export';
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
  // Safari iOS не всегда стреляет afterprint — страхуем
  setTimeout(cleanup, 60000);
}

function openExport() {
  const cfg = state.config;
  const ctx = cfg.contexts[cfg.activeIndex];
  const meta = { ctx, subjectName: cfg.child?.name };
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
    currentData = await collectExportData(ctx, periodKey);
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
    const filename = exportFilename(ctx, periodKey, currentData, formatKey);
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
