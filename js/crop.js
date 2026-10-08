// Canvas crop tool. The selection lives in document space, so it stays put
// while zooming/panning and maps exactly onto the exported pixels.

import { $ } from './dom.js';
import { dragRect, aspectRectWithin, unionRect } from './geometry.js';
import { segmented } from './controls.js';

export class CropController {
    constructor(app) {
        this.app = app;
        this.active = false;
        this.box = $('#cropBox');
        this.bar = $('#cropBar');
        this.sizeEl = $('#cropSize');
        this.rect = null;
        this.aspect = null;
        this.drag = null;

        this.aspects = segmented($('#cropAspects'), (v) => this.setAspect(v));
        $('#cropApply').addEventListener('click', () => this.apply());
        $('#cropCancel').addEventListener('click', () => this.cancel());

        this.box.addEventListener('pointerdown', (e) => this.onDown(e));
        this.box.addEventListener('pointermove', (e) => this.onMove(e));
        this.box.addEventListener('pointerup', (e) => this.onUp(e));
        this.box.addEventListener('pointercancel', (e) => this.onUp(e));
        this.box.addEventListener('dblclick', () => this.apply());
        app.on('view', () => this.active && this.place());
    }

    /** The selection may extend past the canvas to include off-canvas layer pixels. */
    bounds() {
        const d = this.app.doc;
        return unionRect([{ x: 0, y: 0, w: d.width, h: d.height }, this.app.visibleBounds()]);
    }

    enter() {
        const d = this.app.doc;
        this.active = true;
        this.rect = { x: 0, y: 0, w: d.width, h: d.height };
        this.aspect = null;
        this.aspects.select('free', false);
        this.box.hidden = false;
        this.bar.hidden = false;
        this.app.shell.updateInsets();
        this.app.fitView({ animate: true });
        this.place();
        this.app.announce('Crop mode. Drag the handles, then press Enter to apply or Escape to cancel.');
    }

    exit() {
        if (!this.active) return;
        this.active = false;
        this.drag = null;
        this.box.hidden = true;
        this.bar.hidden = true;
        this.box.classList.remove('dragging');
        if (this.app.tool === 'crop') this.app.setTool('move');
        this.app.shell.updateInsets();
    }

    cancel() {
        this.exit();
    }

    apply() {
        if (!this.active) return;
        const r = this.rect;
        this.exit();
        if (r) this.app.cropTo(r);
    }

    setAspect(value) {
        const d = this.app.doc;
        if (value === 'free') {
            this.aspect = null;
        } else {
            this.aspect = value === 'original' ? d.width / d.height : Number(value);
            this.rect = aspectRectWithin({ x: 0, y: 0, w: d.width, h: d.height }, this.aspect);
        }
        this.place();
    }

    place() {
        const v = this.app.view;
        const r = this.rect;
        if (!r) return;
        this.box.style.width = `${r.w * v.scale}px`;
        this.box.style.height = `${r.h * v.scale}px`;
        this.box.style.transform = `translate(${v.x + r.x * v.scale}px, ${v.y + r.y * v.scale}px)`;
        this.sizeEl.textContent = `${Math.round(r.w)} × ${Math.round(r.h)}`;
    }

    onDown(e) {
        if (!this.active || (e.pointerType === 'mouse' && e.button !== 0)) return;
        e.preventDefault();
        e.stopPropagation();
        const h = e.target.closest('[data-crop]');
        this.box.setPointerCapture(e.pointerId);
        this.drag = { id: e.pointerId, handle: h ? h.dataset.crop : 'move', x0: e.clientX, y0: e.clientY, start: { ...this.rect } };
        this.box.classList.add('dragging');
    }

    onMove(e) {
        const d = this.drag;
        if (!d || e.pointerId !== d.id) return;
        const s = this.app.view.scale;
        const dx = (e.clientX - d.x0) / s;
        const dy = (e.clientY - d.y0) / s;
        const aspect = this.aspect ?? (e.shiftKey && d.handle.length === 2 ? d.start.w / d.start.h : null);
        this.rect = dragRect(d.start, d.handle, dx, dy, { aspect, bounds: this.bounds(), min: Math.max(1, 16 / s) });
        this.place();
    }

    onUp(e) {
        if (!this.drag || e.pointerId !== this.drag.id) return;
        this.drag = null;
        this.box.classList.remove('dragging');
    }
}
