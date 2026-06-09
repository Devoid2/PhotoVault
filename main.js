const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');

/* ═══════════════════════════════════════════════════════
   CONFIG & PATHS
   ═══════════════════════════════════════════════════════ */

const SUPPORTED_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.cr2', '.cr3',
]);
const RAW_EXTENSIONS = new Set(['.cr2', '.cr3']);

let THUMBNAIL_DIR;
let STORE_PATH;
let store = { folders: [], photoCache: {} };

function initPaths() {
  const userData = app.getPath('userData');
  THUMBNAIL_DIR = path.join(userData, 'thumbnails');
  STORE_PATH    = path.join(userData, 'store.json');
  fs.mkdirSync(THUMBNAIL_DIR, { recursive: true });
}

/* ═══════════════════════════════════════════════════════
   PERSISTENT STORE  (simple JSON file)
   ═══════════════════════════════════════════════════════ */

function loadStore() {
  try {
    const raw = fs.readFileSync(STORE_PATH, 'utf-8');
    store = JSON.parse(raw);
    if (!store.folders)     store.folders     = [];
    if (!store.files)       store.files       = [];
    if (!store.collections) store.collections  = {};
    if (!store.photoCache)  store.photoCache   = {};
  } catch {
    store = { folders: [], files: [], collections: {}, photoCache: {} };
  }
}

