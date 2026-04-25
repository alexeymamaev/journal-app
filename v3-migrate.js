// Pre-migration backup for v3 theme-primary upgrade.
// See v3-spec.md §4 (Dexie v3 upgrade) and §7 (migration edge cases).
//
// The v3 Dexie upgrade is a one-way door: old v2 fields (categories, mainTileOrder,
// mainTileHidden, age) are destroyed. Before the first v3 run on a v2 device, dump
// everything to JSON so we can hand-recover if migration misbehaves.
//
// Wiring (in app.js when enabling v3):
//   1. Before `new Dexie(...).version(3).stores(...)` is applied, open the DB at v2.
//   2. Check `cfg.v2BackupDone`. If falsy and at least one record exists — run
//      KJMigrate.exportV2Backup(db), then set `cfg.v2BackupDone = true`.
//   3. Only then close the v2 handle and let the app open with v3 schema.
//
// Fallback behaviour: if navigator.share is unavailable (desktop browsers), the
// utility triggers a classic download. On iPhone Safari, navigator.canShare with
// a File works and opens the share sheet.

(function (global) {
  const CURRENT_SCHEMA_VERSION = 4;

  async function exportDbAsJson(db, schemaVersion) {
    const hasUserTypes = !!db.userTypes;
    const [config, records, events, userTypes] = await Promise.all([
      db.config.toArray(),
      db.records.toArray(),
      db.events.toArray(),
      hasUserTypes ? db.userTypes.toArray() : Promise.resolve([]),
    ]);

    const backup = {
      exportedAt: new Date().toISOString(),
      schemaVersion,
      source: 'kid-journal-app',
      counts: {
        config: config.length,
        records: records.length,
        events: events.length,
        userTypes: userTypes.length,
      },
      data: { config, records, events, userTypes },
    };

    const json = JSON.stringify(backup, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const filename = `journal-backup-v${schemaVersion}-${yyyymmdd()}.json`;
    const file = new File([blob], filename, { type: 'application/json' });

    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({
        files: [file],
        title: `Бэкап Kid Journal v${schemaVersion}`,
        text: `Записей: ${records.length}, событий: ${events.length}. Сохрани в Files/iCloud.`,
      });
      return { method: 'share', filename, counts: backup.counts };
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    return { method: 'download', filename, counts: backup.counts };
  }

  async function exportV2Backup(db) {
    return exportDbAsJson(db, 2);
  }

  async function exportCurrentBackup(db) {
    return exportDbAsJson(db, CURRENT_SCHEMA_VERSION);
  }

  async function importBackup(db, json) {
    let backup;
    try {
      backup = JSON.parse(json);
    } catch {
      throw new Error('Файл не JSON.');
    }
    if (!backup || backup.source !== 'kid-journal-app') {
      throw new Error('Это не бэкап Kid Journal.');
    }
    if (backup.schemaVersion !== CURRENT_SCHEMA_VERSION) {
      throw new Error(
        `Несовместимая версия бэкапа: v${backup.schemaVersion}. ` +
        `Поддерживается только v${CURRENT_SCHEMA_VERSION} (текущая).`
      );
    }
    const { config = [], records = [], events = [], userTypes = [] } = backup.data || {};

    await db.transaction('rw', db.config, db.records, db.events, db.userTypes, async () => {
      await Promise.all([
        db.config.clear(),
        db.records.clear(),
        db.events.clear(),
        db.userTypes.clear(),
      ]);
      if (config.length) await db.config.bulkAdd(config);
      if (records.length) await db.records.bulkAdd(records);
      if (events.length) await db.events.bulkAdd(events);
      if (userTypes.length) await db.userTypes.bulkAdd(userTypes);
    });

    return {
      counts: {
        config: config.length,
        records: records.length,
        events: events.length,
        userTypes: userTypes.length,
      },
      exportedAt: backup.exportedAt || null,
    };
  }

  function yyyymmdd() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  global.KJMigrate = {
    exportV2Backup,
    exportCurrentBackup,
    exportDbAsJson,
    importBackup,
    CURRENT_SCHEMA_VERSION,
  };
})(window);
