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
  async function exportV2Backup(db) {
    const [config, records, events] = await Promise.all([
      db.config.toArray(),
      db.records.toArray(),
      db.events.toArray(),
    ]);

    const backup = {
      exportedAt: new Date().toISOString(),
      schemaVersion: 2,
      source: 'kid-journal-app',
      counts: {
        config: config.length,
        records: records.length,
        events: events.length,
      },
      data: { config, records, events },
    };

    const json = JSON.stringify(backup, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const filename = `journal-backup-v2-${yyyymmdd()}.json`;
    const file = new File([blob], filename, { type: 'application/json' });

    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({
        files: [file],
        title: 'Бэкап Kid Journal v2',
        text: `Записей: ${records.length}, событий: ${events.length}. Сохрани в Files/iCloud — пригодится если миграция v3 что-то повредит.`,
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

  function yyyymmdd() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  global.KJMigrate = { exportV2Backup };
})(window);
