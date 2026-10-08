// On-screen canvas renderer. Draws the document into the viewport using the
// current view transform.
//
// Performance strategy:
//  - Each layer is drawn from the smallest pre-scaled level (mipmap) that still
//    covers its on-screen size, so filters run on as few pixels as possible.
//  - Filtered results are cached per layer; pan/zoom/move just redraw the cache.
//  - Zoomed in past the 2048px preview, only the visible part of the full
//    resolution image is filtered (a single "tile").
//  - While the view is moving or a control is being dragged, the existing cache
//    is reused (or a cheaper level is built) and quality is upgraded ~160ms
//    after things settle.

import { isIdentity, filterKey } from './filters.js';
import { buildFiltered, drawLayer } from './compositor.js';
import { assetLevels, levelImage, createCanvas } from './images.js';
import { toSourcePixel, intersectRect, containsRect, layerExtent } from './geometry.js';

const CHECKER_A = '#3b404b';
const CHECKER_B = '#2f333c';
const GUIDE = '#ff3d9a';
const SETTLE_MS = 160;
const MAX_TILE_AREA = 16_000_000;

export class Renderer {
    constructor(canvas, app) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.app = app;
        this.dpr = 1;
        this.cssW = 0;
        this.cssH = 0;
        this.caches = new Map();
        this.fallbacks = new Map();
        this.raf = 0;
        this.pattern = null;
        this.patternDpr = 0;
        this.viewChangedAt = 0;
        this.settleTimer = 0;
        this.degraded = false;
        app.on('view', () => {
            this.viewChangedAt = performance.now();
        });
    }

    resize(cssW, cssH) {
        const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
        const w = Math.max(1, Math.round(cssW * dpr));
        const h = Math.max(1, Math.round(cssH * dpr));
        this.cssW = cssW;
        this.cssH = cssH;
        if (this.canvas.width !== w || this.canvas.height !== h || this.dpr !== dpr) {
            this.dpr = dpr;
            this.canvas.width = w;
            this.canvas.height = h;
        }
        this.drawNow();
    }

    request() {
        if (this.raf) return;
        this.raf = requestAnimationFrame(() => {
            this.raf = 0;
            this.drawNow();
        });
    }

    drop(id) {
        for (const map of [this.caches, this.fallbacks]) {
            const c = map.get(id);
            if (c) c.img.width = 0;
            map.delete(id);
        }
    }

    prune(validIds) {
        const ids = new Set([...this.caches.keys(), ...this.fallbacks.keys()]);
        for (const id of ids) if (!validIds.has(id)) this.drop(id);
    }

    checker() {
        if (this.pattern && this.patternDpr === this.dpr) return this.pattern;
        const cell = Math.round(8 * this.dpr);
        const c = createCanvas(cell * 2, cell * 2);
        const x = c.getContext('2d');
        x.fillStyle = CHECKER_A;
        x.fillRect(0, 0, cell * 2, cell * 2);
        x.fillStyle = CHECKER_B;
        x.fillRect(0, 0, cell, cell);
        x.fillRect(cell, cell, cell, cell);
        this.pattern = this.ctx.createPattern(c, 'repeat');
        this.patternDpr = this.dpr;
        return this.pattern;
    }

    /** Index of the smallest level that covers `needPx`; 0 (full res) only when clearly needed. */
    levelFor(levels, needPx) {
        for (let i = levels.length - 1; i >= 1; i--) {
            if (Math.max(levels[i].w, levels[i].h) >= needPx * 0.95) return i;
        }
        if (levels.length > 1 && needPx <= Math.max(levels[1].w, levels[1].h) * 1.5) return 1;
        return 0;
    }

    /** Part of the layer (in full-res source px) currently visible on screen. */
    visibleSourceRect(layer) {
        const app = this.app;
        const tl = app.screenToDoc({ x: 0, y: 0 });
        const br = app.screenToDoc({ x: app.vp.w, y: app.vp.h });
        const vis = intersectRect({ x: tl.x, y: tl.y, w: br.x - tl.x, h: br.y - tl.y }, { x: 0, y: 0, w: app.doc.width, h: app.doc.height });
        if (!vis) return null;
        const pts = [
            [vis.x, vis.y],
            [vis.x + vis.w, vis.y],
            [vis.x + vis.w, vis.y + vis.h],
            [vis.x, vis.y + vis.h]
        ].map(([x, y]) => toSourcePixel(layer, x, y));
        const xs = pts.map((p) => p.x);
        const ys = pts.map((p) => p.y);
        return intersectRect(
            { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) },
            { x: 0, y: 0, w: layer.width, h: layer.height }
        );
    }

    /**
     * Return what to draw for a layer: { img, cw, ch, pad, region } where cw×ch
     * is the content size of the chosen level and `region` the part of it `img` holds.
     */
    drawable(layer, asset, screenScale) {
        const app = this.app;
        const levels = assetLevels(asset);
        let li = this.levelFor(levels, layerExtent(layer) * screenScale);

        if (isIdentity(layer.filters)) {
            if (this.caches.has(layer.id) || this.fallbacks.has(layer.id)) this.drop(layer.id); // free memory
            const L = levels[li];
            return { img: levelImage(L), cw: L.w, ch: L.h, pad: 0, region: null };
        }

        const fk = filterKey(layer.filters);
        const cached = this.caches.get(layer.id);
        const settling = app.interacting || performance.now() - this.viewChangedAt < SETTLE_MS;

        // Moving things around: keep showing what we have, upgrade afterwards.
        if (settling && cached && cached.fk === fk && cached.assetId === asset.id) {
            if (cached.li !== li || li === 0) this.degraded = true;
            // A full-res tile that no longer covers the view would leave holes.
            if (cached.region && !this.tileCovers(cached, layer)) return this.preview(layer, asset, fk);
            return cached;
        }
        // Dragging an adjustment slider: build a cheaper level for snappy feedback.
        if (app.interacting) {
            li = Math.min(levels.length - 1, Math.max(li, 1) + 1);
            this.degraded = true;
        } else if (li === 0 && settling) {
            li = Math.min(1, levels.length - 1);
            this.degraded = true;
        }

        if (li === 0 && levels.length > 1) {
            const tile = this.buildTile(layer, asset, fk, cached);
            if (tile) return tile;
            li = 1;
        }

        if (cached && cached.fk === fk && cached.li === li && !cached.region && cached.assetId === asset.id) return cached;
        const L = levels[li];
        const entry = this.filtered(layer, asset, fk, li, levelImage(L), L.w, L.h, cached);
        this.caches.set(layer.id, entry);
        const fb = this.fallbacks.get(layer.id);
        if (fb) {
            fb.img.width = 0;
            this.fallbacks.delete(layer.id);
        }
        return entry;
    }

    /** Filter `src` (cw × ch, optionally only `region`), recycling `prev`'s canvas. */
    filtered(layer, asset, fk, li, src, cw, ch, prev, region = null) {
        const built = buildFiltered(src, cw, ch, layer.filters, prev ? prev.img : null, region);
        if (prev && prev.img !== built.canvas) prev.img.width = 0;
        return { fk, li, assetId: asset.id, img: built.canvas, cw, ch, pad: built.pad, region };
    }

    tileCovers(tile, layer) {
        const vis = this.visibleSourceRect(layer);
        return !vis || containsRect(tile.region, vis);
    }

    /** Filtered 2048px preview, kept alongside a tile to cover fast pans. */
    preview(layer, asset, fk) {
        const levels = assetLevels(asset);
        const L = levels[Math.min(1, levels.length - 1)];
        let p = this.fallbacks.get(layer.id);
        if (!p || p.fk !== fk || p.assetId !== asset.id) {
            p = this.filtered(layer, asset, fk, 1, levelImage(L), L.w, L.h, p);
            this.fallbacks.set(layer.id, p);
        }
        return p;
    }

    /** Filter only the visible part of the full-resolution image. */
    buildTile(layer, asset, fk, cached) {
        const vis = this.visibleSourceRect(layer);
        if (!vis) {
            return { img: asset.proxy, cw: asset.proxyW, ch: asset.proxyH, pad: 0, region: { x: 0, y: 0, w: 0, h: 0 }, empty: true };
        }
        if (cached && cached.fk === fk && cached.li === 0 && cached.assetId === asset.id && cached.region && containsRect(cached.region, vis)) {
            return cached;
        }
        // Grow the tile so small pans don't force a rebuild, snapped to a coarse grid.
        const mx = vis.w * 0.3;
        const my = vis.h * 0.3;
        const G = 128;
        const x0 = Math.max(0, Math.floor((vis.x - mx) / G) * G);
        const y0 = Math.max(0, Math.floor((vis.y - my) / G) * G);
        const x1 = Math.min(asset.width, Math.ceil((vis.x + vis.w + mx) / G) * G);
        const y1 = Math.min(asset.height, Math.ceil((vis.y + vis.h + my) / G) * G);
        const region = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
        if (region.w * region.h > MAX_TILE_AREA) return null;
        const entry = this.filtered(layer, asset, fk, 0, asset.source, asset.width, asset.height, cached, region);
        this.caches.set(layer.id, entry);
        return entry;
    }

    drawNow() {
        const { ctx, canvas, dpr, app } = this;
        const { doc, layers } = app.state;
        const v = app.view;
        this.degraded = false;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (!layers.length) return;

        const s = v.scale * dpr;
        const ox = v.x * dpr;
        const oy = v.y * dpr;
        const dw = doc.width * s;
        const dh = doc.height * s;
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = app.interacting ? 'medium' : 'high';

        const draw = (layer, alpha = 1, override = null) => {
            const asset = app.assets.get(layer.assetId);
            if (!asset) return;
            const d = this.drawable(layer, asset, s);
            if (d.empty) return;
            drawLayer(ctx, override || layer, d.img, d.cw, d.ch, d.pad, alpha, d.region);
        };

        // 1. Composite layers (bottom → top) clipped to the document. Blend
        //    modes only see other layers, never the checkerboard.
        ctx.save();
        ctx.beginPath();
        ctx.rect(ox, oy, dw, dh);
        ctx.clip();
        ctx.setTransform(s, 0, 0, s, ox, oy);
        if (doc.background) {
            ctx.fillStyle = doc.background;
            ctx.fillRect(0, 0, doc.width, doc.height);
        }
        for (let i = layers.length - 1; i >= 0; i--) {
            const layer = layers[i];
            if (layer.visible && layer.opacity > 0) draw(layer);
        }
        ctx.restore();

        // 2. Transparency checkerboard behind the composite.
        if (!doc.background) {
            ctx.save();
            ctx.globalCompositeOperation = 'destination-over';
            const pattern = this.checker();
            if (pattern.setTransform && typeof DOMMatrix === 'function') {
                pattern.setTransform(new DOMMatrix().translate(Math.round(ox), Math.round(oy)));
            }
            ctx.fillStyle = pattern;
            ctx.fillRect(ox, oy, dw, dh);
            ctx.restore();
        }

        // 3. While transforming, ghost the active layer outside the canvas bounds.
        const ghost = app.ghostId && layers.find((l) => l.id === app.ghostId);
        if (ghost && ghost.visible) {
            ctx.save();
            ctx.beginPath();
            ctx.rect(0, 0, canvas.width, canvas.height);
            ctx.rect(ox, oy, dw, dh);
            ctx.clip('evenodd');
            ctx.setTransform(s, 0, 0, s, ox, oy);
            draw(ghost, 0.35, { ...ghost, blend: 'source-over' });
            ctx.restore();
        }

        // 4. Smart guides.
        const g = app.guides;
        if (g && (g.x != null || g.y != null)) {
            ctx.save();
            ctx.strokeStyle = GUIDE;
            ctx.lineWidth = Math.max(1, Math.round(dpr));
            ctx.beginPath();
            if (g.x != null) {
                const x = Math.round(ox + g.x * s) + 0.5;
                ctx.moveTo(x, 0);
                ctx.lineTo(x, canvas.height);
            }
            if (g.y != null) {
                const y = Math.round(oy + g.y * s) + 0.5;
                ctx.moveTo(0, y);
                ctx.lineTo(canvas.width, y);
            }
            ctx.stroke();
            ctx.restore();
        }

        // Upgrade to full quality once interaction settles.
        clearTimeout(this.settleTimer);
        if (this.degraded) this.settleTimer = setTimeout(() => this.request(), SETTLE_MS + 10);
    }
}
