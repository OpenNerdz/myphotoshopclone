// Image decoding, size limiting and preview generation.

import { uid } from './dom.js';

const IS_IOS =
    /iP(hone|ad|od)/.test(navigator.platform || '') ||
    (navigator.userAgent.includes('Mac') && navigator.maxTouchPoints > 1);

// Browsers refuse to allocate canvases beyond these limits (iOS is strictest).
export const MAX_AREA = IS_IOS ? 16_000_000 : 40_000_000;
export const MAX_SIDE = IS_IOS ? 8192 : 16384;

/** Largest scale (≤ 1) that keeps a w × h canvas within those limits. */
export const limitScale = (w, h) => Math.min(1, MAX_SIDE / Math.max(w, h), Math.sqrt(MAX_AREA / (w * h)));

/** Long-side size of the GPU-friendly preview used while editing. */
export const PROXY_MAX = 2048;
const THUMB_MAX = 128;
const MASK_MIN = 512;
const SVG_RASTER = 2048;

const SUPPORTED_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|svg|ico|heic|heif|jfif|pjpeg|tiff?)$/i;

export const isImageFile = (file) => (file.type ? file.type.startsWith('image/') : SUPPORTED_EXT.test(file.name || ''));

export function createCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    return c;
}

/**
 * High-quality downscale. Halving in steps avoids the aliasing Safari produces
 * when drawImage shrinks by a large factor in one go.
 */
export function downscale(src, sw, sh, tw, th) {
    let cur = src;
    let cw = sw;
    let ch = sh;
    while (cw / 2 >= tw * 1.0001 && ch / 2 >= th * 1.0001) {
        const nw = Math.round(cw / 2);
        const nh = Math.round(ch / 2);
        const step = createCanvas(nw, nh);
        const sx = step.getContext('2d');
        sx.imageSmoothingEnabled = true;
        sx.imageSmoothingQuality = 'high';
        sx.drawImage(cur, 0, 0, cw, ch, 0, 0, nw, nh);
        if (cur !== src && cur instanceof HTMLCanvasElement) cur.width = 0;
        cur = step;
        cw = nw;
        ch = nh;
    }
    const out = createCanvas(tw, th);
    const ox = out.getContext('2d');
    ox.imageSmoothingEnabled = true;
    ox.imageSmoothingQuality = 'high';
    ox.drawImage(cur, 0, 0, cw, ch, 0, 0, out.width, out.height);
    if (cur !== src && cur instanceof HTMLCanvasElement) cur.width = 0;
    return out;
}

async function decodeWithImageElement(blob, isSvg) {
    const url = URL.createObjectURL(blob);
    try {
        const img = new Image();
        img.decoding = 'async';
        img.src = url;
        try {
            await img.decode();
        } catch {
            // Some browsers reject decode() for SVG; fall back to the load event.
            if (!img.complete || !img.naturalWidth) {
                await new Promise((resolve, reject) => {
                    img.onload = resolve;
                    img.onerror = () => reject(new Error('Unsupported or corrupt image'));
                });
            }
        }
        let w = img.naturalWidth;
        let h = img.naturalHeight;
        if (!w || !h) {
            if (!isSvg) throw new Error('Unsupported or corrupt image');
            w = h = 1024;
        }
        if (isSvg) {
            // Rasterise vector art at a useful resolution.
            const s = SVG_RASTER / Math.max(w, h);
            if (s > 1) {
                w = Math.round(w * s);
                h = Math.round(h * s);
            }
        }
        const c = createCanvas(w, h);
        const cx = c.getContext('2d');
        cx.imageSmoothingQuality = 'high';
        cx.drawImage(img, 0, 0, w, h);
        return { source: c, width: w, height: h };
    } finally {
        URL.revokeObjectURL(url);
    }
}

export async function decodeBlob(blob) {
    const isSvg = blob.type === 'image/svg+xml' || /\.svg$/i.test(blob.name || '');
    if (!isSvg && typeof createImageBitmap === 'function') {
        try {
            const bmp = await createImageBitmap(blob);
            if (bmp.width && bmp.height) return { source: bmp, width: bmp.width, height: bmp.height };
        } catch {
            /* fall through to <img> decoding (handles more formats in Safari) */
        }
    }
    return decodeWithImageElement(blob, isSvg);
}

function toBlobURL(canvas) {
    return new Promise((resolve) => {
        if (!canvas.toBlob) {
            resolve(canvas.toDataURL('image/png'));
            return;
        }
        canvas.toBlob((b) => resolve(b ? URL.createObjectURL(b) : canvas.toDataURL('image/png')), 'image/png');
    });
}

/**
 * Decode an image blob into an asset:
 *  - `source`: full resolution (capped to what canvases can handle)
 *  - `proxy`:  ≤ PROXY_MAX px preview used for on-screen rendering
 *  - `thumb`:  small object URL for the layer list
 */
