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
  '.jpg', '.jpeg', '.png', '.cr2', '.cr3',
]);
const RAW_EXTENSIONS = new Set(['.cr2', '.cr3']);

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
    // For RAW files — extract embedded JPEG preview
    const lib = await getExifr();
    try {
      const thumbBuf = await lib.thumbnail(filePath);
      if (thumbBuf) {
        input = thumbBuf;
      } else {
        // Fallback: try reading the file directly with sharp
        input = filePath;
      }
    } catch {
      input = filePath;
    }
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
    console.error(`Thumbnail failed for ${filePath}:`, err.message);
    return null;
  }
}

/** For fullscreen viewer – get the best available image */
async function getFullImage(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  if (!RAW_EXTENSIONS.has(ext)) {
    return filePath; // browser can display JPEG/PNG directly
  }

  // For RAW – extract/convert a large preview
  const hash     = thumbHash(filePath);
  const prevPath = path.join(THUMBNAIL_DIR, `${hash}_full.jpg`);

  try {
    await fs.promises.access(prevPath);
    return prevPath;
  } catch { /* not cached */ }

  const sharpM = await getSharp();

  // Try: sharp might handle some RAW formats via libvips
  try {
    await sharpM(filePath)
      .jpeg({ quality: 92 })
      .toFile(prevPath);
    return prevPath;
  } catch { /* sharp can't read this RAW */ }

  // Fallback: extract embedded thumbnail (may be small)
  const lib = await getExifr();
  try {
    const thumbBuf = await lib.thumbnail(filePath);
    if (thumbBuf) {
      await fs.promises.writeFile(prevPath, thumbBuf);
      return prevPath;
    }
  } catch { /* no thumbnail */ }

  return filePath; // last resort
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
  ipcMain.handle('update:download', async () => {
    const { autoUpdater } = require('electron-updater');
    try {
      const downloadPromise = autoUpdater.downloadUpdate();
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Download timed out')), 120000)
      );
      await Promise.race([downloadPromise, timeoutPromise]);
    } catch (err) {
      console.error('Download failed:', err.message);
      // Forward error to renderer so UI can recover
      const wins = BrowserWindow.getAllWindows();
      if (wins.length > 0) {
        wins[0].webContents.send('update:error', err.message);
      }
    }
  });

  ipcMain.handle('update:install', () => {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.quitAndInstall(false, true);
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
   AUTO-UPDATER
   ═══════════════════════════════════════════════════════ */

function setupAutoUpdater(win) {
  try {
    const { autoUpdater } = require('electron-updater');

    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    // Prevent hanging on slow/unreachable servers
    autoUpdater.requestHeaders = { 'Cache-Control': 'no-cache' };

    autoUpdater.on('update-available', (info) => {
      win.webContents.send('update:available', {
        version: info.version,
        releaseDate: info.releaseDate,
      });
    });

    autoUpdater.on('update-not-available', () => {
      win.webContents.send('update:not-available');
    });

    autoUpdater.on('download-progress', (progress) => {
      win.webContents.send('update:progress', {
        percent: Math.round(progress.percent),
      });
    });

    autoUpdater.on('update-downloaded', () => {
      win.webContents.send('update:downloaded');
    });

    autoUpdater.on('error', (err) => {
      console.error('Auto-updater error:', err.message);
      win.webContents.send('update:error', err.message);
    });

    // Manual check handler
    ipcMain.handle('update:check', async () => {
      try {
        const checkPromise = autoUpdater.checkForUpdates();
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Update check timed out')), 15000)
        );
        await Promise.race([checkPromise, timeoutPromise]);
      } catch (err) {
        console.error('Update check failed:', err.message);
        win.webContents.send('update:error', err.message);
      }
    });

    // Check for updates after a short delay (with timeout)
    setTimeout(async () => {
      try {
        const checkPromise = autoUpdater.checkForUpdates();
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Update check timed out')), 15000)
        );
        await Promise.race([checkPromise, timeoutPromise]);
      } catch (err) {
        console.error('Auto-update check failed:', err.message);
        win.webContents.send('update:error', err.message);
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
