/* ═══════════════════════════════════════════════════════════════
   PhotoVault — Renderer  (frontend logic)
   ═══════════════════════════════════════════════════════════════ */

const api = window.electronAPI;

/* ── State ─────────────────────────────────────────────── */
const state = {
  folders:           [],   // string[] — folder paths
  standalonePhotos:  [],   // photos added individually
  collections:       [],   // { id, name, count }[]
  currentTab:        'folders',
  currentFolder:     null, // folder path | '__standalone__' | '__collection__:id'
  photos:            [],   // current photo list to display
  allPhotos:         [],   // all photos from every folder (for date tab)
  selectedPhoto:     null, // { path, name, ... }
  fullscreenIdx:  -1,
  fullscreenList: [],   // list of photos in current context (for ←/→ nav)
  settingsOpen:   false,
  theme:          'dark', // 'dark' | 'light' | 'system'
  updateStatus:   'checking', // 'checking' | 'up-to-date' | 'available' | 'downloading' | 'ready' | 'error'
  currentFilter:  'all',  // 'all' | 'photos' | 'raw'
  separateRaw:    false,  // whether filter toggle is visible
  rawExtensions:  [],     // ['.cr2', '.cr3', ...]
};

/* ── DOM refs ──────────────────────────────────────────── */
const $ = (sel) => document.querySelector(sel);
const dom = {
  folderList:     $('#folder-list'),
  sidebarEmpty:   $('#sidebar-empty'),
  addFolderBtn:   $('#btn-add-folder'),
  addPhotosBtn:   $('#btn-add-photos'),
  tabBar:         $('#tab-bar'),
  // Collections sidebar
  collectionList:      $('#collection-list'),
  newCollectionBtn:    $('#btn-new-collection'),
  newCollectionWrap:   $('#new-collection-input'),
  newCollectionInput:  $('#collection-name-input'),
  // Main content
  gridContainer:  $('#grid-container'),
  welcomeState:   $('#welcome-state'),
  loadingState:   $('#loading-state'),
  photoGrid:      $('#photo-grid'),
  photoCount:     $('#photo-count'),
  metaPanel:      $('#meta-panel'),
  closeMetaBtn:   $('#btn-close-meta'),
  fsOverlay:      $('#fullscreen-overlay'),
  fsImage:        $('#fs-image'),
  fsClose:        $('#fs-close'),
  fsPrev:         $('#fs-prev'),
  fsNext:         $('#fs-next'),
  fsFilename:     $('#fs-filename'),
  fsCounter:      $('#fs-counter'),
  // Settings
  settingsBtn:    $('#btn-settings'),
  settingsView:   $('#settings-view'),
  aboutVersion:   $('#about-version'),
  aboutUpdate:    $('#about-update-status'),
  checkUpdateBtn: $('#btn-check-update'),
  // Filter
  photoFilter:    $('#photo-filter'),
  separateRawToggle: $('#toggle-separate-raw'),
};

/* ═══════════════════════════════════════════════════════
   INIT
   ═══════════════════════════════════════════════════════ */

(async function init() {
  // Load theme first (before any rendering to avoid flash)
  const savedTheme = await api.getSetting('theme');
  state.theme = savedTheme || 'dark';
  applyTheme(state.theme);

  // Load persisted data
  state.folders = await api.getFolders();
  state.standalonePhotos = await api.getStandalonePhotos();
  state.collections = await api.getCollections();
  renderFolderList();
  renderCollectionList();
  updateSidebarEmpty();

  // Load app version
  api.getAppVersion().then(v => {
    dom.aboutVersion.textContent = v || '—';
  });

  // Load RAW extensions
  state.rawExtensions = await api.getRawExtensions();

  // Load separateRaw setting
  const savedSeparateRaw = await api.getSetting('separateRaw');
  state.separateRaw = savedSeparateRaw === true;
  updateFilterVisibility();
  dom.separateRawToggle.checked = state.separateRaw;

  // Bind events
  dom.addFolderBtn.addEventListener('click', handleAddFolder);
  dom.addPhotosBtn.addEventListener('click', handleAddPhotos);
  dom.newCollectionBtn.addEventListener('click', showNewCollectionInput);
  dom.newCollectionInput.addEventListener('keydown', handleNewCollectionKey);
  dom.newCollectionInput.addEventListener('blur', commitNewCollection);
  dom.closeMetaBtn.addEventListener('click', closeMetaPanel);
  dom.fsClose.addEventListener('click', closeFullscreen);
  dom.fsPrev.addEventListener('click', () => navigateFullscreen(-1));
  dom.fsNext.addEventListener('click', () => navigateFullscreen(1));

  // Settings
  dom.settingsBtn.addEventListener('click', toggleSettings);
  dom.checkUpdateBtn.addEventListener('click', () => {
    setUpdateStatus('checking', 'Checking…');
    api.checkForUpdate();
  });

  // Separate RAW toggle in settings
  dom.separateRawToggle.addEventListener('change', () => {
    state.separateRaw = dom.separateRawToggle.checked;
    api.setSetting('separateRaw', state.separateRaw);
    updateFilterVisibility();
    if (!state.separateRaw) {
      state.currentFilter = 'all';
    }
    reapplyFilter();
  });

  // Photo filter buttons
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      state.currentFilter = btn.dataset.filter;
      document.querySelectorAll('.filter-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.filter === state.currentFilter)
      );
      reapplyFilter();
    });
  });

  // Theme picker
  document.querySelectorAll('.theme-option').forEach(btn => {
    btn.addEventListener('click', () => {
      const theme = btn.dataset.theme;
      state.theme = theme;
      applyTheme(theme);
      api.setSetting('theme', theme);
      updateThemePicker();
    });
  });
  updateThemePicker();

  // Add to Collection dropdown
  $('#meta-add-to-collection').addEventListener('click', toggleCollectionDropdown);
  $('#collection-dropdown-new').addEventListener('click', handleDropdownNewCollection);

  // Context menu buttons
  $('#context-menu-new').addEventListener('click', handleContextMenuNewCollection);
  $('#context-menu-remove').addEventListener('click', handleContextMenuRemove);

  // Confirm dialog buttons
  $('#confirm-cancel').addEventListener('click', () => hideConfirm(false));
  $('#confirm-ok').addEventListener('click', () => hideConfirm(true));

  // Close dropdown & context menu on outside click
  document.addEventListener('click', (e) => {
    const dd = $('#collection-dropdown');
    const btn = $('#meta-add-to-collection');
    if (dd.style.display !== 'none' && !dd.contains(e.target) && !btn.contains(e.target)) {
      dd.style.display = 'none';
    }
    const cm = $('#context-menu');
    if (cm.style.display !== 'none' && !cm.contains(e.target)) {
      cm.style.display = 'none';
    }
  });

  // Tab switching
  dom.tabBar.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      if (state.settingsOpen) closeSettings();
      switchTab(tab.dataset.tab);
    });
  });

  // Keyboard
  document.addEventListener('keydown', handleKeyboard);

  // Auto-select first folder, or standalone photos, or show welcome
  if (state.folders.length > 0) {
    selectFolder(state.folders[0]);
  } else if (state.standalonePhotos.length > 0) {
    selectFolder('__standalone__');
  }

  // ── Auto-update UI ────────────────────────────────────
  setupUpdateBar();
})();

