// Layer list: selection, visibility/lock toggles, rename, keyboard control and
// pointer-based drag reordering (works with mouse, pen and touch).

import { $, h } from './dom.js';
import { cssFilter, blendLabel, blurRadius } from './filters.js';
import { clamp } from './geometry.js';

export class LayersPanel {
    constructor(app) {
        this.app = app;
        this.list = $('#layerList');
        this.empty = $('#layersEmpty');
        this.count = $('#layerCount');
        this.template = $('#layerRowTemplate');
        this.rows = new Map();
        this.drag = null;
        this.scrollRAF = 0;
        this.suppressClick = false;

        $('#layerAddBtn').addEventListener('click', () => app.shell.openFilePicker());
        $('#layerDupBtn').addEventListener('click', () => app.selected && app.duplicateLayer(app.selected.id));
        $('#layerDelBtn').addEventListener('click', () => app.selected && app.removeLayer(app.selected.id));

        this.list.addEventListener('click', (e) => this.onClick(e));
        this.list.addEventListener('dblclick', (e) => {
            const row = e.target.closest('.layer-row');
            if (row && e.target.closest('.layer-info')) this.startRename(row);
        });
        this.list.addEventListener('keydown', (e) => this.onKey(e));
        this.list.addEventListener('pointerdown', (e) => this.onPointerDown(e));
        this.onDragMove = this.onDragMove.bind(this);
        this.onDragEnd = this.onDragEnd.bind(this);

        app.on('structure', () => this.render());
        app.on('selection', () => this.syncSelection());
        app.on('layer', (layer) => {
            const row = this.rows.get(layer.id);
            if (row) this.updateRow(row, layer);
        });
    }

    render() {
        const layers = this.app.layers;
        const seen = new Set();
        layers.forEach((layer, i) => {
            let row = this.rows.get(layer.id);
            if (!row) {
                row = this.template.content.firstElementChild.cloneNode(true);
                row.dataset.id = layer.id;
                this.rows.set(layer.id, row);
            }
            this.updateRow(row, layer);
            if (this.list.children[i] !== row) this.list.insertBefore(row, this.list.children[i] || null);
            seen.add(layer.id);
        });
        for (const [id, row] of this.rows) {
            if (!seen.has(id)) {
                row.remove();
                this.rows.delete(id);
            }
        }
        const n = layers.length;
        this.count.textContent = n ? String(n) : '';
        this.empty.hidden = n > 0;
        this.list.hidden = n === 0;
        this.syncSelection();
    }

    updateRow(row, layer) {
        const asset = this.app.assets.get(layer.assetId);
        const img = row.querySelector('img');
        if (asset && img.getAttribute('src') !== asset.thumb) img.src = asset.thumb;
        const filter = cssFilter(layer.filters, blurRadius(layer.filters, 44));
        img.style.filter = filter === 'none' ? '' : filter;
        img.style.transform =
            layer.rotation || layer.flipH || layer.flipV ? `rotate(${layer.rotation}deg) scale(${layer.flipH ? -1 : 1}, ${layer.flipV ? -1 : 1})` : '';
        img.style.opacity = layer.visible ? '' : '0.35';

        row.querySelector('.layer-name').textContent = layer.name;
        const meta = [];
        if (layer.blend !== 'source-over') meta.push(blendLabel(layer.blend));
        if (layer.opacity < 1) meta.push(`${Math.round(layer.opacity * 100)}%`);
        if (!meta.length) meta.push(`${layer.width} × ${layer.height}`);
        row.querySelector('.layer-meta').textContent = meta.join(' · ');

        row.classList.toggle('is-hidden', !layer.visible);
        row.classList.toggle('is-locked', layer.locked);
        const vis = row.querySelector('.vis-btn');
        vis.setAttribute('aria-pressed', String(layer.visible));
        vis.setAttribute('aria-label', `${layer.visible ? 'Hide' : 'Show'} ${layer.name}`);
        vis.title = layer.visible ? 'Hide layer' : 'Show layer';
        vis.querySelector('use').setAttribute('href', layer.visible ? '#i-eye' : '#i-eye-off');
        const lock = row.querySelector('.lock-btn');
        lock.setAttribute('aria-pressed', String(layer.locked));
        lock.setAttribute('aria-label', `${layer.locked ? 'Unlock' : 'Lock'} ${layer.name}`);
        lock.title = layer.locked ? 'Unlock layer' : 'Lock layer (prevents moving on canvas)';
        lock.querySelector('use').setAttribute('href', layer.locked ? '#i-lock' : '#i-unlock');
    }

