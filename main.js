const { app, BrowserWindow, ipcMain, dialog, nativeTheme } = require('electron');
const path     = require('path');
const fs       = require('fs');
const crypto   = require('crypto');
const chokidar = require('chokidar');
const db       = require('./database');

/* ═══════════════════════════════════════════════════════
   CONFIG & PATHS
   ═══════════════════════════════════════════════════════ */

const SUPPORTED_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png',
  '.cr2', '.cr3',
  '.nef', '.arw', '.dng', '.orf', '.rw2', '.raf',
  '.heic', '.heif',
]);
const RAW_EXTENSIONS = new Set(['.cr2', '.cr3', '.nef', '.arw', '.dng', '.orf', '.rw2', '.raf']);
const HEIF_EXTENSIONS = new Set(['.heic', '.heif']);

let THUMBNAIL_DIR;

function initPaths() {
  const userData = app.getPath('userData');
  THUMBNAIL_DIR  = path.join(userData, 'thumbnails');
  const dbPath   = path.join(userData, 'store.db');
  const jsonPath = path.join(userData, 'store.json');
  fs.mkdirSync(THUMBNAIL_DIR, { recursive: true });
  db.initDatabase(dbPath, jsonPath);
}

/* (Persistent store is now handled by database.js — SQLite via better-sqlite3) */

/* ═══════════════════════════════════════════════════════
   FILE SCANNING
   ═══════════════════════════════════════════════════════ */

async function scanDirectory(dirPath) {
  const results = [];

  async function walk(dir) {
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return; // skip unreadable directories
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue; // skip hidden
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (SUPPORTED_EXTENSIONS.has(ext)) {
          try {
            const stat = await fs.promises.stat(fullPath);
            results.push({
              path:  fullPath,
              name:  entry.name,
              size:  stat.size,
              mtime: stat.mtimeMs,
              ext,
            });
          } catch { /* skip */ }
        }
      }
    }
  }

  await walk(dirPath);
  return results;
}

/* ═══════════════════════════════════════════════════════
   EXIF METADATA
   ═══════════════════════════════════════════════════════ */

let exifr; // lazy-loaded

async function getExifr() {
  if (!exifr) exifr = require('exifr');
  return exifr;
}

async function readExifData(filePath) {
  const lib = await getExifr();
  try {
    const data = await lib.parse(filePath, {
      pick: [
        'Make', 'Model', 'LensModel', 'LensMake', 'Lens', 'LensInfo', 'LensID',
        'DateTimeOriginal', 'CreateDate',
        'ISO', 'FNumber', 'ExposureTime',
        'FocalLength', 'FocalLengthIn35mmFormat',
        'ImageWidth', 'ImageHeight', 'ExifImageWidth', 'ExifImageHeight',
        'GPSLatitude', 'GPSLongitude',
        'ExposureCompensation', 'MeteringMode', 'WhiteBalance',
        'Software',
      ],
    });
    return data || {};
  } catch {
    return {};
  }
}

/** Read just the date for caching purposes */
async function readDateTaken(filePath) {
  const lib = await getExifr();
  try {
    const data = await lib.parse(filePath, {
      pick: ['DateTimeOriginal', 'CreateDate', 'Make', 'Model', 'LensModel', 'Lens', 'LensInfo'],
    });
    if (!data) return null;
    const date = data.DateTimeOriginal || data.CreateDate || null;
    const lens = data.LensModel || data.Lens || null;
    return {
      dateTaken: date ? new Date(date).toISOString() : null,
      camera:    [data.Make, data.Model].filter(Boolean).join(' ') || null,
      lens:      lens,
    };
  } catch {
    return null;
  }
}

/* ═══════════════════════════════════════════════════════
   THUMBNAIL GENERATION
   ═══════════════════════════════════════════════════════ */

let sharp; // lazy-loaded

async function getSharp() {
  if (!sharp) sharp = require('sharp');
  return sharp;
}

function thumbHash(filePath) {
  return crypto.createHash('md5').update(filePath).digest('hex');
}