/* ═══════════════════════════════════════════════════════
   AUTO-UPDATE UI
   ═══════════════════════════════════════════════════════ */

function setUpdateStatus(status, text) {
  state.updateStatus = status;
  const el = dom.aboutUpdate;
  el.textContent = text;
  el.className = 'settings-about-value';
  if (status === 'up-to-date')   el.classList.add('status-ok');
  else if (status === 'checking') el.classList.add('status-checking');
  else if (status === 'error')    el.classList.add('status-error');
  else if (status === 'available' || status === 'ready') el.classList.add('status-available');
}

function setupUpdateBar() {
  const bar       = $('#update-bar');
  const text      = $('#update-text');
  const actionBtn = $('#update-action');
  const dismiss   = $('#update-dismiss');
  const progWrap  = $('#update-progress-wrap');
  const progFill  = $('#update-progress-fill');
  const progPct   = $('#update-percent');

  let updateState = 'idle'; // idle | available | downloading | ready

  api.onUpdateAvailable((info) => {
    updateState = 'available';
    text.textContent = `Version ${info.version} is available`;
    actionBtn.textContent = 'Download';
    actionBtn.style.display = '';
    progWrap.style.display = 'none';
    bar.style.display = 'block';
    setUpdateStatus('available', `v${info.version} available`);
  });

  api.onUpdateNotAvailable(() => {
    setUpdateStatus('up-to-date', 'Up to date');
  });

  api.onUpdateProgress((info) => {
    updateState = 'downloading';
    text.textContent = 'Downloading update…';
    actionBtn.style.display = 'none';
    progWrap.style.display = 'flex';
    progFill.style.width = info.percent + '%';
    progPct.textContent = info.percent + '%';
    setUpdateStatus('downloading', `Downloading ${info.percent}%`);
  });

  api.onUpdateDownloaded(() => {
    updateState = 'ready';
    text.textContent = 'Update ready — restart to apply';
    progWrap.style.display = 'none';
    actionBtn.style.display = '';
    actionBtn.textContent = 'Restart';
    setUpdateStatus('ready', 'Restart to update');
  });

  api.onUpdateError((msg) => {
    setUpdateStatus('error', 'Update check failed');
    console.error('Update error:', msg);
  });

  actionBtn.addEventListener('click', () => {
    if (updateState === 'available') {
      api.downloadUpdate();
      text.textContent = 'Starting download…';
      actionBtn.style.display = 'none';
    } else if (updateState === 'ready') {
      api.installUpdate();
    }
  });

  dismiss.addEventListener('click', () => {
    bar.style.display = 'none';
  });
}

/* ═══════════════════════════════════════════════════════
   THEME MANAGEMENT
   ═══════════════════════════════════════════════════════ */

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
}

function updateThemePicker() {
  document.querySelectorAll('.theme-option').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.theme === state.theme);
  });
}

/* ═══════════════════════════════════════════════════════
   SETTINGS VIEW
   ═══════════════════════════════════════════════════════ */

function toggleSettings() {
  if (state.settingsOpen) {
    closeSettings();
  } else {
    openSettings();
  }
}

function openSettings() {
  state.settingsOpen = true;
  // Hide photo content
  dom.gridContainer.style.display = 'none';
  dom.tabBar.style.display = 'none';
  // Show settings
  dom.settingsView.style.display = '';
  // Update sidebar button
  dom.settingsBtn.classList.add('active');
  // Deactivate folder/collection highlights
  document.querySelectorAll('.folder-item.active').forEach(el => el.classList.remove('active'));
  // Close meta panel if open
  closeMetaPanel();
}

