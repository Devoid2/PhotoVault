<p align="center">
  <h1 align="center">PhotoVault</h1>
  <p align="center">Minimalist desktop photo storage and organization</p>
</p>

<p align="center">
  <a href="https://github.com/Devoid2/PhotoVault/releases/latest">
    <img src="https://img.shields.io/badge/Download-macOS-000000?style=for-the-badge&logo=apple&logoColor=white" alt="Download for macOS">
  </a>
  &nbsp;
  <a href="https://github.com/Devoid2/PhotoVault/releases/latest">
    <img src="https://img.shields.io/badge/Download-Windows-0078D4?style=for-the-badge&logo=windows&logoColor=white" alt="Download for Windows">
  </a>
</p>

<p align="center">
  <img src="https://img.shields.io/github/v/release/Devoid2/PhotoVault?style=flat-square&color=333&label=version" alt="Version">
  <img src="https://img.shields.io/badge/electron-33-47848F?style=flat-square" alt="Electron">
  <img src="https://img.shields.io/badge/license-MIT-444?style=flat-square" alt="License">
</p>

---

## Installation

### macOS
1. Download **PhotoVault.dmg** from [Releases](https://github.com/Devoid2/PhotoVault/releases/latest)
2. Open the DMG and drag **PhotoVault** to your Applications folder
3. Launch from Applications

### Windows
1. Download **PhotoVault Setup.exe** from [Releases](https://github.com/Devoid2/PhotoVault/releases/latest)
2. Run the installer and follow the prompts
3. Launch from Start Menu or Desktop shortcut

---

## Features

- **Folder browsing** — add folders from your filesystem, browse photos in a grid
- **By Date view** — photos grouped by EXIF capture date (newest first)
- **Collections** — create virtual albums, drag & drop photos to organize
- **EXIF metadata** — camera body, lens, ISO, aperture, shutter speed, focal length
- **Fullscreen viewer** — double-click to view, arrow keys to navigate
- **Individual photo import** — add single files alongside entire folders
- **Right-click menu** — quickly add any photo to a collection
- **Thumbnail caching** — WebP thumbnails via Sharp for instant browsing
- **RAW support** — CR2, CR3 (embedded preview extraction)
- **Multi-device sync** — use Google Drive or iCloud to access your library from any machine

## Supported Formats

| Format | Type |
|--------|------|
| JPEG | Standard |
| PNG | Standard |
| CR2 | Canon RAW |
| CR3 | Canon RAW |

## Building from Source

```bash
git clone https://github.com/Devoid2/PhotoVault.git
cd PhotoVault
npm install
npm start
```

### Package for Distribution

```bash
# macOS (.dmg)
npm run build:mac

# Windows (.exe installer)
npm run build:win

# Both platforms
npm run build
```

Built files appear in `dist/`.

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Framework | Electron 33 |
| EXIF parsing | exifr |
| Thumbnails | Sharp (libvips) |
| Packaging | electron-builder |
| UI | Vanilla HTML / CSS / JS |
| Design | Dark monochrome, Inter font |

## License

MIT © [Devoid2](https://github.com/Devoid2)