/** Fallback: generate a simple placeholder thumbnail for unsupported image types */
async function generatePlaceholderThumbnail(thumbPath, ext) {
  const sharpM = await getSharp();
  const label = ext ? ext.replace('.', '').toUpperCase() : 'RAW';
  try {
    // Create a small dark placeholder with the format label
    const svg = `<svg width="200" height="200" xmlns="http://www.w3.org/2000/svg">
      <rect width="200" height="200" fill="#1a1a1a"/>
      <text x="100" y="100" text-anchor="middle" dominant-baseline="central"
            font-family="-apple-system, BlinkMacSystemFont, sans-serif"
            font-size="18" font-weight="600" fill="#555">${label}</text>
      <text x="100" y="128" text-anchor="middle" dominant-baseline="central"
            font-family="-apple-system, BlinkMacSystemFont, sans-serif"
            font-size="10" fill="#3a3a3a">Preview unavailable</text>
    </svg>`;
    await sharpM(Buffer.from(svg))
      .webp({ quality: 60 })
      .toFile(thumbPath);
    return thumbPath;
  } catch {
    return null;
  }
}

/** Extract embedded JPEG preview from a RAW file via exifr */
async function extractRawPreview(filePath) {
  const lib = await getExifr();
  try {
    const thumbBuf = await lib.thumbnail(filePath);
    return thumbBuf || null;
  } catch {
    return null;
  }
}

async function generateThumbnail(filePath, size = 480) {
  const hash      = thumbHash(filePath);
  const thumbPath = path.join(THUMBNAIL_DIR, `${hash}.webp`);

  // Return cached
  try {
    await fs.promises.access(thumbPath);
    return thumbPath;
  } catch { /* not cached */ }

  const ext    = path.extname(filePath).toLowerCase();
  const sharpM = await getSharp();

  let input;

  if (RAW_EXTENSIONS.has(ext)) {
    // For RAW files — extract embedded JPEG preview (main approach)
    const previewBuf = await extractRawPreview(filePath);
    if (previewBuf) {
      input = previewBuf;
    } else {
      // No embedded preview — try sharp directly as last resort
      // (may work for DNG, some NEF, etc. if libvips has libraw support)
      try {
        // Quick test if sharp can even open this file
        const meta = await sharpM(filePath).metadata();
        if (meta && meta.width) {
          input = filePath;
        } else {
          throw new Error('No metadata');
        }
      } catch {
        // Sharp can't read this RAW — generate placeholder
        return await generatePlaceholderThumbnail(thumbPath, ext);
      }
    }
  } else if (HEIF_EXTENSIONS.has(ext)) {
    // HEIC/HEIF — try sharp first (libvips with libheif), fallback to heic-convert
    input = filePath;
  } else {
    input = filePath;
  }

  try {
    await sharpM(input)
      .resize(size, size, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80 })
      .toFile(thumbPath);
    return thumbPath;
  } catch (err) {
    // If sharp failed and it's a HEIF file, try heic-convert fallback
    if (HEIF_EXTENSIONS.has(ext)) {
      try {
        const heicConvert = require('heic-convert');
        const inputBuf = await fs.promises.readFile(filePath);
        const outputBuf = await heicConvert({
          buffer: inputBuf,
          format: 'JPEG',
          quality: 0.8,
        });
        input = outputBuf;
        await sharpM(input)
          .resize(size, size, { fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 80 })
          .toFile(thumbPath);
        return thumbPath;
      } catch (heicErr) {
        console.error(`Thumbnail HEIC fallback failed for ${filePath}:`, heicErr.message);
        return await generatePlaceholderThumbnail(thumbPath, ext);
      }
    }

    // If RAW with preview buffer failed due to corrupt data, try placeholder
    if (RAW_EXTENSIONS.has(ext)) {
      console.error(`Thumbnail RAW preview processing failed for ${filePath}:`, err.message);
      return await generatePlaceholderThumbnail(thumbPath, ext);
    }

    console.error(`Thumbnail failed for ${filePath}:`, err.message);
    return await generatePlaceholderThumbnail(thumbPath, ext);
  }
}