function closeSettings() {
  state.settingsOpen = false;
  // Hide settings
  dom.settingsView.style.display = 'none';
  // Show photo content
  dom.gridContainer.style.display = '';
  dom.tabBar.style.display = '';
  // Update sidebar button
  dom.settingsBtn.classList.remove('active');
  // Re-highlight active folder
  highlightActiveFolder();
}

/* ═══════════════════════════════════════════════════════
   PHOTO FILTER (RAW / Photos / All)
   ═══════════════════════════════════════════════════════ */

function isRawPhoto(photo) {
  return state.rawExtensions.includes(photo.ext);
}

function filterPhotos(photos) {
  if (!state.separateRaw || state.currentFilter === 'all') return photos;
  if (state.currentFilter === 'raw') return photos.filter(p => isRawPhoto(p));
  if (state.currentFilter === 'photos') return photos.filter(p => !isRawPhoto(p));
  return photos;
}

function updateFilterVisibility() {
  dom.photoFilter.classList.toggle('visible', state.separateRaw);
}

function reapplyFilter() {
  // Update filter button highlights
  document.querySelectorAll('.filter-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.filter === state.currentFilter)
  );
  // Re-render current view
  if (state.currentTab === 'folders' && state.photos.length > 0) {
    const filtered = filterPhotos(state.photos);
    renderPhotoGrid(filtered);
  } else if (state.currentTab === 'date' && state.allPhotos.length > 0) {
    const filtered = filterPhotos(state.allPhotos);
    renderDateGroupedGrid(filtered);
  }
}

/* ═══════════════════════════════════════════════════════
   FOLDER MANAGEMENT
   ═══════════════════════════════════════════════════════ */

async function handleAddFolder() {
  const folderPath = await api.selectFolder();
  if (!folderPath) return;

  if (state.folders.includes(folderPath)) {
    selectFolder(folderPath);
    return;
  }

  showLoading();
  const photos = await api.addFolder(folderPath);
  state.folders.push(folderPath);
  state.photos = photos;
  state.currentFolder = folderPath;

  renderFolderList();
  updateSidebarEmpty();
  highlightActiveFolder();
  renderPhotoGrid(filterPhotos(photos));
  showGrid();

  if (state.currentTab === 'date') {
    switchTab('folders');
  }
}

async function handleAddPhotos() {
  const filePaths = await api.selectFiles();
  if (!filePaths || filePaths.length === 0) return;

  showLoading();
  const newPhotos = await api.addFiles(filePaths);
  state.standalonePhotos.push(...newPhotos);

  // Show standalone photos view
  state.currentFolder = '__standalone__';
  state.photos = state.standalonePhotos;

  renderFolderList();
  updateSidebarEmpty();
  highlightActiveFolder();
  renderPhotoGrid(filterPhotos(state.standalonePhotos));
  showGrid();

  if (state.currentTab === 'date') {
    switchTab('folders');
  }
}

async function selectFolder(folderPath) {
  if (state.settingsOpen) closeSettings();
  if (state.currentTab !== 'folders') {
    switchTab('folders');
  }

  state.currentFolder = folderPath;
  highlightActiveFolder();
  showLoading();

  let photos;
  if (folderPath === '__standalone__') {
    photos = await api.getStandalonePhotos();
    state.standalonePhotos = photos;
  } else if (folderPath.startsWith('__collection__:')) {
    const colId = folderPath.replace('__collection__:', '');
    photos = await api.getCollectionPhotos(colId);
  } else {
    photos = await api.getPhotosForFolder(folderPath);
  }
  state.photos = photos;
  renderPhotoGrid(filterPhotos(photos));
  showGrid();
}

async function removeFolder(folderPath, e) {
  e.stopPropagation();
  await api.removeFolder(folderPath);
  state.folders = state.folders.filter(f => f !== folderPath);

  if (state.currentFolder === folderPath) {
    state.currentFolder = null;
    state.photos = [];
    closeMetaPanel();
    showWelcome();
  }

  renderFolderList();
  updateSidebarEmpty();
}

/* ═══════════════════════════════════════════════════════
   FOLDER LIST RENDERING
   ═══════════════════════════════════════════════════════ */

function renderFolderList() {
  dom.folderList.innerHTML = '';

  // Standalone photos entry
  if (state.standalonePhotos.length > 0) {
    const li = document.createElement('li');
    li.className = 'folder-item';
    if (state.currentFolder === '__standalone__') li.classList.add('active');
    li.dataset.path = '__standalone__';
    li.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <rect x="1.5" y="2.5" width="11" height="9" rx="1" stroke="currentColor" stroke-width="1"/>
        <circle cx="5" cy="5.5" r="1.2" stroke="currentColor" stroke-width="0.9"/>
        <path d="M1.5 9.5L4.5 7L6.5 8.5L9 6L12.5 9.5" stroke="currentColor" stroke-width="0.9" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <span class="folder-name">Photos</span>
      <span class="folder-count">${state.standalonePhotos.length}</span>
    `;
    li.addEventListener('click', () => selectFolder('__standalone__'));
    dom.folderList.appendChild(li);
  }

  state.folders.forEach(folder => {
    const name = folder.split('/').pop() || folder;
    const li = document.createElement('li');
    li.className = 'folder-item';
    if (folder === state.currentFolder) li.classList.add('active');
    li.dataset.path = folder;
    li.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <path d="M1.5 3.5C1.5 2.94772 1.94772 2.5 2.5 2.5H5.5L7 4H11.5C12.0523 4 12.5 4.44772 12.5 5V10.5C12.5 11.0523 12.0523 11.5 11.5 11.5H2.5C1.94772 11.5 1.5 11.0523 1.5 10.5V3.5Z" stroke="currentColor" stroke-width="1"/>
      </svg>
      <span class="folder-name" title="${folder}">${name}</span>
      <button class="folder-remove" title="Remove folder">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path d="M2 2l6 6M8 2L2 8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
        </svg>
      </button>
    `;
    li.addEventListener('click', () => selectFolder(folder));
    li.querySelector('.folder-remove').addEventListener('click', (e) => removeFolder(folder, e));
    dom.folderList.appendChild(li);
  });
}