    syncSelection() {
        const selId = this.app.state.selectedId;
        const first = this.list.firstElementChild;
        let selectedRow = null;
        for (const [id, row] of this.rows) {
            const on = id === selId;
            row.classList.toggle('is-selected', on);
            const main = row.querySelector('.layer-main');
            main.setAttribute('aria-current', on ? 'true' : 'false');
            main.tabIndex = on || (!selId && row === first) ? 0 : -1;
            if (on) selectedRow = row;
        }
        const has = Boolean(selId);
        $('#layerDupBtn').disabled = !has;
        $('#layerDelBtn').disabled = !has;
        if (selectedRow && !this.drag) selectedRow.scrollIntoView({ block: 'nearest' });
    }

    focusRow(id) {
        const row = this.rows.get(id);
        if (row) row.querySelector('.layer-main').focus();
    }

    onClick(e) {
        if (this.suppressClick) {
            this.suppressClick = false;
            return;
        }
        const row = e.target.closest('.layer-row');
        if (!row) return;
        const id = row.dataset.id;
        const layer = this.app.layerById(id);
        if (!layer) return;
        if (e.target.closest('.vis-btn')) this.app.setVisible(id, !layer.visible);
        else if (e.target.closest('.lock-btn')) this.app.setLocked(id, !layer.locked);
        else if (e.target.closest('.layer-main')) this.app.select(id);
    }

    onKey(e) {
        const row = e.target.closest('.layer-row');
        if (!row || !e.target.classList.contains('layer-main')) return;
        const app = this.app;
        const id = row.dataset.id;
        const rows = [...this.list.children];
        const i = rows.indexOf(row);
        const go = (j) => {
            const next = rows[clamp(j, 0, rows.length - 1)];
            app.select(next.dataset.id);
            next.querySelector('.layer-main').focus();
        };
        switch (e.key) {
            case 'ArrowUp':
            case 'ArrowDown': {
                e.preventDefault();
                const dir = e.key === 'ArrowUp' ? -1 : 1;
                if (e.altKey) {
                    app.moveLayerBy(id, dir);
                    this.focusRow(id);
                } else {
                    go(i + dir);
                }
                break;
            }
            case 'Home':
                e.preventDefault();
                go(0);
                break;
            case 'End':
                e.preventDefault();
                go(rows.length - 1);
                break;
            case 'Delete':
            case 'Backspace':
                e.preventDefault();
                app.removeLayer(id);
                if (app.state.selectedId) this.focusRow(app.state.selectedId);
                break;
            case 'F2':
                e.preventDefault();
                this.startRename(row);
                break;
        }
    }