/** For fullscreen viewer – get the best available image */
async function getFullImage(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  // HEIC/HEIF — need to convert to JPEG since the browser can't display them
  if (HEIF_EXTENSIONS.has(ext)) {
    const hash     = thumbHash(filePath);
    const prevPath = path.join(THUMBNAIL_DIR, `${hash}_full.jpg`);

    try {
      await fs.promises.access(prevPath);
      return prevPath;
    } catch { /* not cached */ }

    const sharpM = await getSharp();

    // Try sharp first (libvips with libheif)
    try {
      await sharpM(filePath)
        .jpeg({ quality: 92 })
        .toFile(prevPath);
      return prevPath;
    } catch { /* sharp can't read this HEIC */ }

    // Fallback: heic-convert
    try {
      const heicConvert = require('heic-convert');
      const inputBuf = await fs.promises.readFile(filePath);
      const outputBuf = await heicConvert({
        buffer: inputBuf,
        format: 'JPEG',
        quality: 0.92,
      });
      await fs.promises.writeFile(prevPath, outputBuf);
      return prevPath;
    } catch (heicErr) {
      console.error(`Full HEIC fallback failed for ${filePath}:`, heicErr.message);
    }

    return filePath; // last resort (browser may show nothing)
  }

  if (!RAW_EXTENSIONS.has(ext)) {
    return filePath; // browser can display JPEG/PNG directly
  }

  // For RAW – extract embedded JPEG preview (main approach)
  const hash     = thumbHash(filePath);
  const prevPath = path.join(THUMBNAIL_DIR, `${hash}_full.jpg`);

  try {
    await fs.promises.access(prevPath);
    return prevPath;
  } catch { /* not cached */ }

  // Step 1: Extract the largest embedded JPEG preview via exifr
  const lib = await getExifr();
  try {
    const thumbBuf = await lib.thumbnail(filePath);
    if (thumbBuf) {
      // Resize with sharp to ensure consistent quality and save as JPEG
      const sharpM = await getSharp();
      try {
        await sharpM(thumbBuf)
          .jpeg({ quality: 92 })
          .toFile(prevPath);
        return prevPath;
      } catch {
        // If sharp can't process the buffer, save it directly
        await fs.promises.writeFile(prevPath, thumbBuf);
        return prevPath;
      }
    }
  } catch { /* no embedded thumbnail found */ }

  // Step 2: Fallback — try sharp directly (may work for DNG, some NEF with libraw support)
  try {
    const sharpM = await getSharp();
    const meta = await sharpM(filePath).metadata();
    if (meta && meta.width) {
      await sharpM(filePath)
        .jpeg({ quality: 92 })
        .toFile(prevPath);
      return prevPath;
    }
  } catch { /* sharp can't read this RAW */ }

  return filePath; // last resort (browser will show broken image, but file path is returned)
}

/* ═══════════════════════════════════════════════════════
   ENRICH PHOTOS  (read date/camera/lens and cache it)
   ═══════════════════════════════════════════════════════ */

/**
 * Enrich a single photo with cached EXIF metadata.
 * Returns the enriched photo object AND the cache entry to persist
 * (caller is responsible for batching upserts via db.upsertCacheBatch).
 */
async function enrichPhoto(photo) {
  const cached = db.getCachedMeta(photo.path);
  if (cached && cached.mtime === photo.mtime) {
    return { enriched: { ...photo, ...cached }, cacheEntry: null };
  }

  const meta = await readDateTaken(photo.path);
  const entry = {
    path:      photo.path,
    dateTaken: meta?.dateTaken || null,
    camera:    meta?.camera    || null,
    lens:      meta?.lens      || null,
    mtime:     photo.mtime,
  };
  return {
    enriched:   { ...photo, dateTaken: entry.dateTaken, camera: entry.camera, lens: entry.lens, mtime: entry.mtime },
    cacheEntry: entry,
  };
}

/** Helper: enrich an array of photos and batch-write new cache entries */
async function enrichPhotos(photos) {
  const results = [];
  const newCacheEntries = [];
  for (const p of photos) {
    const { enriched, cacheEntry } = await enrichPhoto(p);
    results.push(enriched);
    if (cacheEntry) newCacheEntries.push(cacheEntry);
  }
  if (newCacheEntries.length > 0) {
    db.upsertCacheBatch(newCacheEntries);
  }
  return results;
}