/* ═══════════════════════════════════════════════════════
   COLLECTION LIST RENDERING
   ═══════════════════════════════════════════════════════ */

function renderCollectionList() {
  dom.collectionList.innerHTML = '';

  state.collections.forEach(col => {
    const li = document.createElement('li');
    li.className = 'folder-item';
    const colKey = `__collection__:${col.id}`;
    if (state.currentFolder === colKey) li.classList.add('active');
    li.dataset.path = colKey;
    li.dataset.collectionId = col.id;
    li.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <rect x="1" y="3" width="12" height="9" rx="1.5" stroke="currentColor" stroke-width="1"/>
        <rect x="2.5" y="1.5" width="9" height="2" rx="0.5" stroke="currentColor" stroke-width="0.8" opacity="0.4"/>
      </svg>
      <span class="folder-name">${col.name}</span>
      <span class="folder-count">${col.count}</span>
      <button class="folder-remove" title="Delete collection">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path d="M2 2l6 6M8 2L2 8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
        </svg>
      </button>
    `;
    li.addEventListener('click', () => selectFolder(colKey));
    li.querySelector('.folder-remove').addEventListener('click', (e) => deleteCollection(col.id, e));

    // ── Drag & Drop target ──
    let _hapticFired = false;
    li.addEventListener('dragenter', (e) => {
      e.preventDefault();
      li.classList.add('drag-over');
      if (!_hapticFired) {
        _hapticFired = true;
        api.hapticTap();
      }
    });
    li.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    li.addEventListener('dragleave', (e) => {
      // Only reset when actually leaving the li (not entering a child)
      if (!li.contains(e.relatedTarget)) {
        li.classList.remove('drag-over');
        _hapticFired = false;
      }
    });
    li.addEventListener('drop', async (e) => {
      e.preventDefault();
      li.classList.remove('drag-over');
      const photoPath = e.dataTransfer.getData('text/photo-path');
      if (!photoPath) return;
      await api.addPhotoToCollection(col.id, photoPath);
      col.count = (col.count || 0) + 1;
      renderCollectionList();
      // Refresh meta panel if same photo is selected
      if (state.selectedPhoto && state.selectedPhoto.path === photoPath) {
        await renderPhotoCollections(photoPath);
      }
    });

    dom.collectionList.appendChild(li);
  });
}

function showNewCollectionInput() {
  dom.newCollectionWrap.style.display = 'block';
  dom.newCollectionInput.value = '';
  dom.newCollectionInput.focus();
}

function handleNewCollectionKey(e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    commitNewCollection();
  } else if (e.key === 'Escape') {
    dom.newCollectionWrap.style.display = 'none';
  }
}

async function commitNewCollection() {
  const name = dom.newCollectionInput.value.trim();
  dom.newCollectionInput.value = '';  // clear immediately to prevent double-fire from blur
  dom.newCollectionWrap.style.display = 'none';
  if (!name) return;

  const col = await api.createCollection(name);
  state.collections.push(col);
  renderCollectionList();
  selectFolder(`__collection__:${col.id}`);
}

async function deleteCollection(colId, e) {
  e.stopPropagation();
  await api.deleteCollection(colId);
  state.collections = state.collections.filter(c => c.id !== colId);

  if (state.currentFolder === `__collection__:${colId}`) {
    state.currentFolder = null;
    state.photos = [];
    closeMetaPanel();
    showWelcome();
  }
  renderCollectionList();
}

function highlightActiveFolder() {
  dom.folderList.querySelectorAll('.folder-item').forEach(item => {
    item.classList.toggle('active', item.dataset.path === state.currentFolder);
  });
  dom.collectionList.querySelectorAll('.folder-item').forEach(item => {
    item.classList.toggle('active', item.dataset.path === state.currentFolder);
  });
}

function updateSidebarEmpty() {
  const hasContent = state.folders.length > 0 || state.standalonePhotos.length > 0;
  dom.sidebarEmpty.style.display = hasContent ? 'none' : 'flex';
}

/* ═══════════════════════════════════════════════════════
   TAB SWITCHING
   ═══════════════════════════════════════════════════════ */

async function switchTab(tab) {
  state.currentTab = tab;

  dom.tabBar.querySelectorAll('.tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === tab);
  });

  closeMetaPanel();

  if (tab === 'folders') {
    if (state.currentFolder) {
      showLoading();
      const photos = await api.getPhotosForFolder(state.currentFolder);
      state.photos = photos;
      renderPhotoGrid(filterPhotos(photos));
      showGrid();
    } else {
      showWelcome();
    }
  } else if (tab === 'date') {
    showLoading();
    const allPhotos = await api.getAllPhotos();
    state.allPhotos = allPhotos;
    renderDateGroupedGrid(filterPhotos(allPhotos));
    showGrid();
  }
}

/* ═══════════════════════════════════════════════════════
   PHOTO GRID
   ═══════════════════════════════════════════════════════ */

function renderPhotoGrid(photos) {
  dom.photoGrid.innerHTML = '';

  state.fullscreenList = photos;
  dom.photoCount.textContent = `${photos.length} photo${photos.length !== 1 ? 's' : ''}`;

  photos.forEach((photo, index) => {
    const card = createPhotoCard(photo, index);
    dom.photoGrid.appendChild(card);
  });
}

function renderDateGroupedGrid(photos) {
  dom.photoGrid.innerHTML = '';

  // Group by month
  const groups = {};
  const noDate = [];

  photos.forEach(photo => {
    if (photo.dateTaken) {
      const d = new Date(photo.dateTaken);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (!groups[key]) groups[key] = [];
      groups[key].push(photo);
    } else {
      noDate.push(photo);
    }
  });

  // Sort keys descending (newest month first)
  const sortedKeys = Object.keys(groups).sort().reverse();

  // Sort photos within each group by date descending (newest day first)
  for (const key of sortedKeys) {
    groups[key].sort((a, b) => new Date(b.dateTaken) - new Date(a.dateTaken));
  }

  // Flat list for fullscreen navigation
  const flatList = [];
  let globalIdx = 0;

  sortedKeys.forEach(key => {
    const [year, month] = key.split('-');
    const monthName = new Date(year, parseInt(month) - 1).toLocaleString('en', { month: 'long' });

    const header = document.createElement('div');
    header.className = 'date-group-header';
    header.textContent = `${monthName} ${year}`;
    dom.photoGrid.appendChild(header);

    groups[key].forEach(photo => {
      flatList.push(photo);
      const card = createPhotoCard(photo, globalIdx);
      dom.photoGrid.appendChild(card);
      globalIdx++;
    });
  });

  if (noDate.length > 0) {
    const header = document.createElement('div');
    header.className = 'date-group-header';
    header.textContent = 'Unknown Date';
    dom.photoGrid.appendChild(header);

    noDate.forEach(photo => {
      flatList.push(photo);
      const card = createPhotoCard(photo, globalIdx);
      dom.photoGrid.appendChild(card);
      globalIdx++;
    });
  }

  state.fullscreenList = flatList;
  dom.photoCount.textContent = `${photos.length} photo${photos.length !== 1 ? 's' : ''}`;
}

function createPhotoCard(photo, index) {
  const card = document.createElement('div');
  card.className = 'photo-card';
  card.dataset.index = index;
  card.dataset.path = photo.path;
  card.draggable = true;

  const img = document.createElement('img');
  img.alt = photo.name;
  img.loading = 'lazy';
  card.appendChild(img);

  const label = document.createElement('div');
  label.className = 'photo-label';
  label.textContent = photo.name;
  card.appendChild(label);

  // Load thumbnail
  loadThumbnail(img, photo.path, card);

  // Click → select
  card.addEventListener('click', () => {
    selectPhoto(photo, index);
  });

  // Double-click → fullscreen
  card.addEventListener('dblclick', () => {
    openFullscreen(index);
  });

  // Right-click → context menu
  card.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, photo);
  });

  // Drag
  card.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/photo-path', photo.path);
    e.dataTransfer.effectAllowed = 'copy';
    card.classList.add('dragging');
  });
  card.addEventListener('dragend', () => {
    card.classList.remove('dragging');
  });

  return card;
}

async function loadThumbnail(imgEl, filePath, cardEl) {
  try {
    const thumbPath = await api.getThumbnail(filePath);
    if (thumbPath) {
      imgEl.src = `file://${thumbPath}`;
      imgEl.onload = () => {
        imgEl.classList.add('loaded');
        cardEl.classList.add('thumb-loaded');
      };
    }
  } catch {
    // Show broken image state
    cardEl.classList.add('thumb-loaded');
  }
}