function saveStore() {
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), 'utf-8');
}

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
        'Make', 'Model', 'LensModel', 'LensMake',
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
      pick: ['DateTimeOriginal', 'CreateDate', 'Make', 'Model', 'LensModel'],
    });
    if (!data) return null;
    const date = data.DateTimeOriginal || data.CreateDate || null;
    return {
      dateTaken: date ? new Date(date).toISOString() : null,
      camera:    [data.Make, data.Model].filter(Boolean).join(' ') || null,
      lens:      data.LensModel || null,
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

async function generateThumbnail(filePath, size = 320) {
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

async function enrichPhoto(photo) {
  const cached = store.photoCache[photo.path];
  if (cached && cached.mtime === photo.mtime) {
    return { ...photo, ...cached };
  }

  const meta = await readDateTaken(photo.path);
  const enriched = {
    dateTaken: meta?.dateTaken || null,
    camera:    meta?.camera    || null,
    lens:      meta?.lens      || null,
    mtime:     photo.mtime,
  };
  store.photoCache[photo.path] = enriched;
  return { ...photo, ...enriched };
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
    return store.folders;
  });

  ipcMain.handle('store:addFolder', async (_event, folderPath) => {
    if (!store.folders.includes(folderPath)) {
      store.folders.push(folderPath);
      saveStore();
    }
    // Scan and return photos
    const files = await scanDirectory(folderPath);
    // Enrich with cached metadata (non-blocking batch)
    const enriched = [];
    for (const f of files) {
      enriched.push(await enrichPhoto(f));
    }
    saveStore(); // persist newly-cached metadata
    return enriched;
  });

  ipcMain.handle('store:removeFolder', (_event, folderPath) => {
    store.folders = store.folders.filter(f => f !== folderPath);
    // Clean cache entries for this folder
    for (const key of Object.keys(store.photoCache)) {
      if (key.startsWith(folderPath)) {
        delete store.photoCache[key];
      }
    }
    saveStore();
  });

  /* ── Standalone file management ────────────────────── */
  ipcMain.handle('store:addFiles', async (_event, filePaths) => {
    const newPaths = filePaths.filter(fp => !store.files.includes(fp));
    store.files.push(...newPaths);
    saveStore();
    // Return enriched photo objects for the newly added files
    const enriched = [];
    for (const fp of newPaths) {
      try {
        const stat = await fs.promises.stat(fp);
        const photo = {
          path:  fp,
          name:  path.basename(fp),
          size:  stat.size,
          mtime: stat.mtimeMs,
          ext:   path.extname(fp).toLowerCase(),
        };
        enriched.push(await enrichPhoto(photo));
      } catch { /* skip inaccessible */ }
    }
    saveStore();
    return enriched;
  });

  ipcMain.handle('store:removeFile', (_event, filePath) => {
    store.files = store.files.filter(f => f !== filePath);
    delete store.photoCache[filePath];
    saveStore();
  });

  ipcMain.handle('photos:getStandalone', async () => {
    const enriched = [];
    for (const fp of store.files) {
      try {
        const stat = await fs.promises.stat(fp);
        const photo = {
          path:  fp,
          name:  path.basename(fp),
          size:  stat.size,
          mtime: stat.mtimeMs,
          ext:   path.extname(fp).toLowerCase(),
        };
        enriched.push(await enrichPhoto(photo));
      } catch { /* skip */ }
    }
    saveStore();
    return enriched;
  });

  /* ── Collection management ─────────────────────────── */
  ipcMain.handle('collections:getAll', () => {
    return Object.entries(store.collections).map(([id, col]) => ({
      id, name: col.name, count: col.photos.length,
    }));
  });

  ipcMain.handle('collections:create', (_event, name) => {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    store.collections[id] = { name, photos: [] };
    saveStore();
    return { id, name, count: 0 };
  });

  ipcMain.handle('collections:rename', (_event, id, name) => {
    if (store.collections[id]) {
      store.collections[id].name = name;
      saveStore();
    }
  });

  ipcMain.handle('collections:delete', (_event, id) => {
    delete store.collections[id];
    saveStore();
  });

  ipcMain.handle('collections:addPhoto', (_event, id, photoPath) => {
    const col = store.collections[id];
    if (col && !col.photos.includes(photoPath)) {
      col.photos.push(photoPath);
      saveStore();
    }
  });

  ipcMain.handle('collections:removePhoto', (_event, id, photoPath) => {
    const col = store.collections[id];
    if (col) {
      col.photos = col.photos.filter(p => p !== photoPath);
      saveStore();
    }
  });

  ipcMain.handle('collections:getPhotos', async (_event, id) => {
    const col = store.collections[id];
    if (!col) return [];
    const enriched = [];
    for (const fp of col.photos) {
      try {
        const stat = await fs.promises.stat(fp);
        const photo = {
          path: fp, name: path.basename(fp),
          size: stat.size, mtime: stat.mtimeMs,
          ext: path.extname(fp).toLowerCase(),
        };
        enriched.push(await enrichPhoto(photo));
      } catch { /* file may have been moved/deleted */ }
    }
    saveStore();
    return enriched;
  });

  ipcMain.handle('collections:getForPhoto', (_event, photoPath) => {
    return Object.entries(store.collections)
      .filter(([, col]) => col.photos.includes(photoPath))
      .map(([id, col]) => ({ id, name: col.name }));
  });

  /* ── Photo retrieval ───────────────────────────────── */
  ipcMain.handle('photos:getForFolder', async (_event, folderPath) => {
    const files = await scanDirectory(folderPath);
    const enriched = [];
    for (const f of files) {
      enriched.push(await enrichPhoto(f));
    }
    saveStore();
    return enriched;
  });

  ipcMain.handle('photos:getAll', async () => {
    const all = [];
    for (const folder of store.folders) {
      const files = await scanDirectory(folder);
      for (const f of files) {
        const enriched = await enrichPhoto(f);
        all.push({ ...enriched, folder });
      }
    }
    // Include standalone files
    for (const fp of store.files) {
      try {
        const stat = await fs.promises.stat(fp);
        const photo = {
          path: fp, name: path.basename(fp),
          size: stat.size, mtime: stat.mtimeMs,
          ext: path.extname(fp).toLowerCase(),
        };
        const enriched = await enrichPhoto(photo);
        all.push({ ...enriched, folder: '__standalone__' });
      } catch { /* skip */ }
    }
    saveStore();
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
}

/* ═══════════════════════════════════════════════════════
   APP LIFECYCLE
   ═══════════════════════════════════════════════════════ */

app.whenReady().then(() => {
  initPaths();
  loadStore();
  registerIpcHandlers();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