/* ═══════════════════════════════════════════════════════
   NATIVE THEME
   ═══════════════════════════════════════════════════════ */

function applyNativeTheme(theme) {
  if (theme === 'system') {
    nativeTheme.themeSource = 'system';
  } else if (theme === 'light') {
    nativeTheme.themeSource = 'light';
  } else {
    nativeTheme.themeSource = 'dark';
  }
}

/* ═══════════════════════════════════════════════════════
   FILE WATCHER  (chokidar — live folder monitoring)
   ═══════════════════════════════════════════════════════ */

/** @type {Map<string, import('chokidar').FSWatcher>} */
const watchers = new Map();

// Debounce buffers — batch events every DEBOUNCE_MS
let _addBuffer    = [];  // { filePath, folder }[]
let _unlinkBuffer = [];  // filePath[]
let _debounceTimer = null;
const DEBOUNCE_MS  = 500;

function startWatching(folderPath) {
  if (watchers.has(folderPath)) return;

  const watcher = chokidar.watch(folderPath, {
    ignored: /(^|[\/\\])\./,        // skip hidden files/dirs
    persistent: true,
    ignoreInitial: true,             // don't fire for existing files
    awaitWriteFinish: {              // wait for large file copies to finish
      stabilityThreshold: 300,
      pollInterval: 100,
    },
  });

  watcher.on('add', (filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(ext)) return;
    _addBuffer.push({ filePath, folder: folderPath });
    scheduleFlush();
  });

  watcher.on('unlink', (filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(ext)) return;
    _unlinkBuffer.push(filePath);
    scheduleFlush();
  });

  watchers.set(folderPath, watcher);
}

function stopWatching(folderPath) {
  const w = watchers.get(folderPath);
  if (w) {
    w.close();
    watchers.delete(folderPath);
  }
}

function stopAllWatchers() {
  for (const [, w] of watchers) w.close();
  watchers.clear();
}

function scheduleFlush() {
  if (_debounceTimer) return; // already scheduled
  _debounceTimer = setTimeout(async () => {
    _debounceTimer = null;
    await flushWatcherBuffers();
  }, DEBOUNCE_MS);
}

async function flushWatcherBuffers() {
  const added   = _addBuffer.splice(0);
  const removed = _unlinkBuffer.splice(0);

  const win = BrowserWindow.getAllWindows()[0];
  if (!win) return;

  // ── Process additions ──
  if (added.length > 0) {
    const photos = [];
    const cacheEntries = [];
    for (const { filePath, folder } of added) {
      try {
        const stat = await fs.promises.stat(filePath);
        const photo = {
          path:  filePath,
          name:  path.basename(filePath),
          size:  stat.size,
          mtime: stat.mtimeMs,
          ext:   path.extname(filePath).toLowerCase(),
        };
        const { enriched, cacheEntry } = await enrichPhoto(photo);
        photos.push({ ...enriched, folder });
        if (cacheEntry) cacheEntries.push(cacheEntry);
      } catch { /* file may have vanished between event and stat */ }
    }
    if (cacheEntries.length > 0) db.upsertCacheBatch(cacheEntries);
    if (photos.length > 0) {
      win.webContents.send('photos:added', photos);
    }
  }

  // ── Process removals ──
  if (removed.length > 0) {
    win.webContents.send('photos:removed', removed);
  }
}

/* ═══════════════════════════════════════════════════════
   AUTO-UPDATE STATE MANAGER
   ═══════════════════════════════════════════════════════ */

/**
 * @typedef {'idle'|'checking'|'available'|'downloading'|'ready'|'error'} UpdaterStateName
 *
 * Centralised state machine for the auto-updater.
 * Prevents race conditions between multiple check/download calls.
 */