/* ═══════════════════════════════════════════════════════
   PHOTO SELECTION & METADATA
   ═══════════════════════════════════════════════════════ */

async function selectPhoto(photo, index) {
  state.selectedPhoto = photo;

  // Highlight card
  dom.photoGrid.querySelectorAll('.photo-card').forEach(c => {
    c.classList.toggle('selected', parseInt(c.dataset.index) === index);
  });

  // Open metadata panel
  openMetaPanel();

  // Set filename
  $('#meta-filename').textContent = photo.name;

  // Set preview image
  const preview = $('#meta-preview');
  preview.innerHTML = '';
  const prevImg = document.createElement('img');
  try {
    const thumbPath = await api.getThumbnail(photo.path);
    if (thumbPath) prevImg.src = `file://${thumbPath}`;
  } catch { /* */ }
  preview.appendChild(prevImg);

  // Set basic file info
  $('#meta-filesize').textContent = formatFileSize(photo.size);
  $('#meta-format').textContent = photo.ext ? photo.ext.replace('.', '').toUpperCase() : '—';

  // Show collections this photo belongs to
  await renderPhotoCollections(photo.path);

  // Load full EXIF
  try {
    const exif = await api.getExifData(photo.path);

    const camera = [exif?.Make, exif?.Model].filter(Boolean).join(' ');
    $('#meta-camera').textContent  = cleanCameraName(camera) || '—';
    $('#meta-lens').textContent    = cleanLensName(exif) || '—';
    $('#meta-iso').textContent     = exif?.ISO || '—';
    $('#meta-aperture').textContent = exif?.FNumber ? `f/${exif.FNumber}` : '—';
    $('#meta-shutter').textContent  = formatShutter(exif?.ExposureTime);
    $('#meta-focal').textContent    = exif?.FocalLength ? `${exif.FocalLength}mm` : '—';

    const w = exif?.ExifImageWidth || exif?.ImageWidth;
    const h = exif?.ExifImageHeight || exif?.ImageHeight;
    $('#meta-dimensions').textContent = (w && h) ? `${w} × ${h}` : '—';

    const date = exif?.DateTimeOriginal || exif?.CreateDate;
    $('#meta-date').textContent = date ? formatDate(new Date(date)) : '—';
  } catch {
    // Clear EXIF fields on error
    ['#meta-camera','#meta-lens','#meta-iso','#meta-aperture',
     '#meta-shutter','#meta-focal','#meta-dimensions','#meta-date']
      .forEach(sel => $(sel).textContent = '—');
  }
}

