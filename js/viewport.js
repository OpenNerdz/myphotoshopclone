// Canvas interaction: selection, move/scale/rotate handles, smart guides,
// panning, pinch-zoom, wheel zoom and double-tap zoom.

import { $, isTypingTarget } from './dom.js';
import { layerSize, layerBounds, hitLayer, toSourcePixel, scaleFromHandle, rotateFromPointer, snapRect, clamp } from './geometry.js';

const HANDLE_ANGLES = { e: 0, se: 45, s: 90, sw: 135, w: 180, nw: 225, n: 270, ne: 315 };
const RESIZE_CURSORS = ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'];
const LABELS = { move: 'Move layer', scale: 'Scale layer', rotate: 'Rotate layer' };
const UI_SELECTOR = '.zoom-bar, .crop-bar, .empty-state, .crop-box, .drop-indicator';

const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

export class ViewportController {
    constructor(app) {
        this.app = app;
        this.el = $('#viewport');
        this.box = $('#transformBox');
        this.hoverBox = $('#hoverBox');
        this.hud = $('#hud');
        this.pointers = new Map();
        this.gesture = null;
        this.pinch = null;
        this.spaceDown = false;
        this.hoverId = null;
        this.hoverRAF = 0;
        this.hoverEvent = null;
        this.lastTap = null;
        this.lastRotation = null;
        this.rect = this.el.getBoundingClientRect();
        this.hitCtx = null;

        this.bind();
        const update = () => this.updateBoxes();
        app.on('selection', update);
        app.on('structure', update);
        app.on('view', update);
        app.on('tool', () => {
            this.hideHover();
            update();
        });
        app.on('layer', (l) => {
            if (l.id === app.state.selectedId || l.id === this.hoverId) update();
        });
    }

    bind() {
        const el = this.el;
        new ResizeObserver((entries) => {
            const r = entries[entries.length - 1].contentRect;
            this.rect = el.getBoundingClientRect();
            this.app.setViewportSize(r.width, r.height);
        }).observe(el);
        // DPR changes (moving between monitors, browser zoom) don't trigger ResizeObserver.
        window.addEventListener('resize', () => {
            this.rect = el.getBoundingClientRect();
            this.app.setViewportSize(this.rect.width, this.rect.height);
        });

        el.addEventListener('pointerdown', (e) => this.onDown(e));
        el.addEventListener('pointermove', (e) => this.onMove(e));
        el.addEventListener('pointerup', (e) => this.onUp(e));
        el.addEventListener('pointercancel', (e) => this.onUp(e, true));
        el.addEventListener('lostpointercapture', (e) => {
            if (this.pointers.has(e.pointerId)) this.onUp(e, true);
        });
        el.addEventListener('pointerleave', () => this.hideHover());
        el.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
        el.addEventListener('contextmenu', (e) => {
            if (!e.target.closest(UI_SELECTOR)) e.preventDefault();
        });
        // Stop Safari's page-level pinch zoom from hijacking canvas gestures.
        el.addEventListener('gesturestart', (e) => e.preventDefault());

        window.addEventListener('keydown', (e) => {
            if (e.code !== 'Space' || e.repeat || isTypingTarget(e.target)) return;
            if (e.target.closest && e.target.closest('button, a, [role="menuitem"], input, select')) return;
            if (document.querySelector('dialog[open]')) return;
            e.preventDefault();
            this.spaceDown = true;
            el.classList.add('space-pan');
        });
        window.addEventListener('keyup', (e) => {
            if (e.code !== 'Space') return;
            this.spaceDown = false;
            el.classList.remove('space-pan');
        });
        window.addEventListener('blur', () => {
            this.spaceDown = false;
            el.classList.remove('space-pan');
        });
    }

    local(e) {
        return { x: e.clientX - this.rect.left, y: e.clientY - this.rect.top };
    }

    // ------------------------------------------------------------ pointers

    onDown(e) {
        const app = this.app;
        if (e.target.closest(UI_SELECTOR)) return;
        if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 1) return;
        if (!app.layers.length) return;

        app.stopViewAnimation();
        this.rect = this.el.getBoundingClientRect();
        const p = this.local(e);
        this.pointers.set(e.pointerId, p);
        try {
            this.el.setPointerCapture(e.pointerId);
        } catch {
            /* capture can fail for synthetic events */
        }
        if (isTypingTarget(document.activeElement)) document.activeElement.blur();

        if (this.pointers.size === 2) {
            this.abortGesture();
            this.startPinch();
            e.preventDefault();
            return;
        }
        if (this.pointers.size > 2) return;
        e.preventDefault();
        this.hideHover();

