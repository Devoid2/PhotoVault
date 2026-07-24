/**
 * database.js — SQLite storage layer for PhotoVault
 *
 * Replaces the old JSON-based store (loadStore / saveStore) with
 * better-sqlite3.  All public methods are synchronous and use
 * prepared statements for performance.
 */

const Database = require('better-sqlite3');
const fs   = require('fs');
const path = require('path');

let db;           // better-sqlite3 instance
let stmts = {};   // prepared statements cache

/* ═══════════════════════════════════════════════════════
   SCHEMA
   ═══════════════════════════════════════════════════════ */

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS folders (
  path TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS collections (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS collection_photos (
  collection_id TEXT NOT NULL,
  photo_path    TEXT NOT NULL,
  PRIMARY KEY (collection_id, photo_path),
  FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS photo_cache (
  path      TEXT PRIMARY KEY,
  mtime     REAL,
  dateTaken TEXT,
  camera    TEXT,
  lens      TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`;

/* ═══════════════════════════════════════════════════════
   PREPARED STATEMENTS
   ═══════════════════════════════════════════════════════ */

function prepareStatements() {
  stmts = {
    /* ── Folders ──────────────────────────────────────── */
    getFolders:       db.prepare('SELECT path FROM folders ORDER BY path'),
    addFolder:        db.prepare('INSERT OR IGNORE INTO folders (path) VALUES (?)'),
    removeFolder:     db.prepare('DELETE FROM folders WHERE path = ?'),

    /* ── Files ────────────────────────────────────────── */
    getFiles:         db.prepare('SELECT path FROM files ORDER BY path'),
    addFile:          db.prepare('INSERT OR IGNORE INTO files (path) VALUES (?)'),
    removeFile:       db.prepare('DELETE FROM files WHERE path = ?'),

    /* ── Collections ──────────────────────────────────── */
    getAllCollections: db.prepare(`
      SELECT c.id, c.name, COUNT(cp.photo_path) AS count
      FROM collections c
      LEFT JOIN collection_photos cp ON cp.collection_id = c.id
      GROUP BY c.id
      ORDER BY c.name
    `),
    createCollection:  db.prepare('INSERT INTO collections (id, name) VALUES (?, ?)'),
    renameCollection:  db.prepare('UPDATE collections SET name = ? WHERE id = ?'),
    deleteCollection:  db.prepare('DELETE FROM collections WHERE id = ?'),

    /* ── Collection photos ────────────────────────────── */
    addPhoto:          db.prepare('INSERT OR IGNORE INTO collection_photos (collection_id, photo_path) VALUES (?, ?)'),
    removePhoto:       db.prepare('DELETE FROM collection_photos WHERE collection_id = ? AND photo_path = ?'),
    getPhotos:         db.prepare('SELECT photo_path FROM collection_photos WHERE collection_id = ? ORDER BY rowid'),
    getCollForPhoto:   db.prepare(`
      SELECT c.id, c.name
      FROM collection_photos cp
      JOIN collections c ON c.id = cp.collection_id
      WHERE cp.photo_path = ?
    `),

    /* ── Photo cache ──────────────────────────────────── */
    getCachedMeta:     db.prepare('SELECT mtime, dateTaken, camera, lens FROM photo_cache WHERE path = ?'),
    upsertCache:       db.prepare(`
      INSERT INTO photo_cache (path, mtime, dateTaken, camera, lens)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        mtime     = excluded.mtime,
        dateTaken = excluded.dateTaken,
        camera    = excluded.camera,
        lens      = excluded.lens
    `),
    deleteCacheByPrefix: db.prepare('DELETE FROM photo_cache WHERE path LIKE ? || \'%\''),
    deleteCacheEntry:    db.prepare('DELETE FROM photo_cache WHERE path = ?'),

    /* ── Settings ─────────────────────────────────────── */
    getAllSettings:     db.prepare('SELECT key, value FROM settings'),
    getSetting:        db.prepare('SELECT value FROM settings WHERE key = ?'),
    setSetting:        db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `),
  };
}

/* ═══════════════════════════════════════════════════════
   MIGRATION FROM store.json
   ═══════════════════════════════════════════════════════ */

function migrateFromJson(storePath) {
  if (!fs.existsSync(storePath)) return;

  console.log('[database] Migrating data from store.json …');

  let store;
  try {
    store = JSON.parse(fs.readFileSync(storePath, 'utf-8'));
  } catch (err) {
    console.error('[database] Failed to parse store.json, skipping migration:', err.message);
    return;
  }

  const migrate = db.transaction(() => {
    // Folders
    if (Array.isArray(store.folders)) {
      for (const p of store.folders) {
        stmts.addFolder.run(p);
      }
    }

    // Standalone files
    if (Array.isArray(store.files)) {
      for (const p of store.files) {
        stmts.addFile.run(p);
      }
    }

    // Collections
    if (store.collections && typeof store.collections === 'object') {
      for (const [id, col] of Object.entries(store.collections)) {
        stmts.createCollection.run(id, col.name || 'Untitled');
        if (Array.isArray(col.photos)) {
          for (const photoPath of col.photos) {
            stmts.addPhoto.run(id, photoPath);
          }
        }
      }
    }

    // Photo cache
    if (store.photoCache && typeof store.photoCache === 'object') {
      for (const [filePath, meta] of Object.entries(store.photoCache)) {
        stmts.upsertCache.run(
          filePath,
          meta.mtime     ?? null,
          meta.dateTaken ?? null,
          meta.camera    ?? null,
          meta.lens      ?? null,
        );
      }
    }

    // Settings
    if (store.settings && typeof store.settings === 'object') {
      for (const [key, value] of Object.entries(store.settings)) {
        stmts.setSetting.run(key, JSON.stringify(value));
      }
    }
  });

  migrate();

  // Rename old file as backup
  const bakPath = storePath + '.bak';
  try {
    fs.renameSync(storePath, bakPath);
    console.log('[database] Migration complete. Old file renamed to store.json.bak');
  } catch (err) {
    console.error('[database] Could not rename store.json:', err.message);
  }
}

/* ═══════════════════════════════════════════════════════
   INITIALISATION
   ═══════════════════════════════════════════════════════ */

function initDatabase(dbPath, oldStorePath) {
  db = new Database(dbPath);

  // Performance & safety pragmas
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');

  // Create tables
  db.exec(SCHEMA_SQL);

  // Prepare all statements
  prepareStatements();

  // One-time migration
  migrateFromJson(oldStorePath);
}

/* ═══════════════════════════════════════════════════════
   PUBLIC API
   ═══════════════════════════════════════════════════════ */

/* ── Folders ──────────────────────────────────────────── */

function getFolders() {
  return stmts.getFolders.all().map(r => r.path);
}

function addFolder(folderPath) {
  stmts.addFolder.run(folderPath);
}

function removeFolder(folderPath) {
  stmts.removeFolder.run(folderPath);
  stmts.deleteCacheByPrefix.run(folderPath);
}

/* ── Standalone files ─────────────────────────────────── */

function getFiles() {
  return stmts.getFiles.all().map(r => r.path);
}

const addFilesBatch = (() => {
  // Lazily wrapped in a transaction function; the db reference
  // is captured at call-time, so we create the wrapper on first use.
  let _txn;
  return (paths) => {
    if (!_txn) {
      _txn = db.transaction((items) => {
        for (const p of items) stmts.addFile.run(p);
      });
    }
    _txn(paths);
  };
})();

function removeFile(filePath) {
  stmts.removeFile.run(filePath);
  stmts.deleteCacheEntry.run(filePath);
}

/* ── Collections ──────────────────────────────────────── */

function getAllCollections() {
  return stmts.getAllCollections.all().map(r => ({
    id:    r.id,
    name:  r.name,
    count: r.count,
  }));
}

function createCollection(id, name) {
  stmts.createCollection.run(id, name);
}

function renameCollection(id, name) {
  stmts.renameCollection.run(name, id); // note: param order matches SET name=? WHERE id=?
}

function deleteCollection(id) {
  stmts.deleteCollection.run(id);
}

function addPhotoToCollection(collectionId, photoPath) {
  stmts.addPhoto.run(collectionId, photoPath);
}

function removePhotoFromCollection(collectionId, photoPath) {
  stmts.removePhoto.run(collectionId, photoPath);
}

function getCollectionPhotos(collectionId) {
  return stmts.getPhotos.all(collectionId).map(r => r.photo_path);
}

function getCollectionsForPhoto(photoPath) {
  return stmts.getCollForPhoto.all(photoPath).map(r => ({
    id:   r.id,
    name: r.name,
  }));
}

/* ── Photo cache ──────────────────────────────────────── */

function getCachedMeta(filePath) {
  return stmts.getCachedMeta.get(filePath) || null;
}

/**
 * Batch upsert cache entries inside a single transaction.
 * @param {Array<{path, mtime, dateTaken, camera, lens}>} entries
 */
const upsertCacheBatch = (() => {
  let _txn;
  return (entries) => {
    if (entries.length === 0) return;
    if (!_txn) {
      _txn = db.transaction((items) => {
        for (const e of items) {
          stmts.upsertCache.run(e.path, e.mtime, e.dateTaken, e.camera, e.lens);
        }
      });
    }
    _txn(entries);
  };
})();

function deleteCacheByPrefix(prefix) {
  stmts.deleteCacheByPrefix.run(prefix);
}

function deleteCacheEntry(filePath) {
  stmts.deleteCacheEntry.run(filePath);
}

/* ── Settings ─────────────────────────────────────────── */

function getAllSettings() {
  const rows = stmts.getAllSettings.all();
  const result = {};
  for (const r of rows) {
    try {
      result[r.key] = JSON.parse(r.value);
    } catch {
      result[r.key] = r.value;
    }
  }
  // Ensure default theme exists
  if (!('theme' in result)) {
    result.theme = 'dark';
  }
  return result;
}

function getSetting(key) {
  const row = stmts.getSetting.get(key);
  if (!row) return undefined;
  try {
    return JSON.parse(row.value);
  } catch {
    return row.value;
  }
}

function setSetting(key, value) {
  stmts.setSetting.run(key, JSON.stringify(value));
}

/* ── Cleanup ──────────────────────────────────────────── */

function closeDatabase() {
  if (db) db.close();
}

/* ═══════════════════════════════════════════════════════
   EXPORTS
   ═══════════════════════════════════════════════════════ */

module.exports = {
  initDatabase,
  closeDatabase,

  // Folders
  getFolders,
  addFolder,
  removeFolder,

  // Files
  getFiles,
  addFilesBatch,
  removeFile,

  // Collections
  getAllCollections,
  createCollection,
  renameCollection,
  deleteCollection,
  addPhotoToCollection,
  removePhotoFromCollection,
  getCollectionPhotos,
  getCollectionsForPhoto,

  // Photo cache
  getCachedMeta,
  upsertCacheBatch,
  deleteCacheByPrefix,
  deleteCacheEntry,

  // Settings
  getAllSettings,
  getSetting,
  setSetting,
};