function openMetaPanel() {
  dom.metaPanel.classList.add('open');
}

function closeMetaPanel() {
  dom.metaPanel.classList.remove('open');
  state.selectedPhoto = null;
  dom.photoGrid.querySelectorAll('.photo-card.selected').forEach(c => c.classList.remove('selected'));
}

/* ═══════════════════════════════════════════════════════
   FULLSCREEN VIEWER
   ═══════════════════════════════════════════════════════ */

async function openFullscreen(index) {
  state.fullscreenIdx = index;
  const photo = state.fullscreenList[index];
  if (!photo) return;

  dom.fsOverlay.style.display = 'flex';
  // Force reflow for transition
  requestAnimationFrame(() => {
    dom.fsOverlay.classList.add('visible');
  });

  dom.fsFilename.textContent = photo.name;
  dom.fsCounter.textContent  = `${index + 1} / ${state.fullscreenList.length}`;

  // Load image
  dom.fsImage.src = '';
  try {
    const imgPath = await api.getFullImage(photo.path);
    dom.fsImage.src = `file://${imgPath}`;
  } catch {
    // Try direct file path
    dom.fsImage.src = `file://${photo.path}`;
  }
}

function closeFullscreen() {
  dom.fsOverlay.classList.remove('visible');
  setTimeout(() => {
    dom.fsOverlay.style.display = 'none';
    dom.fsImage.src = '';
  }, 250);
  state.fullscreenIdx = -1;
}

async function navigateFullscreen(dir) {
  const newIdx = state.fullscreenIdx + dir;
  if (newIdx < 0 || newIdx >= state.fullscreenList.length) return;
  await openFullscreen(newIdx);
}

/* ═══════════════════════════════════════════════════════
   KEYBOARD
   ═══════════════════════════════════════════════════════ */

function handleKeyboard(e) {
  // Fullscreen mode
  if (state.fullscreenIdx >= 0) {
    if (e.key === 'Escape')      closeFullscreen();
    if (e.key === 'ArrowLeft')   navigateFullscreen(-1);
    if (e.key === 'ArrowRight')  navigateFullscreen(1);
    return;
  }

  // Normal mode
  if (e.key === 'Escape' && state.selectedPhoto) {
    closeMetaPanel();
  }
}

/* ═══════════════════════════════════════════════════════
   VISIBILITY HELPERS
   ═══════════════════════════════════════════════════════ */

function showWelcome() {
  dom.welcomeState.style.display = 'flex';
  dom.loadingState.style.display = 'none';
  dom.photoGrid.style.display    = 'none';
  dom.photoCount.textContent     = '';
}

function showLoading() {
  dom.welcomeState.style.display = 'none';
  dom.loadingState.style.display = 'flex';
  dom.photoGrid.style.display    = 'none';
}

function showGrid() {
  dom.welcomeState.style.display = 'none';
  dom.loadingState.style.display = 'none';
  dom.photoGrid.style.display    = 'grid';
}

/* ═══════════════════════════════════════════════════════
   COLLECTIONS — METADATA PANEL
   ═══════════════════════════════════════════════════════ */

async function renderPhotoCollections(photoPath) {
  const list = $('#meta-collections-list');
  list.innerHTML = '';

  const photoCols = await api.getCollectionsForPhoto(photoPath);

  photoCols.forEach(col => {
    const tag = document.createElement('span');
    tag.className = 'meta-collection-tag';
    tag.innerHTML = `
      ${col.name}
      <button class="tag-remove" title="Remove from ${col.name}">
        <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
          <path d="M1.5 1.5l5 5M6.5 1.5l-5 5" stroke="currentColor" stroke-width="1" stroke-linecap="round"/>
        </svg>
      </button>
    `;
    tag.querySelector('.tag-remove').addEventListener('click', async () => {
      await api.removePhotoFromCollection(col.id, photoPath);
      // Update count in state
      const sc = state.collections.find(c => c.id === col.id);
      if (sc) sc.count = Math.max(0, sc.count - 1);
      renderCollectionList();
      await renderPhotoCollections(photoPath);
      // If viewing this collection, refresh
      if (state.currentFolder === `__collection__:${col.id}`) {
        const photos = await api.getCollectionPhotos(col.id);
        state.photos = photos;
        renderPhotoGrid(filterPhotos(photos));
      }
    });
    list.appendChild(tag);
  });
}

