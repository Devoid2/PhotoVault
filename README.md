# PhotoVault

Minimalist desktop photo storage and organization app built with Electron.

![Dark monochrome UI](https://img.shields.io/badge/theme-dark%20monochrome-111111)
![Electron](https://img.shields.io/badge/Electron-33-47848F)
![Platform](https://img.shields.io/badge/platform-macOS-999)

## Features

- **Folder browsing** — add folders from your filesystem, browse photos in a grid
- **By Date view** — photos grouped by EXIF date taken (newest first)
- **Collections** — create virtual albums, drag & drop photos into them
- **EXIF metadata** — camera body, lens, ISO, aperture, shutter speed, focal length
- **Fullscreen viewer** — double-click to view, arrow keys to navigate
- **Individual photo import** — add single files alongside folders
- **Thumbnail caching** — WebP thumbnails generated via Sharp for fast browsing
- **RAW support** — CR2, CR3 (embedded preview extraction via exifr)

## Supported Formats

JPEG, PNG, CR2, CR3

## Getting Started

```bash
npm install
npm start
```

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Framework | Electron 33 |
| EXIF parsing | exifr |
| Thumbnails | Sharp (libvips) |
| UI | Vanilla HTML/CSS/JS |
| Design | Dark monochrome, Inter font |

## License

MIT