export async function loadAsset(blob, name = 'Image', id = uid('a')) {
    const decoded = await decodeBlob(blob);
    let { source, width, height } = decoded;
    const originalWidth = width;
    const originalHeight = height;

    const cap = limitScale(width, height);
    if (cap < 1) {
        const tw = Math.max(1, Math.floor(width * cap));
        const th = Math.max(1, Math.floor(height * cap));
        const scaled = downscale(source, width, height, tw, th);
        if (source.close) source.close();
        source = scaled;
        width = tw;
        height = th;
    }

    let proxy = source;
    let proxyW = width;
    let proxyH = height;
    const longest = Math.max(width, height);
    if (longest > PROXY_MAX) {
        const s = PROXY_MAX / longest;
        proxyW = Math.max(1, Math.round(width * s));
        proxyH = Math.max(1, Math.round(height * s));
        proxy = downscale(source, width, height, proxyW, proxyH);
    }

    const ts = Math.min(1, THUMB_MAX / Math.max(proxyW, proxyH));
    const thumbCanvas = downscale(proxy, proxyW, proxyH, Math.max(1, Math.round(proxyW * ts)), Math.max(1, Math.round(proxyH * ts)));
    const thumb = await toBlobURL(thumbCanvas);
    thumbCanvas.width = 0;

    return {
        id,
        name,
        blob,
        source,
        width,
        height,
        proxy,
        proxyW,
        proxyH,
        thumb,
        capped: cap < 1,
        originalWidth,
        originalHeight
    };
}

/**
 * Pre-scaled copies of an asset, largest first: [full, proxy, ½ proxy, ¼ …].
 * Smaller levels are created lazily and make filtering/drawing far cheaper
 * when a layer is shown small.
 */
export function assetLevels(asset) {
    if (!asset.levels) {
        asset.levels = [{ img: asset.source, w: asset.width, h: asset.height }];
        if (asset.proxy !== asset.source) asset.levels.push({ img: asset.proxy, w: asset.proxyW, h: asset.proxyH });
        let last = asset.levels[asset.levels.length - 1];
        while (Math.max(last.w, last.h) / 2 >= 256) {
            const w = Math.max(1, Math.round(last.w / 2));
            const h = Math.max(1, Math.round(last.h / 2));
            const level = { img: null, w, h, from: last };
            asset.levels.push(level);
            last = level;
        }
    }
    return asset.levels;
}

/** Smallest level whose long side is at least `px` (the full image if none is). */
export function levelAtLeast(asset, px) {
    const levels = assetLevels(asset);
    for (let i = levels.length - 1; i > 0; i--) {
        if (Math.max(levels[i].w, levels[i].h) >= px) return levels[i];
    }
    return levels[0];
}

export function levelImage(level) {
    if (!level.img) level.img = downscale(levelImage(level.from), level.from.w, level.from.h, level.w, level.h);
    return level.img;
}

/**
 * Alpha channel of a ≥ 512px level, read back once and kept for hit testing
 * (reading single pixels from a GPU canvas on every pointer move is slow).
 * @returns {{w: number, h: number, data: Uint8Array} | null} null when opaque
 */
export function alphaMask(asset) {
    if (asset.mask !== undefined) return asset.mask;
    asset.mask = null;
    const L = levelAtLeast(asset, MASK_MIN);
    const c = createCanvas(L.w, L.h);
    try {
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(levelImage(L), 0, 0);
        const rgba = ctx.getImageData(0, 0, c.width, c.height).data;
        const data = new Uint8Array(c.width * c.height);
        let opaque = true;
        for (let i = 0; i < data.length; i++) {
            data[i] = rgba[i * 4 + 3];
            if (data[i] !== 255) opaque = false;
        }
        if (!opaque) asset.mask = { w: c.width, h: c.height, data };
    } catch {
        /* unreadable pixels: treat the image as opaque */
    } finally {
        c.width = 0;
    }
    return asset.mask;
}

export function releaseAsset(asset) {
    if (!asset) return;
    if (asset.levels) {
        for (const l of asset.levels) if (l.img && l.img !== asset.source && l.img !== asset.proxy) l.img.width = 0;
        asset.levels = null;
    }
    if (asset.thumb && asset.thumb.startsWith('blob:')) URL.revokeObjectURL(asset.thumb);
    if (asset.proxy && asset.proxy !== asset.source && asset.proxy instanceof HTMLCanvasElement) asset.proxy.width = 0;
    if (asset.source && asset.source.close) asset.source.close();
    else if (asset.source instanceof HTMLCanvasElement) asset.source.width = 0;
}

/** Run async `fn` over `items` with bounded concurrency, preserving order. */
export async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const i = next++;
            try {
                results[i] = { ok: true, value: await fn(items[i], i) };
            } catch (error) {
                results[i] = { ok: false, error };
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

export function stripExtension(name) {
    const base = String(name || '').replace(/\.[a-z0-9]{2,5}$/i, '').trim();
    return base || 'Image';
}
