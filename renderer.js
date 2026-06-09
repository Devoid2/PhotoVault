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
};

/* ═══════════════════════════════════════════════════════
   INIT
   ═══════════════════════════════════════════════════════ */

(async function init() {
  // Load persisted data
  state.folders = await api.getFolders();
  state.standalonePhotos = await api.getStandalonePhotos();
  state.collections = await api.getCollections();
  renderFolderList();
  renderCollectionList();
  updateSidebarEmpty();

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

  // Add to Collection dropdown
  $('#meta-add-to-collection').addEventListener('click', toggleCollectionDropdown);
  $('#collection-dropdown-new').addEventListener('click', handleDropdownNewCollection);

  // Context menu: "New Collection" button
  $('#context-menu-new').addEventListener('click', handleContextMenuNewCollection);

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
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });

  // Keyboard
  document.addEventListener('keydown', handleKeyboard);

  // Auto-select first folder, or standalone photos, or show welcome
  if (state.folders.length > 0) {
    selectFolder(state.folders[0]);
  } else if (state.standalonePhotos.length > 0) {
    selectFolder('__standalone__');
  }
})();

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
  renderPhotoGrid(photos);
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
  renderPhotoGrid(state.standalonePhotos);
  showGrid();

  if (state.currentTab === 'date') {
    switchTab('folders');
  }
}

async function selectFolder(folderPath) {
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
  renderPhotoGrid(photos);
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
    li.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      li.classList.add('drag-over');
    });
    li.addEventListener('dragleave', () => li.classList.remove('drag-over'));
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
      renderPhotoGrid(photos);
      showGrid();
    } else {
      showWelcome();
    }
  } else if (tab === 'date') {
    showLoading();
    const allPhotos = await api.getAllPhotos();
    state.allPhotos = allPhotos;
    renderDateGroupedGrid(allPhotos);
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

  // Sort keys descending (newest first)
  const sortedKeys = Object.keys(groups).sort().reverse();

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
    $('#meta-lens').textContent    = exif?.LensModel || '—';
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
        renderPhotoGrid(photos);
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
        renderPhotoGrid(photos);
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
