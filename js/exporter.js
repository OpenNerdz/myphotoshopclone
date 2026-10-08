// Full-resolution export of the composition.

import { isIdentity } from './filters.js';
import { buildFiltered, drawLayer } from './compositor.js';
import { createCanvas, levelAtLeast, levelImage, MAX_AREA, MAX_SIDE } from './images.js';
import { layerExtent } from './geometry.js';

export const FORMATS = {
    'image/png': { ext: 'png', label: 'PNG', lossy: false, alpha: true },
    'image/jpeg': { ext: 'jpg', label: 'JPEG', lossy: true, alpha: false },
    'image/webp': { ext: 'webp', label: 'WebP', lossy: true, alpha: true }
};

export function exportSize(doc, scale) {
    return {
        w: Math.max(1, Math.round(doc.width * scale)),
        h: Math.max(1, Math.round(doc.height * scale))
    };
}

export function exportFits(doc, scale) {
    const { w, h } = exportSize(doc, scale);
    return w * h <= MAX_AREA && Math.max(w, h) <= MAX_SIDE;
}

const yieldToBrowser = () => new Promise((r) => setTimeout(r, 0));

/**
 * Render the composition at `scale` × document size.
 * @param background colour to flatten onto (used for formats without alpha)
 */
export async function renderComposite(state, assets, { scale = 1, background = null } = {}) {
    const { doc, layers } = state;
    const { w, h } = exportSize(doc, scale);
    const canvas = createCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    const bg = doc.background || background;
    if (bg) {
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, w, h);
    }

    // A dedicated layer canvas keeps blend modes honest when flattening onto a
    // background colour that the document itself does not have.
    const target = !doc.background && background ? createCanvas(w, h) : canvas;
    const tctx = target.getContext('2d');
    tctx.imageSmoothingEnabled = true;
    tctx.imageSmoothingQuality = 'high';
    tctx.setTransform(w / doc.width, 0, 0, h / doc.height, 0, 0);

    for (let i = layers.length - 1; i >= 0; i--) {
        const layer = layers[i];
        if (!layer.visible || layer.opacity <= 0) continue;
        const asset = assets.get(layer.assetId);
        if (!asset) continue;

        // Draw (and filter) the smallest pre-scaled level that still covers the output size.
        const L = levelAtLeast(asset, layerExtent(layer) * scale);
        const src = levelImage(L);

        if (isIdentity(layer.filters)) {
            drawLayer(tctx, layer, src, L.w, L.h, 0);
        } else {
            const f = buildFiltered(src, L.w, L.h, layer.filters);
            drawLayer(tctx, layer, f.canvas, L.w, L.h, f.pad);
            f.canvas.width = 0;
        }
        await yieldToBrowser();
    }

    if (target !== canvas) {
        ctx.drawImage(target, 0, 0);
        target.width = 0;
    }
    return canvas;
}

export function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not encode image'))), type, quality);
    });
}

export function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoking immediately can cancel the download in Safari/Firefox.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function safeFilename(name, fallback = 'composition') {
    const cleaned = String(name || '')
        .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^\.+/, '')
        .slice(0, 120);
    return cleaned || fallback;
}