const updaterState = {
  /** @type {UpdaterStateName} */
  _state: 'idle',
  _updateInfo: null,       // info object from 'update-available' event
  _autoUpdater: null,      // lazy-required autoUpdater reference
  _busyCheck: false,       // true while checkForUpdates() is in-flight
  _busyDownload: false,    // true while downloadUpdate() is in-flight
  _win: null,              // BrowserWindow to forward events to

  /**
   * Send an IPC event to the renderer (if window exists).
   * @param {string} channel
   * @param {*} [data]
   */
  _send(channel, data) {
    if (this._win && !this._win.isDestroyed()) {
      this._win.webContents.send(channel, data);
    }
  },

  /** Broadcast current state to the renderer */
  _broadcast() {
    this._send('update:stateChanged', {
      state: this._state,
      info:  this._updateInfo,
    });
  },

  /**
   * Transition to a new state and notify the renderer.
   * @param {UpdaterStateName} newState
   * @param {object} [info] – optional update info
   */
  setState(newState, info) {
    this._state = newState;
    if (info) this._updateInfo = info;
    this._broadcast();
  },

  get state() {
    return this._state;
  },

  get updateInfo() {
    return this._updateInfo;
  },

  /** @returns {import('electron-updater').AutoUpdater} */
  getAutoUpdater() {
    if (!this._autoUpdater) {
      const { autoUpdater } = require('electron-updater');
      autoUpdater.autoDownload = false;
      autoUpdater.autoInstallOnAppQuit = true;
      autoUpdater.requestHeaders = { 'Cache-Control': 'no-cache' };
      this._autoUpdater = autoUpdater;
    }
    return this._autoUpdater;
  },

  /**
   * Perform a single check for updates.
   * Returns `true` if an update is available, `false` if up-to-date,
   * throws on network/timeout errors.
   */
  async check() {
    if (this._busyCheck) {
      throw new Error('Update check already in progress');
    }

    const au = this.getAutoUpdater();
    this._busyCheck = true;

    let resolved = false;
    let resultAvailable = false;

    return new Promise((resolve, reject) => {
      const cleanup = () => {
        au.removeListener('update-available', onAvailable);
        au.removeListener('update-not-available', onNotAvailable);
        au.removeListener('error', onError);
      };

      const onAvailable = (info) => {
        if (resolved) return;
        resolved = true;
        this._updateInfo = {
          version: info.version,
          releaseDate: info.releaseDate,
        };
        resultAvailable = true;
        cleanup();
        this._busyCheck = false;
        resolve(true);
      };

      const onNotAvailable = () => {
        if (resolved) return;
        resolved = true;
        this._updateInfo = null;
        resultAvailable = false;
        cleanup();
        this._busyCheck = false;
        resolve(false);
      };

      const onError = (err) => {
        if (resolved) return;
        resolved = true;
        cleanup();
        this._busyCheck = false;
        reject(err);
      };

      // Attach listeners before calling checkForUpdates to avoid race
      au.once('update-available', onAvailable);
      au.once('update-not-available', onNotAvailable);
      au.once('error', onError);

      // Ensure we hang up after timeout
      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          cleanup();
          au.removeListener('update-available', onAvailable);
          au.removeListener('update-not-available', onNotAvailable);
          au.removeListener('error', onError);
          this._busyCheck = false;
          reject(new Error('Update check timed out'));
        }
      }, 15000);

      // Also intercept the original 'onAvailable' to ensure cleanup
      const origOnAvailable = au.listeners('update-available').pop();
      au.on('update-available', (info) => {
        clearTimeout(timer);
      });

      au.checkForUpdates().catch((err) => {
        if (!resolved) {
          resolved = true;
          cleanup();
          clearTimeout(timer);
          this._busyCheck = false;
          reject(err);
        }
      });
    });
  },

  /**
   * Download the previously found update.
   * Must be called only after check() returned `true` or state === 'available'.
   */
  async download() {
    if (this._busyDownload) {
      throw new Error('Download already in progress');
    }

    const au = this.getAutoUpdater();
    this._busyDownload = true;

    return new Promise((resolve, reject) => {
      const cleanup = () => {
        au.removeListener('download-progress', onProgress);
        au.removeListener('update-downloaded', onDownloaded);
        au.removeListener('error', onError);
      };

      const onProgress = (progress) => {
        this._send('update:progress', {
          percent: Math.round(progress.percent),
        });
      };

      const onDownloaded = () => {
        cleanup();
        this._busyDownload = false;
        this.setState('ready');
        resolve();
      };

      const onError = (err) => {
        cleanup();
        this._busyDownload = false;
        reject(err);
      };

      au.on('download-progress', onProgress);
      au.once('update-downloaded', onDownloaded);
      au.once('error', onError);

      const timer = setTimeout(() => {
        cleanup();
        this._busyDownload = false;
        reject(new Error('Download timed out'));
      }, 120000);

      au.downloadUpdate().catch((err) => {
        cleanup();
        clearTimeout(timer);
        this._busyDownload = false;
        reject(err);
      });
    });
  },

  /** Install the downloaded update. */
  install() {
    const au = this.getAutoUpdater();
    au.quitAndInstall(false, true);
  },

  /** Wire up autoUpdater lifecycle events that the renderer relies on. */
  setupListeners(win) {
    this._win = win;
    const au = this.getAutoUpdater();

    // We still listen for update-available and update-not-available
    // for the initial passive check that electron-updater does on startup.
    // But the state machine's check() method handles these events too.
    // So we DON'T re-register them here to avoid double-firing.
    // Instead, we just wire the 'error' event for unexpected failures.
    au.on('error', (err) => {
      console.error('Auto-updater error:', err.message);
      this._send('update:error', err.message);
      if (this.state !== 'downloading') {
        this.setState('error');
      }
    });
  },
};

