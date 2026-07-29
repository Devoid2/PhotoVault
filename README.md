<p align="center">
  <h1 align="center">PhotoVault</h1>
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

## Supported Formats

| Format | Type | Thumbnail / Preview |
|--------|------|---------------------|
| JPEG | Standard | Native browser display |
| PNG | Standard | Native browser display |
| HEIC / HEIF | iPhone / High Efficiency | Sharp (libvips + libheif) → heic-convert fallback |
| CR2 | Canon RAW | Embedded JPEG preview (exifr) |
| CR3 | Canon RAW | Embedded JPEG preview (exifr) |
| NEF | Nikon RAW | Embedded JPEG preview (exifr) |
| ARW | Sony RAW | Embedded JPEG preview (exifr) |
| DNG | Adobe RAW | Embedded JPEG preview (exifr) |
| ORF | Olympus RAW | Embedded JPEG preview (exifr) |
| RW2 | Panasonic RAW | Embedded JPEG preview (exifr) |
| RAF | Fuji RAW | Embedded JPEG preview (exifr) |

## Changelog

### 1.4.0 (2026-07-30)

**Smooth Fullscreen Animation**
- Zoom/morph animation opening from card position to fullscreen (cubic-bezier ease-out)
- Smooth blur reveal effect on full-resolution images
- Fade-in staggered control buttons (close, prev, next) and info bar
- Slide animation between photos during keyboard (←/→) navigation
- Reverse morph animation when closing back to the original card

**Extended RAW Format Support**
- Added support for Nikon NEF, Sony ARW, Adobe DNG, Olympus ORF, Panasonic RW2, Fuji RAF
- Embedded JPEG preview extraction via exifr for all supported RAW formats
- Placeholder thumbnail generation with format label for RAW files without embedded preview
- Updated RAW filter to recognize all new formats

**Additional Improvements**
- Faster RAW thumbnail generation with preview caching
- Better error handling for unsupported image types

### 1.3.0
- Collections feature (create, rename, delete virtual albums)
- Drag & drop photos into collections
- Right-click context menu for quick collection assignment
- Collection management in metadata panel
- Haptic feedback on macOS trackpad for drag operations

### 1.2.0
- Photo grid with lazy-loaded WebP thumbnails via Sharp
- File watcher for real-time updates on folder changes
- Tabbed browsing (Folders / By Date)
- Photo type filter (All / Photos / RAW)
- Incremental photo addition/removal without full reload
- Electron auto-updater integration

### 1.1.0
- Fullscreen viewer with keyboard navigation (← →)
- EXIF metadata panel (camera, lens, ISO, aperture, shutter, focal length)
- Light / Dark / System theme toggle
- Settings view with theme picker
- Standalone photo import (individual files)
- macOS title bar with custom window controls

### 1.0.0
- Initial release
- Folder-based photo browsing
- SQLite-backed library database
- Basic grid layout with thumbnail display

## License

MIT © [Devoid2](https://github.com/Devoid2)
