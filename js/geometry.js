// Pure geometry helpers. Everything here works in document pixels and has no
// DOM dependencies, so it can be unit tested under Node.

export const DEG = Math.PI / 180;

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export const roundTo = (v, places = 0) => {
    const m = 10 ** places;
    return Math.round(v * m) / m;
};

/** Normalise an angle in degrees to the range (-180, 180]. */
export function normalizeAngle(deg) {
    let d = ((((deg + 180) % 360) + 360) % 360) - 180;
    if (d === -180) d = 180;
    return Object.is(d, -0) ? 0 : d;
}

/** Displayed size of a layer (document px) before rotation. */
export function layerSize(layer) {
    return {
        w: layer.width * layer.scaleX,
        h: layer.height * layer.scaleY
    };
}

/** The four corners of a layer in document space (clockwise from top-left). */
export function layerCorners(layer) {
    const { w, h } = layerSize(layer);
    const r = (layer.rotation || 0) * DEG;
    const c = Math.cos(r);
    const s = Math.sin(r);
    const hw = w / 2;
    const hh = h / 2;
    return [
        [-hw, -hh],
        [hw, -hh],
        [hw, hh],
        [-hw, hh]
    ].map(([x, y]) => ({ x: layer.x + x * c - y * s, y: layer.y + x * s + y * c }));
}

/** Axis-aligned bounding box of a (possibly rotated) layer. */
export function layerBounds(layer) {
    const pts = layerCorners(layer);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of pts) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Convert a document point into a layer's local (unrotated, centred) frame. */
export function toLocal(layer, px, py) {
    const r = -(layer.rotation || 0) * DEG;
    const c = Math.cos(r);
    const s = Math.sin(r);
    const dx = px - layer.x;
    const dy = py - layer.y;
    return { x: dx * c - dy * s, y: dx * s + dy * c };
}

/** True when a document point lies inside the layer's transformed rectangle. */
export function hitLayer(layer, px, py, tolerance = 0) {
    const { w, h } = layerSize(layer);
    const p = toLocal(layer, px, py);
    return Math.abs(p.x) <= Math.abs(w) / 2 + tolerance && Math.abs(p.y) <= Math.abs(h) / 2 + tolerance;
}

/** Map a document point to source-image pixel coordinates (accounts for flips). */
export function toSourcePixel(layer, px, py) {
    const p = toLocal(layer, px, py);
    let u = p.x / layer.scaleX;
    let v = p.y / layer.scaleY;
    if (layer.flipH) u = -u;
    if (layer.flipV) v = -v;
    return { x: u + layer.width / 2, y: v + layer.height / 2 };
}

export function unionRect(rects) {
    let out = null;
    for (const r of rects) {
        if (!r) continue;
        if (!out) {
            out = { ...r };
            continue;
        }
        const x = Math.min(out.x, r.x);
        const y = Math.min(out.y, r.y);
        out.w = Math.max(out.x + out.w, r.x + r.w) - x;
        out.h = Math.max(out.y + out.h, r.y + r.h) - y;
        out.x = x;
        out.y = y;
    }
    return out;
}

export function intersectRect(a, b) {
    const x = Math.max(a.x, b.x);
    const y = Math.max(a.y, b.y);
    const r = Math.min(a.x + a.w, b.x + b.w);
    const btm = Math.min(a.y + a.h, b.y + b.h);
    if (r <= x || btm <= y) return null;
    return { x, y, w: r - x, h: btm - y };
}

/** Snap a rect to whole pixels while keeping it at least 1x1. */
export function roundRect(r) {
    const x = Math.round(r.x);
    const y = Math.round(r.y);
    return {
        x,
        y,
        w: Math.max(1, Math.round(r.x + r.w) - x),
        h: Math.max(1, Math.round(r.y + r.h) - y)
    };
}

export const containScale = (w, h, boxW, boxH) => Math.min(boxW / w, boxH / h);
export const coverScale = (w, h, boxW, boxH) => Math.max(boxW / w, boxH / h);

/** Largest rect of the given aspect ratio centred inside `box`. */
export function aspectRectWithin(box, aspect) {
    let w = box.w;
    let h = w / aspect;
    if (h > box.h) {
        h = box.h;
        w = h * aspect;
    }
    return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h };
}

const handleDir = (handle) => ({
    hx: handle.includes('e') ? 1 : handle.includes('w') ? -1 : 0,
    hy: handle.includes('s') ? 1 : handle.includes('n') ? -1 : 0
});

/**
 * Scale a layer by dragging one of its eight handles.
 *
 * @param start   layer state when the gesture began
 * @param handle  'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw'
 * @param p       pointer position in document space
 * @param opts    keepAspect: preserve the aspect ratio
 *                fromCenter: scale around the centre instead of the opposite handle
 *                minSize:    smallest allowed displayed size (document px)
 * @returns {{x:number,y:number,scaleX:number,scaleY:number}}
 */