        const handle = e.target.closest('[data-handle]');
        const sel = app.selected;
        if (handle && sel && !sel.locked && app.tool === 'move') {
            this.startTransform(handle.dataset.handle, sel, p, e.pointerId);
            return;
        }
        if (e.button === 1 || app.tool !== 'move' || this.spaceDown) {
            this.startPan(p, e.pointerId, { tap: true });
            return;
        }
        const hit = this.hitTest(p);
        if (hit) {
            app.select(hit.id);
            this.gesture = { type: 'move', id: hit.id, pointerId: e.pointerId, touch: e.pointerType === 'touch', p0: p, start: { x: hit.x, y: hit.y }, moved: false, targets: null };
        } else {
            this.startPan(p, e.pointerId, { tap: true, deselect: true });
        }
    }

    onMove(e) {
        if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, this.local(e));
        if (this.pinch) {
            if (this.pointers.size >= 2) this.updatePinch();
            return;
        }
        const g = this.gesture;
        if (g && e.pointerId === g.pointerId) {
            this.updateGesture(e);
            return;
        }
        if (!g && e.pointerType === 'mouse' && !this.pointers.size) this.queueHover(e);
    }

    onUp(e, cancelled = false) {
        if (!this.pointers.has(e.pointerId)) return;
        this.pointers.delete(e.pointerId);
        try {
            this.el.releasePointerCapture(e.pointerId);
        } catch {
            /* already released */
        }
        if (this.pinch) {
            if (this.pointers.size < 2) {
                this.pinch = null;
                this.app.interacting = false;
                this.app.requestRender();
                this.updateBoxes();
            }
            return;
        }
        const g = this.gesture;
        if (g && g.pointerId === e.pointerId) this.finishGesture(cancelled, this.local(e));
    }

    // ------------------------------------------------------------ gestures

    startPan(p, pointerId, { tap = false, deselect = false } = {}) {
        this.gesture = { type: 'pan', pointerId, p0: p, last: p, moved: false, tap, deselect };
    }

    startTransform(handle, layer, p, pointerId) {
        const app = this.app;
        this.gesture = {
            type: handle === 'rotate' ? 'rotate' : 'scale',
            handle,
            id: layer.id,
            pointerId,
            p0: p,
            p0doc: app.screenToDoc(p),
            start: { ...layer },
            moved: false
        };
        app.interacting = true;
        app.ghostId = layer.id;
        this.el.classList.add('is-transforming');
    }

    snapTargets(id) {
        const d = this.app.doc;
        const tx = [0, d.width / 2, d.width];
        const ty = [0, d.height / 2, d.height];
        for (const l of this.app.layers) {
            if (l.id === id || !l.visible) continue;
            const b = layerBounds(l);
            tx.push(b.x, b.x + b.w / 2, b.x + b.w);
            ty.push(b.y, b.y + b.h / 2, b.y + b.h);
        }
        return { tx, ty };
    }

    updateGesture(e) {
        const app = this.app;
        const g = this.gesture;
        const p = this.local(e);

        if (g.type === 'pan') {
            if (!g.moved && dist(p, g.p0) > 4) {
                g.moved = true;
                this.el.classList.add('is-panning');
            }
            if (g.moved) app.panBy(p.x - g.last.x, p.y - g.last.y);
            g.last = p;
            return;
        }

        if (g.type === 'move') {
            if (!g.moved) {
                if (dist(p, g.p0) < (e.pointerType === 'touch' ? 6 : 3)) return;
                g.moved = true;
                g.targets = this.snapTargets(g.id);
                app.interacting = true;
                app.ghostId = g.id;
                this.el.classList.add('is-moving');
            }
            let dx = (p.x - g.p0.x) / app.view.scale;
            let dy = (p.y - g.p0.y) / app.view.scale;
            if (e.shiftKey) {
                if (Math.abs(dx) > Math.abs(dy)) dy = 0;
                else dx = 0;
            }
            let x = g.start.x + dx;
            let y = g.start.y + dy;
            app.guides = null;
            const layer = app.layerById(g.id);
            if (!layer) return;
            if (!(e.ctrlKey || e.metaKey)) {
                const s = snapRect(layerBounds({ ...layer, x, y }), g.targets.tx, g.targets.ty, 6 / app.view.scale);
                if (!(e.shiftKey && dx === 0)) x += s.dx;
                if (!(e.shiftKey && dy === 0)) y += s.dy;
                if (s.guideX != null || s.guideY != null) app.guides = { x: s.guideX, y: s.guideY };
            }
            app.updateLayer(g.id, { x, y });
            return;
        }

        const d = app.screenToDoc(p);
        g.moved = true;
        if (g.type === 'scale') {
            const corner = g.handle.length === 2;
            const r = scaleFromHandle(g.start, g.handle, d, {
                keepAspect: corner ? !e.shiftKey : e.shiftKey,
                fromCenter: e.altKey,
                minSize: 4 / app.view.scale
            });
            app.updateLayer(g.id, r);
            const { w, h } = layerSize({ ...g.start, ...r });
            this.showHud(`${Math.round(w)} × ${Math.round(h)}`, p);
        } else {
            const rotation = rotateFromPointer(g.start, g.p0doc, d, e.shiftKey ? 15 : 0);
            app.updateLayer(g.id, { rotation });
            this.showHud(`${Math.round(rotation)}°`, p);
        }
    }

    finishGesture(cancelled, p) {
        const app = this.app;
        const g = this.gesture;
        this.gesture = null;
        this.el.classList.remove('is-panning', 'is-moving', 'is-transforming');
        app.interacting = false;
        app.ghostId = null;
        app.guides = null;
        this.hideHud();

        if (g.type === 'pan') {
            if (!g.moved && !cancelled && g.tap) {
                if (g.deselect) app.select(null);
                this.handleTap(p || g.p0);
            }
        } else if (g.moved) {
            if (cancelled) this.revert(g);
            else app.commit(LABELS[g.type]);
        } else if (g.type === 'move' && g.touch && !cancelled) {
            // On phones the image often fills the screen, so double-tap must work on layers too.
            this.handleTap(p || g.p0);
        }
        app.requestRender();
        this.updateBoxes();
    }

    revert(g) {
        const s = g.start;
        this.app.updateLayer(g.id, { x: s.x, y: s.y, scaleX: s.scaleX, scaleY: s.scaleY, rotation: s.rotation });
    }

    abortGesture() {
        const g = this.gesture;
        if (!g) return;
        this.gesture = null;
        if (g.type !== 'pan' && g.moved) this.revert(g);
        this.el.classList.remove('is-panning', 'is-moving', 'is-transforming');
        this.app.ghostId = null;
        this.app.guides = null;
        this.hideHud();
    }

    /** Double-tap on empty canvas toggles between fit and a closer zoom. */
    handleTap(p) {
        const now = performance.now();
        const last = this.lastTap;
        this.lastTap = { t: now, p };
        if (last && now - last.t < 320 && dist(last.p, p) < 24) {
            this.lastTap = null;
            this.toggleZoom(p);
        }
    }

    toggleZoom(p) {
        const app = this.app;
        if (app.view.fitted) app.zoomTo(Math.max(1, app.view.scale * 2.5), p, { animate: true });
        else app.fitView();
    }

    startPinch() {
        const [a, b] = [...this.pointers.values()];
        const v = this.app.view;
        this.pinch = { d0: Math.max(1, dist(a, b)), c0: mid(a, b), scale0: v.scale, x0: v.x, y0: v.y };
        this.app.interacting = true;
        this.box.hidden = true;
    }

    updatePinch() {
        const app = this.app;
        const [a, b] = [...this.pointers.values()];
        const pz = this.pinch;
        const c = mid(a, b);
        const s = app.clampZoom((pz.scale0 * dist(a, b)) / pz.d0);
        const docX = (pz.c0.x - pz.x0) / pz.scale0;
        const docY = (pz.c0.y - pz.y0) / pz.scale0;
        app.setView({ scale: s, x: c.x - docX * s, y: c.y - docY * s });
    }

    onWheel(e) {
        const app = this.app;
        if (!app.layers.length || e.target.closest('.crop-bar, .empty-state')) return;
        e.preventDefault();
        this.rect = this.el.getBoundingClientRect();
        let dx = e.deltaX;
        let dy = e.deltaY;
        if (e.deltaMode === 1) {
            dx *= 16;
            dy *= 16;
        } else if (e.deltaMode === 2) {
            dx *= this.rect.width;
            dy *= this.rect.height;
        }
        if (e.ctrlKey || e.metaKey) {
            // Trackpad pinch arrives as ctrl+wheel with small deltas.
            const factor = Math.exp(-clamp(dy, -30, 30) * 0.01);
            app.zoomTo(app.view.scale * factor, this.local(e));
        } else if (e.shiftKey && !dx) {
            app.panBy(-dy, 0);
        } else {
            app.panBy(-dx, -dy);
        }
    }

    // ---------------------------------------------------------- hit testing

    hitTest(p) {
        const app = this.app;
        const d = app.screenToDoc(p);
        const tol = 6 / app.view.scale;
        const sel = app.selected;
        if (sel && sel.visible && !sel.locked && hitLayer(sel, d.x, d.y, tol)) return sel;
        const doc = app.doc;
        if (d.x < 0 || d.y < 0 || d.x > doc.width || d.y > doc.height) return null;
        for (const l of app.layers) {
            if (!l.visible || l.locked || l.opacity <= 0.01) continue;
            if (hitLayer(l, d.x, d.y) && this.alphaAt(l, d) > 10) return l;
        }
        return null;
    }

    alphaAt(layer, d) {
        const asset = this.app.assets.get(layer.assetId);
        if (!asset) return 255;
        const sp = toSourcePixel(layer, d.x, d.y);
        const sx = clamp(Math.floor((sp.x * asset.proxyW) / layer.width), 0, asset.proxyW - 1);
        const sy = clamp(Math.floor((sp.y * asset.proxyH) / layer.height), 0, asset.proxyH - 1);
        try {
            if (!this.hitCtx) {
                const c = document.createElement('canvas');
                c.width = c.height = 1;
                this.hitCtx = c.getContext('2d', { willReadFrequently: true });
            }
            const x = this.hitCtx;
            x.clearRect(0, 0, 1, 1);
            x.drawImage(asset.proxy, sx, sy, 1, 1, 0, 0, 1, 1);
            return x.getImageData(0, 0, 1, 1).data[3];
        } catch {
            return 255;
        }
    }

    queueHover(e) {
        this.hoverEvent = e;
        if (this.hoverRAF) return;
        this.hoverRAF = requestAnimationFrame(() => {
            this.hoverRAF = 0;
            const ev = this.hoverEvent;
            if (!ev || this.gesture || this.app.tool !== 'move' || this.spaceDown || ev.target.closest(UI_SELECTOR)) {
                this.hideHover();
                return;
            }
            if (ev.target.closest('[data-handle]')) {
                this.hideHover();
                return;
            }
            const hit = this.hitTest(this.local(ev));
            this.el.classList.toggle('over-layer', Boolean(hit));
            const id = hit && hit.id !== this.app.state.selectedId ? hit.id : null;
            if (id !== this.hoverId) {
                this.hoverId = id;
                this.updateBoxes();
            }
        });
    }

    hideHover() {
        this.el.classList.remove('over-layer');
        if (this.hoverId) {
            this.hoverId = null;
            this.hoverBox.hidden = true;
        }
    }

    // ------------------------------------------------------------- overlays

    place(el, layer) {
        const v = this.app.view;
        const { w, h } = layerSize(layer);
        const sw = Math.abs(w * v.scale);
        const sh = Math.abs(h * v.scale);
        const cx = v.x + layer.x * v.scale;
        const cy = v.y + layer.y * v.scale;
        el.style.width = `${sw}px`;
        el.style.height = `${sh}px`;
        el.style.transform = `translate(${cx - sw / 2}px, ${cy - sh / 2}px) rotate(${layer.rotation}deg)`;
        return { sw, sh };
    }

    updateBoxes() {
        const app = this.app;
        const sel = app.selected;
        const showBox = sel && sel.visible && app.tool === 'move' && !this.pinch;
        if (!showBox) {
            this.box.hidden = true;
        } else {
            this.box.hidden = false;
            const { sw, sh } = this.place(this.box, sel);
            this.box.classList.toggle('is-locked', sel.locked);
            this.box.classList.toggle('is-small', Math.min(sw, sh) < 40);
            if (this.lastRotation !== sel.rotation) {
                this.lastRotation = sel.rotation;
                for (const hd of this.box.querySelectorAll('.tb-handle')) {
                    const a = (((HANDLE_ANGLES[hd.dataset.handle] + sel.rotation) % 180) + 180) % 180;
                    hd.style.cursor = RESIZE_CURSORS[Math.round(a / 45) % 4];
                }
            }
        }
        const hover = this.hoverId && app.layerById(this.hoverId);
        if (hover && hover.visible && app.tool === 'move') {
            this.hoverBox.hidden = false;
            this.place(this.hoverBox, hover);
        } else {
            this.hoverBox.hidden = true;
        }
    }

    showHud(text, p) {
        const hud = this.hud;
        hud.textContent = text;
        hud.hidden = false;
        const x = clamp(p.x + 16, 4, this.rect.width - hud.offsetWidth - 4);
        const y = clamp(p.y + 18, 4, this.rect.height - hud.offsetHeight - 4);
        hud.style.transform = `translate(${x}px, ${y}px)`;
    }

    hideHud() {
        this.hud.hidden = true;
    }
}