function toggleCollectionDropdown() {
  const dd = $('#collection-dropdown');
  if (dd.style.display !== 'none') {
    dd.style.display = 'none';
    return;
  }
  // Populate dropdown
  populateCollectionDropdown();
  dd.style.display = 'block';
}

async function populateCollectionDropdown() {
  const ddList = $('#collection-dropdown-list');
  ddList.innerHTML = '';

  if (!state.selectedPhoto) return;
  const photoPath = state.selectedPhoto.path;
  const photoCols = await api.getCollectionsForPhoto(photoPath);
  const photoColIds = new Set(photoCols.map(c => c.id));

  state.collections.forEach(col => {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.className = 'collection-dropdown-item';
    if (photoColIds.has(col.id)) btn.classList.add('in-collection');
    btn.textContent = col.name;
    btn.addEventListener('click', async () => {
      if (photoColIds.has(col.id)) {
        await api.removePhotoFromCollection(col.id, photoPath);
        col.count = Math.max(0, col.count - 1);
      } else {
        await api.addPhotoToCollection(col.id, photoPath);
        col.count = (col.count || 0) + 1;
      }
      renderCollectionList();
      await renderPhotoCollections(photoPath);
      populateCollectionDropdown(); // refresh checkmarks
      // Refresh grid if viewing this collection
      if (state.currentFolder === `__collection__:${col.id}`) {
        const photos = await api.getCollectionPhotos(col.id);
        state.photos = photos;
        renderPhotoGrid(filterPhotos(photos));
      }
    });
    li.appendChild(btn);
    ddList.appendChild(li);
  });
}

async function handleDropdownNewCollection() {
  const dd = $('#collection-dropdown');
  dd.style.display = 'none';

  const name = prompt('New collection name:');
  if (!name || !name.trim()) return;

  const col = await api.createCollection(name.trim());
  state.collections.push(col);

  // Also add current photo to the new collection
  if (state.selectedPhoto) {
    await api.addPhotoToCollection(col.id, state.selectedPhoto.path);
    col.count = 1;
    await renderPhotoCollections(state.selectedPhoto.path);
  }

  renderCollectionList();
}

/* ═══════════════════════════════════════════════════════
   CONTEXT MENU (right-click on photo)
   ═══════════════════════════════════════════════════════ */

let _contextMenuPhoto = null;

async function showContextMenu(x, y, photo) {
  _contextMenuPhoto = photo;
  const cm = $('#context-menu');
  const cmList = $('#context-menu-list');
  cmList.innerHTML = '';

  const photoCols = await api.getCollectionsForPhoto(photo.path);
  const photoColIds = new Set(photoCols.map(c => c.id));

  state.collections.forEach(col => {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.className = 'context-menu-item';
    if (photoColIds.has(col.id)) btn.classList.add('in-collection');
    btn.textContent = col.name;
    btn.addEventListener('click', async () => {
      cm.style.display = 'none';
      if (photoColIds.has(col.id)) {
        await api.removePhotoFromCollection(col.id, photo.path);
        col.count = Math.max(0, col.count - 1);
      } else {
        await api.addPhotoToCollection(col.id, photo.path);
        col.count = (col.count || 0) + 1;
      }
      renderCollectionList();
      if (state.selectedPhoto && state.selectedPhoto.path === photo.path) {
        await renderPhotoCollections(photo.path);
      }
    });
    li.appendChild(btn);
    cmList.appendChild(li);
  });

  // Position the menu, keeping it within viewport
  cm.style.display = 'block';
  const rect = cm.getBoundingClientRect();
  const maxX = window.innerWidth - rect.width - 8;
  const maxY = window.innerHeight - rect.height - 8;
  cm.style.left = Math.min(x, maxX) + 'px';
  cm.style.top  = Math.min(y, maxY) + 'px';

  // Update remove button label based on context
  const removeBtn = $('#context-menu-remove');
  if (state.currentFolder && state.currentFolder.startsWith('__collection__:')) {
    const colId = state.currentFolder.replace('__collection__:', '');
    const col = state.collections.find(c => c.id === colId);
    removeBtn.childNodes[removeBtn.childNodes.length - 1].textContent =
      ` Remove from "${col?.name || 'collection'}"`;
  } else {
    removeBtn.childNodes[removeBtn.childNodes.length - 1].textContent = ' Remove from Library';
  }
}

async function handleContextMenuNewCollection() {
  const cm = $('#context-menu');
  cm.style.display = 'none';

  const name = prompt('New collection name:');
  if (!name || !name.trim()) return;

  const col = await api.createCollection(name.trim());
  state.collections.push(col);

  if (_contextMenuPhoto) {
    await api.addPhotoToCollection(col.id, _contextMenuPhoto.path);
    col.count = 1;
    if (state.selectedPhoto && state.selectedPhoto.path === _contextMenuPhoto.path) {
      await renderPhotoCollections(_contextMenuPhoto.path);
    }
  }

  renderCollectionList();
}

/* ═══════════════════════════════════════════════════════
   REMOVE FROM LIBRARY (context menu)
   ═══════════════════════════════════════════════════════ */

