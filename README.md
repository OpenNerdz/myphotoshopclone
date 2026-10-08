# Image Overlay Studio

A fast, private image layering editor that runs entirely in the browser. Stack
photos, blend them, fine-tune colour, crop and export in full resolution. Images
never leave the device. There is no backend, account or upload.

Live site: <https://myphotoshopclone.netlify.app/>

## Features

- **Layers**: add by picker, drag & drop or paste. Reorder by dragging (mouse or
  touch), rename, duplicate, hide, lock, delete.
- **Direct manipulation**: move, scale and rotate on the canvas, with smart guides
  that snap to the canvas and other layers. Shift constrains; Alt scales from
  the centre; hold Ctrl/⌘ to disable snapping.
- **Blend modes**: Normal plus 16 modes (Multiply, Screen, Overlay, Soft light, Difference, Luminosity…) and opacity.
- **Adjustments**: brightness, contrast, saturation, hue, blur, grayscale, sepia,
  invert, plus one-click presets with live thumbnails.
- **Canvas**: real document size (taken from the first image or a preset), transparent
  or colour background, crop with aspect presets, trim to layers.
- **Export**: PNG, JPEG or WebP at 25–200% of the canvas size, with download,
  native share sheet (mobile) and copy to clipboard.
- **Undo/redo** for every edit, plus **autosave** to IndexedDB so a refresh or crash
  never loses work.
- **Responsive**: an editor layout on desktop, a full-screen canvas with bottom-sheet
  panels on phones, plus pinch-zoom, double-tap zoom and trackpad gestures.
- **Installable PWA** that works offline.
- Keyboard shortcuts for everything (press <kbd>?</kbd> in the app).

## Running locally

The app uses native ES modules, so it must be served over HTTP. Opening
`index.html` from the file system will not work.

```sh
npm start            # serves the folder at http://localhost:5173
# or
python3 -m http.server 5173
```

There is no build step and there are no runtime dependencies.

## Tests

```sh
npm test
```

Runs the Node unit tests for the pure modules (geometry, filters/colour
matrices, undo history) and project integrity checks (service-worker precache
list, asset references, icon sprite, manifest).

## Project layout

| Path | Purpose |
| --- | --- |
| `index.html` | Markup and the inline SVG icon sprite |
| `styles.css` | Design tokens, desktop and phone layouts |
| `js/main.js` | Entry point and service-worker registration |
| `js/app.js` | Document state, actions, undo, view transform, autosave |
| `js/renderer.js` | Canvas rendering with mip levels, filter caches and tiles |
| `js/compositor.js` | Shared drawing and filter pipeline (GPU and CPU fallback) |
| `js/viewport.js` | Canvas gestures: select, move, scale, rotate, pan, pinch |
| `js/crop.js` | Crop tool |
| `js/layers-panel.js`, `js/properties.js` | Side panel / bottom sheet UI |
| `js/shell.js` | Top bar, menus, file intake, shortcuts, phone sheet |
| `js/dialogs.js` | Export, shortcuts and confirm dialogs |
| `js/exporter.js` | Full-resolution export |
| `js/images.js` | Decoding, size limits, previews |
| `js/storage.js` | IndexedDB autosave |
| `js/geometry.js`, `js/filters.js`, `js/history.js` | Pure logic (unit tested) |
| `sw.js`, `manifest.webmanifest`, `icons/` | Offline support and install metadata |
| `_headers` | Netlify security and caching headers |

## How it works

- Layers are positioned in **document pixels**, independent of the window size,
  so crops and exports are exact and full resolution.
- On screen, each layer is drawn from the smallest pre-scaled copy that covers
  its displayed size, and filtered results are cached. Panning and zooming
  never re-run filters. When zoomed past the preview resolution, only the
  visible part of the full-resolution image is filtered.
- Adjustments use the canvas `filter` API where available. Browsers without it
  (Safari) fall back to an equivalent colour-matrix and blur implementation that
  matches the GPU output. Add `?cpu-filters` to the URL to force the fallback.
- Very large images are scaled to stay within browser canvas limits
  (16 MP on iOS, 40 MP elsewhere).

## Deployment

The site is static. Deploy the repository root to Netlify (or any static host).
`_headers` sets a strict Content-Security-Policy that only allows same-origin
resources. If you add third-party scripts, analytics or Netlify snippet
injection, extend the policy accordingly.

When you add or rename a file under `js/`, also list it in `sw.js` (`SHELL`) and
bump `VERSION`. `npm test` fails if the list is out of date.