/* ═══════════════════════════════════════════════════════
   IPC HANDLERS
   ═══════════════════════════════════════════════════════ */

function registerIpcHandlers() {

  /* ── Folder dialog ──────────────────────────────────── */
  ipcMain.handle('dialog:selectFolder', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(win, {
      title: 'Select Image Folder',
      properties: ['openDirectory'],
      buttonLabel: 'Add Folder',
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  /* ── File dialog (individual photos) ───────────────── */
  ipcMain.handle('dialog:selectFiles', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const extList = [...SUPPORTED_EXTENSIONS].map(e => e.slice(1)); // remove dots
    const result = await dialog.showOpenDialog(win, {
      title: 'Select Photos',
      properties: ['openFile', 'multiSelections'],
      buttonLabel: 'Add Photos',
      filters: [
        { name: 'Images', extensions: extList },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths;
  });

  /* ── Folder management ─────────────────────────────── */
  ipcMain.handle('store:getFolders', () => {
    return db.getFolders();
  });

  ipcMain.handle('store:addFolder', async (_event, folderPath) => {
    db.addFolder(folderPath);
    startWatching(folderPath);
    // Scan and return photos
    const files = await scanDirectory(folderPath);
    // Enrich with cached metadata (batch transaction)
    return await enrichPhotos(files);
  });

  ipcMain.handle('store:removeFolder', (_event, folderPath) => {
    stopWatching(folderPath);
    db.removeFolder(folderPath);
  });

  /* ── Standalone file management ────────────────────── */
  ipcMain.handle('store:addFiles', async (_event, filePaths) => {
    const existingFiles = new Set(db.getFiles());
    const newPaths = filePaths.filter(fp => !existingFiles.has(fp));
    if (newPaths.length > 0) db.addFilesBatch(newPaths);
    // Return enriched photo objects for the newly added files
    const photos = [];
    for (const fp of newPaths) {
      try {
        const stat = await fs.promises.stat(fp);
        photos.push({
          path:  fp,
          name:  path.basename(fp),
          size:  stat.size,
          mtime: stat.mtimeMs,
          ext:   path.extname(fp).toLowerCase(),
        });
      } catch { /* skip inaccessible */ }
    }
    return await enrichPhotos(photos);
  });

  ipcMain.handle('store:removeFile', (_event, filePath) => {
    db.removeFile(filePath);
  });

  ipcMain.handle('photos:getStandalone', async () => {
    const filePaths = db.getFiles();
    const photos = [];
    for (const fp of filePaths) {
      try {
        const stat = await fs.promises.stat(fp);
        photos.push({
          path:  fp,
          name:  path.basename(fp),
          size:  stat.size,
          mtime: stat.mtimeMs,
          ext:   path.extname(fp).toLowerCase(),
        });
      } catch { /* skip */ }
    }
    return await enrichPhotos(photos);
  });

  /* ── Collection management ─────────────────────────── */
  ipcMain.handle('collections:getAll', () => {
    return db.getAllCollections();
  });

  ipcMain.handle('collections:create', (_event, name) => {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    db.createCollection(id, name);
    return { id, name, count: 0 };
  });

  ipcMain.handle('collections:rename', (_event, id, name) => {
    db.renameCollection(id, name);
  });

  ipcMain.handle('collections:delete', (_event, id) => {
    db.deleteCollection(id);
  });

  ipcMain.handle('collections:addPhoto', (_event, id, photoPath) => {
    db.addPhotoToCollection(id, photoPath);
  });

  ipcMain.handle('collections:removePhoto', (_event, id, photoPath) => {
    db.removePhotoFromCollection(id, photoPath);
  });

  ipcMain.handle('collections:getPhotos', async (_event, id) => {
    const photoPaths = db.getCollectionPhotos(id);
    if (photoPaths.length === 0) return [];
    const photos = [];
    for (const fp of photoPaths) {
      try {
        const stat = await fs.promises.stat(fp);
        photos.push({
          path: fp, name: path.basename(fp),
          size: stat.size, mtime: stat.mtimeMs,
          ext: path.extname(fp).toLowerCase(),
        });
      } catch { /* file may have been moved/deleted */ }
    }
    return await enrichPhotos(photos);
  });

  ipcMain.handle('collections:getForPhoto', (_event, photoPath) => {
    return db.getCollectionsForPhoto(photoPath);
  });

  /* ── Settings ──────────────────────────────────────────── */
  ipcMain.handle('settings:getAll', () => {
    return db.getAllSettings();
  });

  ipcMain.handle('settings:get', (_event, key) => {
    return db.getSetting(key);
  });

  ipcMain.handle('settings:set', (_event, key, value) => {
    db.setSetting(key, value);
    // Apply native theme when theme setting changes
    if (key === 'theme') {
      applyNativeTheme(value);
    }
  });

  ipcMain.handle('app:getVersion', () => {
    return app.getVersion();
  });

  ipcMain.handle('app:getRawExtensions', () => {
    return [...RAW_EXTENSIONS];
  });

  ipcMain.handle('app:getHeifExtensions', () => {
    return [...HEIF_EXTENSIONS];
  });

  /* ── Photo retrieval ───────────────────────────────── */
  ipcMain.handle('photos:getForFolder', async (_event, folderPath) => {
    const files = await scanDirectory(folderPath);
    return await enrichPhotos(files);
  });

  ipcMain.handle('photos:getAll', async () => {
    const all = [];
    const newCacheEntries = [];
    for (const folder of db.getFolders()) {
      const files = await scanDirectory(folder);
      for (const f of files) {
        const { enriched, cacheEntry } = await enrichPhoto(f);
        all.push({ ...enriched, folder });
        if (cacheEntry) newCacheEntries.push(cacheEntry);
      }
    }
    // Include standalone files
    for (const fp of db.getFiles()) {
      try {
        const stat = await fs.promises.stat(fp);
        const photo = {
          path: fp, name: path.basename(fp),
          size: stat.size, mtime: stat.mtimeMs,
          ext: path.extname(fp).toLowerCase(),
        };
        const { enriched, cacheEntry } = await enrichPhoto(photo);
        all.push({ ...enriched, folder: '__standalone__' });
        if (cacheEntry) newCacheEntries.push(cacheEntry);
      } catch { /* skip */ }
    }
    if (newCacheEntries.length > 0) {
      db.upsertCacheBatch(newCacheEntries);
    }
    return all;
  });

  ipcMain.handle('photos:getThumbnail', async (_event, filePath) => {
    const thumbPath = await generateThumbnail(filePath);
    return thumbPath;
  });

  ipcMain.handle('photos:getFullImage', async (_event, filePath) => {
    const imgPath = await getFullImage(filePath);
    return imgPath;
  });

  ipcMain.handle('photos:getExif', async (_event, filePath) => {
    return await readExifData(filePath);
  });

  /* ── Window controls ───────────────────────────────── */
  ipcMain.on('window:minimize', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });

  ipcMain.on('window:maximize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
      win.isMaximized() ? win.unmaximize() : win.maximize();
    }
  });

  ipcMain.on('window:close', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });

  /* ── Auto-update controls ──────────────────────────── */

  /**
   * Manually check for updates.
   * Returns `{ available: true, info: ... }` or `{ available: false }`.
   */
  ipcMain.handle('update:check', async () => {
    updaterState.setState('checking');

    try {
      const available = await updaterState.check();
      if (available) {
        updaterState.setState('available');
        return { available: true, info: updaterState.updateInfo };
      } else {
        updaterState.setState('idle');
        return { available: false };
      }
    } catch (err) {
      console.error('Update check failed:', err.message);
      updaterState.setState('error');
      throw err;
    }
  });

  /**
   * Download an available update.
   * If no update has been found yet, it first performs a check, then downloads.
   */
  ipcMain.handle('update:download', async () => {
    // If we're in idle state (no prior check), run check first
    if (updaterState.state === 'idle' || updaterState.state === 'error') {
      updaterState.setState('checking');
      try {
        const available = await updaterState.check();
        if (!available) {
          updaterState.setState('idle');
          throw new Error('No update available');
        }
      } catch (err) {
        // If timeout or network error, propagate to renderer
        updaterState.setState('error');
        throw err;
      }
    }

    // Now we must be in 'available' state or something went wrong
    if (updaterState.state !== 'available') {
      throw new Error('No update available to download (state: ' + updaterState.state + ')');
    }

    updaterState.setState('downloading');

    try {
      await updaterState.download();
      // setState('ready') is called inside download() on success
    } catch (err) {
      console.error('Download failed:', err.message);
      // Go back to 'available' so user can retry
      updaterState.setState('available');
      throw err;
    }
  });

  ipcMain.handle('update:install', () => {
    updaterState.install();
  });

  /* ── Haptic feedback (macOS trackpad) ──────────────── */
  ipcMain.on('haptic:tap', () => {
    if (process.platform !== 'darwin') return;
    try {
      const { execFile } = require('child_process');
      // In packaged app: resources/haptic; in dev: build/haptic
      const hapticPath = app.isPackaged
        ? path.join(process.resourcesPath, 'haptic')
        : path.join(__dirname, 'build', 'haptic');
      execFile(hapticPath, (err) => {
        if (err) { /* silently ignore — binary may not exist on x86 */ }
      });
    } catch { /* haptic not available */ }
  });
}

/* ═══════════════════════════════════════════════════════
   WINDOW CREATION
   ═══════════════════════════════════════════════════════ */

function createWindow() {
  const win = new BrowserWindow({
    width:  1280,
    height: 820,
    minWidth:  900,
    minHeight: 560,
    backgroundColor: '#0a0a0a',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          false,  // preload needs node APIs
    },
  });

  win.loadFile('index.html');
  return win;
}

