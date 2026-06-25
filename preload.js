const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  /* ── Folder management ─────────────────────────────── */
  selectFolder:    ()           => ipcRenderer.invoke('dialog:selectFolder'),
  getFolders:      ()           => ipcRenderer.invoke('store:getFolders'),
  addFolder:       (folderPath) => ipcRenderer.invoke('store:addFolder', folderPath),
  removeFolder:    (folderPath) => ipcRenderer.invoke('store:removeFolder', folderPath),

  /* ── Individual file management ────────────────────── */
  selectFiles:          ()           => ipcRenderer.invoke('dialog:selectFiles'),
  addFiles:             (filePaths)  => ipcRenderer.invoke('store:addFiles', filePaths),
  removeFile:           (filePath)   => ipcRenderer.invoke('store:removeFile', filePath),
  getStandalonePhotos:  ()           => ipcRenderer.invoke('photos:getStandalone'),

  /* ── Collections ───────────────────────────────────── */
  getCollections:       ()               => ipcRenderer.invoke('collections:getAll'),
  createCollection:     (name)           => ipcRenderer.invoke('collections:create', name),
  renameCollection:     (id, name)       => ipcRenderer.invoke('collections:rename', id, name),
  deleteCollection:     (id)             => ipcRenderer.invoke('collections:delete', id),
  addPhotoToCollection: (id, photoPath)  => ipcRenderer.invoke('collections:addPhoto', id, photoPath),
  removePhotoFromCollection: (id, photoPath) => ipcRenderer.invoke('collections:removePhoto', id, photoPath),
  getCollectionPhotos:  (id)             => ipcRenderer.invoke('collections:getPhotos', id),
  getCollectionsForPhoto: (photoPath)    => ipcRenderer.invoke('collections:getForPhoto', photoPath),

  /* ── Settings ─────────────────────────────────────────── */
  getSettings:          ()              => ipcRenderer.invoke('settings:getAll'),
  getSetting:           (key)           => ipcRenderer.invoke('settings:get', key),
  setSetting:           (key, value)    => ipcRenderer.invoke('settings:set', key, value),

  /* ── Photo operations ──────────────────────────────── */
  getPhotosForFolder: (folderPath) => ipcRenderer.invoke('photos:getForFolder', folderPath),
  getAllPhotos:       ()            => ipcRenderer.invoke('photos:getAll'),
  getThumbnail:      (filePath)    => ipcRenderer.invoke('photos:getThumbnail', filePath),
  getFullImage:      (filePath)    => ipcRenderer.invoke('photos:getFullImage', filePath),
  getExifData:       (filePath)    => ipcRenderer.invoke('photos:getExif', filePath),

  /* ── Window controls (macOS hidden-inset titlebar) ── */
  minimizeWindow: () => ipcRenderer.send('window:minimize'),
  maximizeWindow: () => ipcRenderer.send('window:maximize'),
  closeWindow:    () => ipcRenderer.send('window:close'),

  /* ── Auto-update ────────────────────────────────────── */
  onUpdateAvailable:  (cb) => ipcRenderer.on('update:available',  (_e, info) => cb(info)),
  onUpdateProgress:   (cb) => ipcRenderer.on('update:progress',   (_e, info) => cb(info)),
  onUpdateDownloaded: (cb) => ipcRenderer.on('update:downloaded', () => cb()),
  downloadUpdate:     ()   => ipcRenderer.invoke('update:download'),
  installUpdate:      ()   => ipcRenderer.invoke('update:install'),
  onUpdateNotAvailable: (cb) => ipcRenderer.on('update:not-available', () => cb()),
  onUpdateError:        (cb) => ipcRenderer.on('update:error', (_e, msg) => cb(msg)),
  checkForUpdate:       ()   => ipcRenderer.invoke('update:check'),

  getAppVersion:        ()   => ipcRenderer.invoke('app:getVersion'),
  getRawExtensions:     ()   => ipcRenderer.invoke('app:getRawExtensions'),

  /* ── Haptic feedback ────────────────────────────────── */
  hapticTap: () => ipcRenderer.send('haptic:tap'),
});