export function scaleFromHandle(start, handle, p, { keepAspect = false, fromCenter = false, minSize = 4 } = {}) {
    const { hx, hy } = handleDir(handle);
    const { w: w0, h: h0 } = layerSize(start);
    const r = (start.rotation || 0) * DEG;
    const ux = Math.cos(r);
    const uy = Math.sin(r);
    const vx = -uy;
    const vy = ux;

    // The anchor is the point that stays fixed while scaling.
    const ax = fromCenter ? start.x : start.x - (ux * hx * w0) / 2 - (vx * hy * h0) / 2;
    const ay = fromCenter ? start.y : start.y - (uy * hx * w0) / 2 - (vy * hy * h0) / 2;
    const dx = p.x - ax;
    const dy = p.y - ay;
    const lx = dx * ux + dy * uy;
    const ly = dx * vx + dy * vy;
    const k = fromCenter ? 2 : 1;

    let w = w0;
    let h = h0;
    if (hx !== 0 && hy !== 0) {
        if (keepAspect) {
            // Project the pointer onto the anchor→handle diagonal.
            const Dx = (hx * w0) / k;
            const Dy = (hy * h0) / k;
            const t = (lx * Dx + ly * Dy) / (Dx * Dx + Dy * Dy);
            const minT = minSize / Math.min(w0, h0);
            const tt = Math.max(minT, t);
            w = w0 * tt;
            h = h0 * tt;
        } else {
            w = Math.max(minSize, hx * lx * k);
            h = Math.max(minSize, hy * ly * k);
        }
    } else if (hx !== 0) {
        w = Math.max(minSize, hx * lx * k);
        if (keepAspect) h = (h0 * w) / w0;
    } else if (hy !== 0) {
        h = Math.max(minSize, hy * ly * k);
        if (keepAspect) w = (w0 * h) / h0;
    }

    let x = start.x;
    let y = start.y;
    if (!fromCenter) {
        x = ax + (ux * hx * w) / 2 + (vx * hy * h) / 2;
        y = ay + (uy * hx * w) / 2 + (vy * hy * h) / 2;
    }
    return { x, y, scaleX: w / start.width, scaleY: h / start.height };
}

/** Rotation (degrees) after dragging the rotate handle from `p0` to `p`. */
export function rotateFromPointer(start, p0, p, snapStep = 0) {
    const a0 = Math.atan2(p0.y - start.y, p0.x - start.x);
    const a1 = Math.atan2(p.y - start.y, p.x - start.x);
    let deg = normalizeAngle((start.rotation || 0) + (a1 - a0) / DEG);
    if (snapStep > 0) {
        deg = Math.round(deg / snapStep) * snapStep;
    } else {
        // Gentle magnetism towards right angles.
        const nearest = Math.round(deg / 90) * 90;
        if (Math.abs(deg - nearest) < 2) deg = nearest;
    }
    return normalizeAngle(deg);
}

/**
 * Snap a moving rect's edges/centre to target lines.
 * Returns the correction to apply plus the guide line positions that matched.
 */
export function snapRect(rect, targetsX, targetsY, threshold) {
    const pick = (values, targets) => {
        let best = null;
        for (const v of values) {
            for (const t of targets) {
                const d = t - v;
                if (Math.abs(d) <= threshold && (!best || Math.abs(d) < Math.abs(best.d))) {
                    best = { d, at: t };
                }
            }
        }
        return best;
    };
    // Centre first so it wins ties (e.g. a full-canvas layer matches all three).
    const bx = pick([rect.x + rect.w / 2, rect.x, rect.x + rect.w], targetsX);
    const by = pick([rect.y + rect.h / 2, rect.y, rect.y + rect.h], targetsY);
    return {
        dx: bx ? bx.d : 0,
        dy: by ? by.d : 0,
        guideX: bx ? bx.at : null,
        guideY: by ? by.at : null
    };
}

/**
 * Move or resize a rectangle (e.g. a crop selection) by a handle.
 *
 * @param start  {x,y,w,h} at gesture start
 * @param handle 'move' or a compass handle
 * @param dx,dy  pointer delta in the rect's coordinate space
 * @param opts   aspect: width/height ratio to enforce (or null)
 *               bounds: rect the result must stay within (or null)
 *               min:    minimum width/height
 */
export function dragRect(start, handle, dx, dy, { aspect = null, bounds = null, min = 8 } = {}) {
    if (handle === 'move') {
        let x = start.x + dx;
        let y = start.y + dy;
        if (bounds) {
            x = clamp(x, bounds.x, bounds.x + bounds.w - start.w);
            y = clamp(y, bounds.y, bounds.y + bounds.h - start.h);
        }
        return { x, y, w: start.w, h: start.h };
    }

    const { hx, hy } = handleDir(handle);
    let left = start.x;
    let top = start.y;
    let right = start.x + start.w;
    let bottom = start.y + start.h;

    if (hx < 0) left = Math.min(left + dx, right - min);
    if (hx > 0) right = Math.max(right + dx, left + min);
    if (hy < 0) top = Math.min(top + dy, bottom - min);
    if (hy > 0) bottom = Math.max(bottom + dy, top + min);

    if (bounds) {
        if (hx < 0) left = Math.max(left, bounds.x);
        if (hx > 0) right = Math.min(right, bounds.x + bounds.w);
        if (hy < 0) top = Math.max(top, bounds.y);
        if (hy > 0) bottom = Math.min(bottom, bounds.y + bounds.h);
    }

    let w = right - left;
    let h = bottom - top;
    if (!aspect) return { x: left, y: top, w, h };

    if (hx !== 0 && hy !== 0) {
        if (w / h > aspect) w = h * aspect;
        else h = w / aspect;
    } else if (hx !== 0) {
        h = w / aspect;
    } else {
        w = h * aspect;
    }

    const cx = start.x + start.w / 2;
    const cy = start.y + start.h / 2;
    if (bounds) {
        const bR = bounds.x + bounds.w;
        const bB = bounds.y + bounds.h;
        const availW = hx > 0 ? bR - left : hx < 0 ? right - bounds.x : 2 * Math.min(cx - bounds.x, bR - cx);
        const availH = hy > 0 ? bB - top : hy < 0 ? bottom - bounds.y : 2 * Math.min(cy - bounds.y, bB - cy);
        const s = Math.min(1, availW / w, availH / h);
        w *= s;
        h *= s;
    }

    if (hx < 0) left = right - w;
    else if (hx === 0) left = cx - w / 2;
    if (hy < 0) top = bottom - h;
    else if (hy === 0) top = cy - h / 2;
    return { x: left, y: top, w, h };
}
