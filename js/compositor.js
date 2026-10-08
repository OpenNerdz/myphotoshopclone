// Shared drawing primitives used by both the on-screen renderer and export.

import { DEG } from './geometry.js';
import { cssFilter, blurRadius, colorSteps, applyColorSteps } from './filters.js';
import { createCanvas } from './images.js';

let filterSupport;

/**
 * Detect real `ctx.filter` support. Safari exposes nothing (or a no-op), so we
 * render a pixel through `invert()` and read it back. `?cpu-filters` forces the
 * fallback path for testing.
 */
export function canvasFilterSupported() {
    if (filterSupport !== undefined) return filterSupport;
    try {
        if (new URLSearchParams(location.search).has('cpu-filters')) return (filterSupport = false);
        const c = createCanvas(1, 1);
        const x = c.getContext('2d', { willReadFrequently: true });
        if (!('filter' in x)) return (filterSupport = false);
        x.filter = 'invert(1)';
        x.fillStyle = '#000';
        x.fillRect(0, 0, 1, 1);
        filterSupport = x.getImageData(0, 0, 1, 1).data[0] > 200;
    } catch {
        filterSupport = false;
    }
    return filterSupport;
}

/** Separable box blur on premultiplied RGBA data (used by the CPU fallback). */
function boxBlur(data, w, h, r) {
    if (r < 1) return;
    const tmp = new Float32Array(data.length);
    const src = new Float32Array(data.length);
    for (let i = 0; i < data.length; i += 4) {
        const a = data[i + 3] / 255;
        src[i] = data[i] * a;
        src[i + 1] = data[i + 1] * a;
        src[i + 2] = data[i + 2] * a;
        src[i + 3] = data[i + 3];
    }
    const pass = (from, to, len, count, stride, step) => {
        const norm = 1 / (2 * r + 1);
        for (let line = 0; line < count; line++) {
            const base = line * stride;
            for (let c = 0; c < 4; c++) {
                let acc = 0;
                for (let k = -r; k <= r; k++) {
                    const idx = Math.min(len - 1, Math.max(0, k));
                    acc += from[base + idx * step + c];
                }
                for (let i = 0; i < len; i++) {
                    to[base + i * step + c] = acc * norm;
                    const add = Math.min(len - 1, i + r + 1);
                    const sub = Math.max(0, i - r);
                    acc += from[base + add * step + c] - from[base + sub * step + c];
                }
            }
        }
    };
    for (let n = 0; n < 2; n++) {
        pass(src, tmp, w, h, w * 4, 4); // horizontal
        pass(tmp, src, h, w, 4, w * 4); // vertical
    }
    for (let i = 0; i < data.length; i += 4) {
        const a = src[i + 3];
        data[i + 3] = a;
        if (a > 0) {
            const inv = 255 / a;
            data[i] = src[i] * inv;
            data[i + 1] = src[i + 1] * inv;
            data[i + 2] = src[i + 2] * inv;
        }
    }
}

/** Approximate Gaussian blur: blur a downscaled copy, then scale back up. */
function blurCPU(canvas, radius) {
    const W = canvas.width;
    const H = canvas.height;
    const factor = Math.max(1, radius / 3);
    const sw = Math.max(1, Math.round(W / factor));
    const sh = Math.max(1, Math.round(H / factor));
    const small = createCanvas(sw, sh);
    const sx = small.getContext('2d', { willReadFrequently: true });
    sx.imageSmoothingEnabled = true;
    sx.imageSmoothingQuality = 'high';
    sx.drawImage(canvas, 0, 0, sw, sh);
    const img = sx.getImageData(0, 0, sw, sh);
    boxBlur(img.data, sw, sh, Math.max(1, Math.round(radius / factor / 1.5)));
    sx.putImageData(img, 0, 0);
    const ctx = canvas.getContext('2d');
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(small, 0, 0, W, H);
    ctx.restore();
    small.width = 0;
}

/**
 * Render `src` (cw × ch) with adjustments applied into a canvas, padded so blur
 * can bleed past the edges. `region` limits the work to part of the image (in
 * src pixels); blur is still sized relative to the whole image. Pass `reuse` to
 * recycle a same-sized canvas.
 * @returns {{canvas: HTMLCanvasElement, pad: number}}
 */
export function buildFiltered(src, cw, ch, filters, reuse = null, region = null) {
    const r = region || { x: 0, y: 0, w: cw, h: ch };
    const blurPx = blurRadius(filters, Math.max(cw, ch));
    const pad = blurPx > 0 ? Math.ceil(blurPx * 2) : 0;
    const W = Math.round(r.w + pad * 2);
    const H = Math.round(r.h + pad * 2);
    const gpu = canvasFilterSupported();
    const canvas = reuse && reuse.width === W && reuse.height === H ? reuse : createCanvas(W, H);
    const ctx = canvas.getContext('2d', gpu ? undefined : { willReadFrequently: true });
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    // Include real neighbouring pixels in the padding so tile edges blur correctly,
    // clamping the source rect to the image (Safari mishandles out-of-bounds rects).
    const sx0 = Math.max(0, r.x - pad);
    const sy0 = Math.max(0, r.y - pad);
    const sx1 = Math.min(cw, r.x + r.w + pad);
    const sy1 = Math.min(ch, r.y + r.h + pad);
    const draw = () => ctx.drawImage(src, sx0, sy0, sx1 - sx0, sy1 - sy0, sx0 - (r.x - pad), sy0 - (r.y - pad), sx1 - sx0, sy1 - sy0);

    if (gpu) {
        ctx.filter = cssFilter(filters, blurPx);
        draw();
        ctx.filter = 'none';
        return { canvas, pad };
    }

    draw();
    const steps = colorSteps(filters);
    if (steps.length) {
        const img = ctx.getImageData(0, 0, W, H);
        applyColorSteps(img.data, steps);
        ctx.putImageData(img, 0, 0);
    }
    if (blurPx > 0) blurCPU(canvas, blurPx);
    return { canvas, pad };
}

/**
 * Draw a layer into `ctx`, whose current transform maps document px.
 * `img` holds `region` (default: all of the cw × ch content) plus `pad` px of
 * padding on each side.
 */
export function drawLayer(ctx, layer, img, cw, ch, pad = 0, alpha = 1, region = null) {
    const W = layer.width * layer.scaleX;
    const H = layer.height * layer.scaleY;
    const r = region || { x: 0, y: 0, w: cw, h: ch };
    ctx.save();
    ctx.globalAlpha = layer.opacity * alpha;
    ctx.globalCompositeOperation = layer.blend || 'source-over';
    ctx.translate(layer.x, layer.y);
    if (layer.rotation) ctx.rotate(layer.rotation * DEG);
    if (layer.flipH || layer.flipV) ctx.scale(layer.flipH ? -1 : 1, layer.flipV ? -1 : 1);
    const kx = W / cw;
    const ky = H / ch;
    ctx.drawImage(img, -W / 2 + (r.x - pad) * kx, -H / 2 + (r.y - pad) * ky, (r.w + 2 * pad) * kx, (r.h + 2 * pad) * ky);
    ctx.restore();
}