/* ═══════════════════════════════════════════════════════
   AUTO-UPDATER SETUP
   ═══════════════════════════════════════════════════════ */

function setupAutoUpdater(win) {
  try {
    // Wire the state machine's listeners to the BrowserWindow
    updaterState.setupListeners(win);

    // Check for updates after a short delay
    setTimeout(async () => {
      try {
        const available = await updaterState.check();
        if (available) {
          updaterState.setState('available');
        }
        // If not available, stay 'idle' — user can manually check later
      } catch (err) {
        // Eat the error — the user can manually check later
        console.error('Initial auto-update check failed:', err.message);
        // Don't set error state for initial background check
        updaterState.setState('idle');
      }
    }, 5000);
  } catch (err) {
    console.error('Auto-updater setup failed:', err.message);
  }
}

/* ═══════════════════════════════════════════════════════
   APP LIFECYCLE
   ═══════════════════════════════════════════════════════ */

app.whenReady().then(() => {
  initPaths();
  applyNativeTheme(db.getSetting('theme') || 'dark');
  registerIpcHandlers();

  // Start file watchers for all persisted folders
  for (const folder of db.getFolders()) {
    startWatching(folder);
  }

  const win = createWindow();
  setupAutoUpdater(win);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const w = createWindow();
      setupAutoUpdater(w);
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  stopAllWatchers();
  db.closeDatabase();
});