    startRename(row) {
        if (row.classList.contains('is-renaming')) return;
        const id = row.dataset.id;
        const layer = this.app.layerById(id);
        if (!layer) return;
        const input = h('input', { type: 'text', class: 'rename-input', maxlength: 120, 'aria-label': 'Layer name', spellcheck: 'false' });
        input.value = layer.name;
        row.classList.add('is-renaming');
        row.append(input);
        input.focus();
        input.select();
        let done = false;
        const finish = (save) => {
            if (done) return;
            done = true;
            const value = input.value;
            input.remove();
            row.classList.remove('is-renaming');
            if (save) this.app.renameLayer(id, value);
            this.focusRow(id);
        };
        input.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter') finish(true);
            if (e.key === 'Escape') finish(false);
        });
        input.addEventListener('blur', () => finish(true));
    }

    // ---------------------------------------------------------- reordering

    onPointerDown(e) {
        const row = e.target.closest('.layer-row');
        if (!row || e.button !== 0 || row.classList.contains('is-renaming')) return;
        const handle = e.target.closest('.drag-handle');
        const main = e.target.closest('.layer-main');
        // Touch reorders via the handle only so the list stays scrollable.
        if (!handle && !(main && e.pointerType !== 'touch')) return;
        this.drag = { row, id: row.dataset.id, pointerId: e.pointerId, startY: e.clientY, lastY: e.clientY, scroll0: this.list.scrollTop, active: false };
        // Listen on window: capturing now would retarget the click that selects the row.
        window.addEventListener('pointermove', this.onDragMove);
        window.addEventListener('pointerup', this.onDragEnd);
        window.addEventListener('pointercancel', this.onDragEnd);
        if (handle) {
            e.preventDefault();
            this.beginDrag();
        }
    }

    beginDrag() {
        const d = this.drag;
        d.rows = [...this.list.children];
        d.from = d.rows.indexOf(d.row);
        d.to = d.from;
        d.top0 = d.rows[0].offsetTop;
        d.rowTop = d.row.offsetTop;
        d.height = d.row.offsetHeight;
        d.slot = d.rows.length > 1 ? d.rows[1].offsetTop - d.rows[0].offsetTop : d.height;
        d.active = true;
        try {
            this.list.setPointerCapture(d.pointerId);
        } catch {
            /* pointer already gone */
        }
        d.row.classList.add('is-dragging');
        this.list.classList.add('is-reordering');
        this.app.select(d.id);
    }

    onDragMove(e) {
        const d = this.drag;
        if (!d || e.pointerId !== d.pointerId) return;
        d.lastY = e.clientY;
        if (!d.active) {
            if (Math.abs(e.clientY - d.startY) < 5) return;
            this.beginDrag();
        }
        this.layoutDrag();
        this.autoScroll();
    }

    layoutDrag() {
        const d = this.drag;
        const dy = d.lastY - d.startY + (this.list.scrollTop - d.scroll0);
        d.row.style.transform = `translateY(${dy}px)`;
        const n = d.rows.length;
        d.to = clamp(Math.round((d.rowTop + dy - d.top0) / d.slot), 0, n - 1);
        d.rows.forEach((r, i) => {
            if (r === d.row) return;
            let shift = 0;
            if (d.from < d.to && i > d.from && i <= d.to) shift = -d.slot;
            else if (d.from > d.to && i >= d.to && i < d.from) shift = d.slot;
            r.style.transform = shift ? `translateY(${shift}px)` : '';
        });
    }

    autoScroll() {
        const d = this.drag;
        if (!d || !d.active) return;
        const r = this.list.getBoundingClientRect();
        const edge = 36;
        let speed = 0;
        if (d.lastY < r.top + edge) speed = -Math.ceil(((r.top + edge - d.lastY) / edge) * 12);
        else if (d.lastY > r.bottom - edge) speed = Math.ceil(((d.lastY - (r.bottom - edge)) / edge) * 12);
        cancelAnimationFrame(this.scrollRAF);
        if (!speed) return;
        this.scrollRAF = requestAnimationFrame(() => {
            if (!this.drag) return;
            this.list.scrollTop += speed;
            this.layoutDrag();
            this.autoScroll();
        });
    }

    onDragEnd(e) {
        const d = this.drag;
        if (!d || e.pointerId !== d.pointerId) return;
        this.drag = null;
        cancelAnimationFrame(this.scrollRAF);
        window.removeEventListener('pointermove', this.onDragMove);
        window.removeEventListener('pointerup', this.onDragEnd);
        window.removeEventListener('pointercancel', this.onDragEnd);
        try {
            this.list.releasePointerCapture(e.pointerId);
        } catch {
            /* already released */
        }
        if (!d.active) return;
        this.suppressClick = true;
        setTimeout(() => (this.suppressClick = false), 0);
        this.list.classList.remove('is-reordering');
        d.row.classList.remove('is-dragging');
        for (const r of d.rows) r.style.transform = '';
        if (e.type !== 'pointercancel' && d.to !== d.from) this.app.moveLayer(d.id, d.to);
    }
}