async function handleContextMenuRemove() {
  const cm = $('#context-menu');
  cm.style.display = 'none';

  if (!_contextMenuPhoto) return;
  const photo = _contextMenuPhoto;

  // If viewing a collection, offer to remove from that collection
  const isCollection = state.currentFolder && state.currentFolder.startsWith('__collection__:');
  const collectionId = isCollection ? state.currentFolder.replace('__collection__:', '') : null;
  const collectionName = isCollection
    ? state.collections.find(c => c.id === collectionId)?.name || 'this collection'
    : null;

  let title, message, btnText;
  if (isCollection) {
    title = 'Remove from collection?';
    message = `"${photo.name}" will be removed from "${collectionName}". The file will not be deleted.`;
    btnText = 'Remove';
  } else {
    title = 'Remove from library?';
    message = `"${photo.name}" will be removed from your PhotoVault library. The file on disk will not be deleted.`;
    btnText = 'Remove';
  }

  const confirmed = await showConfirm(title, message, btnText);
  if (!confirmed) return;

  if (isCollection) {
    await api.removePhotoFromCollection(collectionId, photo.path);
    const col = state.collections.find(c => c.id === collectionId);
    if (col) col.count = Math.max(0, col.count - 1);
    renderCollectionList();
  } else {
    // Remove from standalone files if it's there
    await api.removeFile(photo.path);

    // Remove from ALL collections too
    for (const col of state.collections) {
      await api.removePhotoFromCollection(col.id, photo.path);
    }
    // Refresh collection counts
    const freshCols = await api.getCollections();
    state.collections = freshCols;
    renderCollectionList();
  }

  // Close meta panel if this photo was selected
  if (state.selectedPhoto && state.selectedPhoto.path === photo.path) {
    closeMetaPanel();
  }

  // Refresh current view
  if (state.currentTab === 'date') {
    switchTab('date');
  } else if (isCollection) {
    selectFolder(state.currentFolder);
  } else if (state.currentFolder) {
    selectFolder(state.currentFolder);
  }
}

/* ═══════════════════════════════════════════════════════
   CUSTOM CONFIRM DIALOG
   ═══════════════════════════════════════════════════════ */

let _confirmResolve = null;

function showConfirm(title, message, okText = 'Remove') {
  return new Promise(resolve => {
    _confirmResolve = resolve;
    $('#confirm-title').textContent = title;
    $('#confirm-message').textContent = message;
    $('#confirm-ok').textContent = okText;
    const overlay = $('#confirm-overlay');
    overlay.style.display = 'flex';
    requestAnimationFrame(() => {
      requestAnimationFrame(() => overlay.classList.add('visible'));
    });
  });
}

function hideConfirm(result) {
  const overlay = $('#confirm-overlay');
  overlay.classList.remove('visible');
  setTimeout(() => {
    overlay.style.display = 'none';
  }, 200);
  if (_confirmResolve) {
    _confirmResolve(result);
    _confirmResolve = null;
  }
}

/* ═══════════════════════════════════════════════════════
   FORMATTERS
   ═══════════════════════════════════════════════════════ */

function formatFileSize(bytes) {
  if (!bytes) return '—';
  if (bytes < 1024)             return bytes + ' B';
  if (bytes < 1024 * 1024)     return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function formatShutter(val) {
  if (!val) return '—';
  if (val >= 1) return `${val}s`;
  const denominator = Math.round(1 / val);
  return `1/${denominator}s`;
}

function formatDate(d) {
  if (!(d instanceof Date) || isNaN(d)) return '—';
  return d.toLocaleDateString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

/** Remove duplicate brand prefix, e.g. "Canon Canon EOS R5" → "Canon EOS R5" */
function cleanCameraName(name) {
  if (!name) return '';
  const parts = name.split(' ');
  if (parts.length > 1 && parts[0].toLowerCase() === parts[1].toLowerCase()) {
    return parts.slice(1).join(' ');
  }
  return name;
}

/** Extract best lens name from EXIF, sanitize junk values */
function cleanLensName(exif) {
  if (!exif) return '';

  // Try fields in priority order
  let raw = exif.LensModel || exif.Lens || null;

  // LensInfo is often an array like [24, 70, 2.8, 2.8]
  if (!raw && exif.LensInfo) {
    const info = exif.LensInfo;
    if (Array.isArray(info) && info.length >= 2) {
      const fMin = info[0], fMax = info[1];
      const aMin = info[2], aMax = info[3];
      let s = '';
      if (fMin === fMax) s = `${fMin}mm`;
      else s = `${fMin}-${fMax}mm`;
      if (aMin && aMax) {
        s += aMin === aMax ? ` f/${aMin}` : ` f/${aMin}-${aMax}`;
      }
      return s;
    }
    if (typeof info === 'string') raw = info;
  }

  // LensID can be a number or string
  if (!raw && exif.LensID) {
    const lid = exif.LensID;
    if (typeof lid === 'string' && lid.length > 3 && !/^\d+$/.test(lid)) {
      raw = lid;
    }
  }

  if (!raw) return '';
  if (typeof raw !== 'string') return '';

  // Strip non-printable / control characters
  let cleaned = raw.replace(/[\x00-\x1F\x7F-\x9F]/g, '').trim();

  // Reject values that are clearly junk (all zeros, single chars, numeric IDs)
  if (!cleaned) return '';
  if (/^[0\s]+$/.test(cleaned)) return '';
  if (/^\d+$/.test(cleaned)) return '';
  if (cleaned.length < 3) return '';

  // Remove duplicate manufacturer prefix (e.g. "Canon Canon EF 50mm...")
  const words = cleaned.split(/\s+/);
  if (words.length > 1 && words[0].toLowerCase() === words[1].toLowerCase()) {
    cleaned = words.slice(1).join(' ');
  }

  return cleaned;
}
