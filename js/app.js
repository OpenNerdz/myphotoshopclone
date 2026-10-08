// Application core: document state, actions, undo history, view transform and
// autosave. UI modules subscribe to events emitted here.

import { History } from './history.js';
import { Renderer } from './renderer.js';
import { loadAsset, releaseAsset, mapLimit, isImageFile, stripExtension, MAX_AREA, MAX_SIDE } from './images.js';
import { defaultFilters, normalizeFilters, isBlendMode } from './filters.js';
import { clamp, containScale, coverScale, layerBounds, unionRect, roundRect, normalizeAngle } from './geometry.js';
import * as storage from './storage.js';
import { toast } from './toast.js';
import { $, uid, reducedMotion } from './dom.js';
import { ViewportController } from './viewport.js';
import { CropController } from './crop.js';
import { LayersPanel } from './layers-panel.js';
import { PropertiesPanel } from './properties.js';
import { ExportDialog, confirmDialog } from './dialogs.js';
import { Shell } from './shell.js';
import { createSampleBlobs } from './samples.js';

export const MAX_ZOOM = 32;
const ZOOM_STEPS = [0.02, 0.03, 0.05, 0.0625, 0.0833, 0.125, 0.1667, 0.25, 0.3333, 0.5, 0.6667, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32];
const DEFAULT_DOC = { width: 1920, height: 1080, background: null, auto: true };

const cloneLayer = (l) => ({ ...l, filters: { ...l.filters } });
const finite = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

function sanitizeDoc(d = {}) {
    return {
        width: clamp(Math.round(finite(d.width, DEFAULT_DOC.width)), 1, MAX_SIDE),
        height: clamp(Math.round(finite(d.height, DEFAULT_DOC.height)), 1, MAX_SIDE),
        background: typeof d.background === 'string' && /^#[0-9a-f]{6}$/i.test(d.background) ? d.background : null,
        auto: Boolean(d.auto)
    };
}

function sanitizeLayer(l, asset) {
    return {
        id: typeof l.id === 'string' ? l.id : uid('l'),
        assetId: asset.id,
        name: String(l.name || stripExtension(asset.name)).slice(0, 120),
        width: asset.width,
        height: asset.height,
        x: finite(l.x, 0),
        y: finite(l.y, 0),
        scaleX: Math.max(1e-4, Math.abs(finite(l.scaleX, 1))),
        scaleY: Math.max(1e-4, Math.abs(finite(l.scaleY, 1))),
        rotation: normalizeAngle(finite(l.rotation, 0)),
        flipH: Boolean(l.flipH),
        flipV: Boolean(l.flipV),
        opacity: clamp(finite(l.opacity, 1), 0, 1),
        blend: isBlendMode(l.blend) ? l.blend : 'source-over',
        visible: l.visible !== false,
        locked: Boolean(l.locked),
        filters: normalizeFilters(l.filters)
    };
}

export class App {
    constructor() {
        this.state = { doc: { ...DEFAULT_DOC }, layers: [], selectedId: null };
        this.assets = new Map();
        this.view = { scale: 1, x: 0, y: 0, fitted: true };
        this.insets = { top: 0, right: 0, bottom: 0, left: 0 };
        this.vp = { w: 0, h: 0 };
        this.tool = 'move';
        this.history = new History(100);
        this.interacting = false;
        this.guides = null;
        this.ghostId = null;
        this.listeners = new Map();
        this.viewAnim = 0;
        this.persistTimer = 0;
        this.saveChain = Promise.resolve();
        this.savedAssetIds = new Set();
        this.persistEnabled = true;
        this.persistWarned = false;
    }

    // ---------------------------------------------------------------- events

    on(event, fn) {
        if (!this.listeners.has(event)) this.listeners.set(event, new Set());
        this.listeners.get(event).add(fn);
    }

    emit(event, data) {
        const set = this.listeners.get(event);
        if (set) for (const fn of set) fn(data);
    }

    emitAll() {
        for (const e of ['structure', 'selection', 'doc', 'view', 'history', 'tool']) this.emit(e);
    }

    // ------------------------------------------------------------------ boot

    async init() {
        this.renderer = new Renderer($('#canvas'), this);
        this.shell = new Shell(this);
        this.viewport = new ViewportController(this);
        this.crop = new CropController(this);
        this.layersPanel = new LayersPanel(this);
        this.props = new PropertiesPanel(this);
        this.exportDialog = new ExportDialog(this);
        this.history.reset(this.snapshot());
        this.emitAll();
        await this.restoreSession();
        document.documentElement.classList.add('app-ready');

        const flush = () => {
            if (this.persistTimer) {
                clearTimeout(this.persistTimer);
                this.persistTimer = 0;
                this.saveChain = this.saveChain.then(() => this.persistNow());
            }
        };
        document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flush());
        window.addEventListener('pagehide', flush);
    }

    // --------------------------------------------------------------- queries

    get layers() {
        return this.state.layers;
    }

    get doc() {
        return this.state.doc;
    }

    get selected() {
        return this.layerById(this.state.selectedId);
    }

    layerById(id) {
        return id ? this.state.layers.find((l) => l.id === id) || null : null;
    }

    indexOf(id) {
        return this.state.layers.findIndex((l) => l.id === id);
    }

    requestRender() {
        this.renderer.request();
    }

    announce(message) {
        const el = $('#srStatus');
        if (el) {
            el.textContent = '';
            requestAnimationFrame(() => (el.textContent = message));
        }
    }

    setBusy(on, label = '') {
        const el = $('#busy');
        if (!el) return;
        el.hidden = !on;
        const text = $('.busy-label', el);
        if (text) text.textContent = label;
    }

    // ------------------------------------------------------------- history

    snapshot() {
        return {
            doc: { ...this.state.doc },
            layers: this.state.layers.map(cloneLayer),
            selectedId: this.state.selectedId
        };
    }

    commit(label, key = null) {
        this.history.push(this.snapshot(), { label, key });
        this.gcAssets();
        this.emit('history');
        this.schedulePersist();
    }

    applySnapshot(snap) {
        const prevDoc = this.state.doc;
        this.state = {
            doc: { ...snap.doc },
            layers: snap.layers.map(cloneLayer),
            selectedId: snap.selectedId
        };
        if (this.state.selectedId && !this.layerById(this.state.selectedId)) this.state.selectedId = null;
        const docChanged = prevDoc.width !== this.state.doc.width || prevDoc.height !== this.state.doc.height;
        this.renderer.prune(new Set(this.state.layers.map((l) => l.id)));
        this.emit('structure');
        this.emit('selection');
        this.emit('doc');
        if (docChanged && this.view.fitted) this.fitView({ animate: true });
        else {
            this.clampView();
            this.emit('view');
        }
        this.requestRender();
    }

    undo() {
        if (this.crop.active) {
            this.crop.cancel();
            return;
        }
        const r = this.history.undo();
        if (!r) return;
        this.applySnapshot(r.state);
        this.emit('history');
        this.schedulePersist();
        this.announce(`Undo ${r.label}`);
    }

    redo() {
        if (this.crop.active) return;
        const r = this.history.redo();
        if (!r) return;
        this.applySnapshot(r.state);
        this.emit('history');
        this.schedulePersist();
        this.announce(`Redo ${r.label}`);
    }

    /** Release decoded images no longer reachable from the document or history. */
    gcAssets() {
        const used = new Set(this.state.layers.map((l) => l.assetId));
        for (const s of this.history.states()) for (const l of s.layers) used.add(l.assetId);
        for (const [id, asset] of this.assets) {
            if (!used.has(id)) {
                releaseAsset(asset);
                this.assets.delete(id);
            }
        }
        this.renderer.prune(new Set(this.state.layers.map((l) => l.id)));
    }

    // ------------------------------------------------------------- autosave

    schedulePersist() {
        if (!this.persistEnabled) return;
        clearTimeout(this.persistTimer);
        this.persistTimer = setTimeout(() => {
            this.persistTimer = 0;
            this.saveChain = this.saveChain.then(() => this.persistNow());
        }, 700);
    }

    async persistNow() {
        if (!this.persistEnabled) return;
        const snap = this.snapshot();
        try {
            if (!snap.layers.length) {
                await storage.clearProject();
                this.savedAssetIds.clear();
                return;
            }
            const keep = new Set(snap.layers.map((l) => l.assetId));
            const pending = [...keep].filter((id) => !this.savedAssetIds.has(id)).map((id) => this.assets.get(id)).filter(Boolean);
            await storage.saveProject({ version: 2, savedAt: Date.now(), ...snap }, pending, keep);
            for (const a of pending) this.savedAssetIds.add(a.id);
            for (const id of [...this.savedAssetIds]) if (!keep.has(id)) this.savedAssetIds.delete(id);
        } catch (err) {
            console.warn('Autosave failed', err);
            if (!this.persistWarned) {
                this.persistWarned = true;
                toast('Autosave is unavailable in this browser. Export your work to keep it.', { type: 'error', duration: 7000 });
            }
        }
    }

    async restoreSession() {
        let saved = null;
        try {
            saved = await storage.loadProject();
        } catch {
            return; // IndexedDB unavailable (e.g. some private modes) — autosave will warn on first save.
        }
        const savedLayers = saved && Array.isArray(saved.project.layers) ? saved.project.layers : [];
        if (!savedLayers.length) return;

        this.setBusy(true, 'Restoring your last session…');
        const ids = [...new Set(savedLayers.map((l) => l.assetId))];
        const results = await mapLimit(ids, 3, async (id) => {
            const rec = saved.assets.get(id);
            if (!rec || !rec.blob) throw new Error('Missing image data');
            return loadAsset(rec.blob, rec.name, id);
        });
        for (const r of results) {
            if (r.ok) {
                this.assets.set(r.value.id, r.value);
                this.savedAssetIds.add(r.value.id);
            }
        }
        const layers = savedLayers.filter((l) => this.assets.has(l.assetId)).map((l) => sanitizeLayer(l, this.assets.get(l.assetId)));
        this.state = {
            doc: sanitizeDoc(saved.project.doc),
            layers,
            selectedId: layers.some((l) => l.id === saved.project.selectedId) ? saved.project.selectedId : null
        };
        this.history.reset(this.snapshot());
        this.setBusy(false);
        this.emitAll();
        this.fitView({ animate: false });

        if (layers.length) {
            toast('Restored your previous session', {
                type: 'success',
                duration: 6000,
                action: { label: 'Start new', run: () => this.clearAll({ confirm: false }) }
            });
        }
        if (layers.length < savedLayers.length) toast('Some images from your last session could not be restored.', { type: 'error' });
    }

    // --------------------------------------------------------------- adding

    async addFiles(list) {
        const all = [...(list || [])];
        const files = all.filter(isImageFile);
        if (!files.length) {
            if (all.length) toast('That file type isn’t supported. Try JPG, PNG, WebP, GIF, AVIF or SVG.', { type: 'error' });
            return;
        }
        const slow = files.length > 1 || files.some((f) => f.size > 3_000_000);
        const progress = slow ? toast(files.length > 1 ? `Adding ${files.length} images…` : 'Adding image…', { spinner: true, duration: 0 }) : null;
        const results = await mapLimit(files, 3, (f) => loadAsset(f, f.name || 'Pasted image'));
        progress && progress.close();

        const assets = results.filter((r) => r.ok).map((r) => r.value);
        const failed = results.length - assets.length;
        if (assets.length) this.addAssets(assets, assets.length === 1 ? 'Add image' : `Add ${assets.length} images`);
        if (failed) {
            const first = files[results.findIndex((r) => !r.ok)];
            toast(failed === 1 ? `Couldn’t open “${first.name}”. The file may be corrupt or in an unsupported format.` : `${failed} files couldn’t be opened.`, {
                type: 'error',
                duration: 6000
            });
        }
        if (assets.some((a) => a.capped)) toast('A very large image was scaled down to fit browser memory limits.');
    }

    addAssets(assets, label, overrides = []) {
        if (this.crop.active) this.crop.cancel();
        const wasEmpty = !this.state.layers.length;
        assets.forEach((asset, i) => {
            this.assets.set(asset.id, asset);
            this.insertLayerForAsset(asset, overrides[i]);
        });
        this.emit('structure');
        this.emit('selection');
        this.emit('doc');
        if (wasEmpty) this.fitView({ animate: false });
        this.requestRender();
        this.commit(label);
    }

    insertLayerForAsset(asset, overrides = {}) {
        const doc = this.state.doc;
        if (!this.state.layers.length && doc.auto) {
            doc.width = asset.width;
            doc.height = asset.height;
        }
        const s = Math.min(1, containScale(asset.width, asset.height, doc.width, doc.height));
        const layer = {
            id: uid('l'),
            assetId: asset.id,
            name: stripExtension(asset.name),
            width: asset.width,
            height: asset.height,
            x: doc.width / 2,
            y: doc.height / 2,
            scaleX: s,
            scaleY: s,
            rotation: 0,
            flipH: false,
            flipV: false,
            opacity: 1,
            blend: 'source-over',
            visible: true,
            locked: false,
            filters: defaultFilters(),
            ...overrides
        };
        this.state.layers.unshift(layer); // new layers go on top
        this.state.selectedId = layer.id;
        return layer;
    }

    async loadSamples() {
        this.setBusy(true, 'Creating sample images…');
        try {
            const samples = await createSampleBlobs();
            const assets = await Promise.all(samples.map((s) => loadAsset(s.blob, s.name)));
            this.addAssets(assets, 'Add sample images', samples.map((s) => s.overrides || {}));
            this.announce('Sample images added');
        } catch (err) {
            console.error(err);
            toast('Couldn’t create the sample images.', { type: 'error' });
        } finally {
            this.setBusy(false);
        }
    }

    // ------------------------------------------------------------ selection

    select(id) {
        if (id && !this.layerById(id)) id = null;
        if (this.state.selectedId === id) return;
        this.state.selectedId = id;
        this.emit('selection');
    }

    selectRelative(delta) {
        const layers = this.state.layers;
        if (!layers.length) return;
        const i = this.indexOf(this.state.selectedId);
        const next = i < 0 ? 0 : clamp(i + delta, 0, layers.length - 1);
        this.select(layers[next].id);
    }

    // --------------------------------------------------------- layer edits

    /**
     * Patch a layer. `commit` (a history label) records an undo step; `key`
     * merges rapid repeated edits (nudges, typing) into one step.
     */
    updateLayer(id, patch, { commit = null, key = null } = {}) {
        const layer = this.layerById(id);
        if (!layer) return;
        if (patch.filters) patch = { ...patch, filters: { ...layer.filters, ...patch.filters } };
        Object.assign(layer, patch);
        this.emit('layer', layer);
        this.requestRender();
        if (commit) this.commit(commit, key);
    }

    removeLayer(id, { notify = true } = {}) {
        const layers = this.state.layers;
        const i = this.indexOf(id);
        if (i < 0) return;
        const [removed] = layers.splice(i, 1);
        if (this.state.selectedId === id) {
            const next = layers[Math.min(i, layers.length - 1)];
            this.state.selectedId = next ? next.id : null;
        }
        if (!layers.length && this.crop.active) this.crop.cancel();
        this.renderer.drop(id);
        this.emit('structure');
        this.emit('selection');
        this.requestRender();
        this.commit('Delete layer');
        if (notify) toast(`Deleted “${removed.name}”`, { action: { label: 'Undo', run: () => this.undo() } });
    }

    duplicateLayer(id) {
        const src = this.layerById(id);
        if (!src) return;
        const offset = Math.max(8, Math.round(Math.min(this.doc.width, this.doc.height) * 0.02));
        const copy = { ...cloneLayer(src), id: uid('l'), name: `${src.name} copy`.slice(0, 120), x: src.x + offset, y: src.y + offset, locked: false };
        this.state.layers.splice(this.indexOf(id), 0, copy);
        this.state.selectedId = copy.id;
        this.emit('structure');
        this.emit('selection');
        this.requestRender();
        this.commit('Duplicate layer');
    }

    moveLayer(id, toIndex) {
        const layers = this.state.layers;
        const from = this.indexOf(id);
        if (from < 0) return;
        const to = clamp(toIndex, 0, layers.length - 1);
        if (to === from) return;
        const [l] = layers.splice(from, 1);
        layers.splice(to, 0, l);
        this.emit('structure');
        this.requestRender();
        this.commit('Reorder layers');
        this.announce(`${l.name} moved to position ${to + 1} of ${layers.length}`);
    }

    /** delta −1 brings a layer forward (towards the top of the stack). */
    moveLayerBy(id, delta) {
        const i = this.indexOf(id);
        if (i >= 0) this.moveLayer(id, i + delta);
    }

    setVisible(id, visible) {
        this.updateLayer(id, { visible }, { commit: visible ? 'Show layer' : 'Hide layer' });
        this.emit('structure');
    }

    setLocked(id, locked) {
        this.updateLayer(id, { locked }, { commit: locked ? 'Lock layer' : 'Unlock layer' });
        this.emit('structure');
        this.emit('selection');
    }

    renameLayer(id, name) {
        const l = this.layerById(id);
        const next = String(name || '').trim().slice(0, 120);
        if (!l || !next || next === l.name) return;
        this.updateLayer(id, { name: next }, { commit: 'Rename layer' });
        this.emit('structure');
    }

    fitLayer(id, mode = 'contain') {
        const l = this.layerById(id);
        if (!l) return;
        const d = this.doc;
        const s = (mode === 'cover' ? coverScale : containScale)(l.width, l.height, d.width, d.height);
        this.updateLayer(id, { scaleX: s, scaleY: s, x: d.width / 2, y: d.height / 2 }, { commit: mode === 'cover' ? 'Fill canvas' : 'Fit to canvas' });
    }

    centerLayer(id) {
        this.updateLayer(id, { x: this.doc.width / 2, y: this.doc.height / 2 }, { commit: 'Center layer' });
    }

    resetTransform(id) {
        const l = this.layerById(id);
        if (!l) return;
        const s = Math.min(1, containScale(l.width, l.height, this.doc.width, this.doc.height));
        this.updateLayer(
            id,
            { scaleX: s, scaleY: s, rotation: 0, flipH: false, flipV: false, x: this.doc.width / 2, y: this.doc.height / 2 },
            { commit: 'Reset transform' }
        );
    }

    rotateBy(id, deg) {
        const l = this.layerById(id);
        if (l) this.updateLayer(id, { rotation: normalizeAngle(l.rotation + deg) }, { commit: 'Rotate layer' });
    }

    flip(id, axis) {
        const l = this.layerById(id);
        if (!l) return;
        const key = axis === 'h' ? 'flipH' : 'flipV';
        this.updateLayer(id, { [key]: !l[key] }, { commit: axis === 'h' ? 'Flip horizontal' : 'Flip vertical' });
    }

    nudge(id, dx, dy) {
        const l = this.layerById(id);
        if (!l || l.locked) return;
        this.updateLayer(id, { x: l.x + dx, y: l.y + dy }, { commit: 'Move layer', key: `nudge:${id}` });
    }

    /** Scale every layer to fit the canvas (same visual size) and centre it. */
    fitAllLayers() {
        if (!this.state.layers.length) return;
        const d = this.doc;
        for (const l of this.state.layers) {
            const s = containScale(l.width, l.height, d.width, d.height);
            Object.assign(l, { scaleX: s, scaleY: s, x: d.width / 2, y: d.height / 2 });
        }
        if (this.selected) this.emit('layer', this.selected);
        this.emit('structure');
        this.fitView({ animate: true });
        this.requestRender();
        this.commit('Fit all layers');
        toast('All layers fitted to the canvas');
    }

    // ------------------------------------------------------------- document

    resizeDoc(width, height, label = 'Resize canvas') {
        let w = clamp(Math.round(width), 1, MAX_SIDE);
        let h = clamp(Math.round(height), 1, MAX_SIDE);
        if (w * h > MAX_AREA) {
            const s = Math.sqrt(MAX_AREA / (w * h));
            w = Math.floor(w * s);
            h = Math.floor(h * s);
            toast(`Canvas limited to ${w} × ${h} to stay within browser memory limits.`);
        }
        const d = this.doc;
        if (w === d.width && h === d.height) return;
        const dx = (w - d.width) / 2;
        const dy = (h - d.height) / 2;
        for (const l of this.state.layers) {
            l.x += dx;
            l.y += dy;
        }
        Object.assign(d, { width: w, height: h, auto: false });
        this.afterDocChange();
        this.commit(label);
    }

    setBackground(color, { commit = true } = {}) {
        this.doc.background = color;
        this.emit('doc');
        this.requestRender();
        if (commit) this.commit(color ? 'Canvas color' : 'Transparent canvas', 'background');
    }

    /** Crop the canvas to a document-space rect. Layers keep their pixels. */
    cropTo(rect, label = 'Crop') {
        const r = roundRect(rect);
        const d = this.doc;
        if (r.x === 0 && r.y === 0 && r.w === d.width && r.h === d.height) return false;
        for (const l of this.state.layers) {
            l.x -= r.x;
            l.y -= r.y;
        }
        Object.assign(d, { width: r.w, height: r.h, auto: false });
        this.afterDocChange();
        this.commit(label);
        return true;
    }

    visibleBounds() {
        return unionRect(this.state.layers.filter((l) => l.visible).map(layerBounds));
    }

    trimToLayers() {
        const b = this.visibleBounds();
        if (!b) return;
        if (!this.cropTo(b, 'Trim canvas to layers')) toast('The canvas already matches the layers.');
    }

    afterDocChange() {
        this.emit('doc');
        if (this.selected) this.emit('layer', this.selected);
        this.fitView({ animate: true });
        this.requestRender();
    }

    async clearAll({ confirm = true } = {}) {
        if (!this.state.layers.length) return;
        if (confirm) {
            const ok = await confirmDialog({
                title: 'Clear the canvas?',
                message: 'All layers will be removed. You can undo this afterwards.',
                confirmLabel: 'Clear canvas',
                danger: true
            });
            if (!ok) return;
        }
        if (this.crop.active) this.crop.cancel();
        this.state.layers = [];
        this.state.selectedId = null;
        this.state.doc = { ...DEFAULT_DOC };
        this.renderer.prune(new Set());
        this.emitAll();
        this.requestRender();
        this.commit('Clear canvas');
        toast('Canvas cleared', { action: { label: 'Undo', run: () => this.undo() } });
    }

    // ----------------------------------------------------------------- tools

    setTool(tool) {
        if (tool === this.tool) return;
        if (tool === 'crop') {
            if (!this.state.layers.length) {
                toast('Add an image before cropping.');
                return;
            }
            this.tool = 'crop';
            this.crop.enter();
        } else {
            const leavingCrop = this.tool === 'crop';
            this.tool = tool;
            if (leavingCrop && this.crop.active) this.crop.cancel();
        }
        this.emit('tool');
    }

    // ------------------------------------------------------------------ view

    setViewportSize(w, h) {
        const prev = this.vp;
        this.vp = { w, h };
        this.renderer.resize(w, h);
        if (this.view.fitted || !prev.w) {
            this.fitView({ animate: false });
        } else {
            this.view.x += (w - prev.w) / 2;
            this.view.y += (h - prev.h) / 2;
            this.clampView();
            this.emit('view');
            this.requestRender();
        }
    }

    setInsets(insets) {
        const changed = Object.entries(insets).some(([k, v]) => this.insets[k] !== v);
        if (!changed) return;
        Object.assign(this.insets, insets);
        if (this.view.fitted) this.fitView({ animate: true });
    }

    /** Area the canvas should fit into: viewport minus floating UI and padding. */
    fitBox() {
        const { w, h } = this.vp;
        const ins = this.insets;
        const pad = Math.min(w, h) < 600 ? 20 : 56;
        // On larger layouts keep the zoom pill (bottom-left) and the rotate handle
        // (above the selection) clear of a fitted canvas.
        const roomy = this.shell && !this.shell.isPhone;
        const bottom = roomy ? Math.max(pad, 56) : pad;
        const x = ins.left + pad;
        const y = ins.top + (roomy ? Math.max(pad, 50) : pad);
        return { x, y, w: Math.max(40, w - ins.right - pad - x), h: Math.max(40, h - ins.bottom - bottom - y) };
    }

    rawFitScale() {
        const box = this.fitBox();
        return Math.min(box.w / this.doc.width, box.h / this.doc.height);
    }

    minZoom() {
        return Math.min(0.02, this.rawFitScale() * 0.5);
    }

    clampZoom(scale) {
        return clamp(scale, this.minZoom(), MAX_ZOOM);
    }

    fitTarget() {
        const box = this.fitBox();
        const scale = clamp(this.rawFitScale(), this.minZoom(), MAX_ZOOM);
        return {
            scale,
            x: box.x + (box.w - this.doc.width * scale) / 2,
            y: box.y + (box.h - this.doc.height * scale) / 2
        };
    }

    visibleCenter() {
        const ins = this.insets;
        return { x: ins.left + (this.vp.w - ins.left - ins.right) / 2, y: ins.top + (this.vp.h - ins.top - ins.bottom) / 2 };
    }

    fitView({ animate = true } = {}) {
        if (!this.vp.w) return;
        this.setView(this.fitTarget(), { animate, fitted: true });
    }

    setView(target, { animate = false, fitted = false, duration = 240 } = {}) {
        cancelAnimationFrame(this.viewAnim);
        this.viewAnim = 0;
        const v = this.view;
        if (!animate || reducedMotion()) {
            Object.assign(v, target);
            v.fitted = fitted;
            this.clampView();
            this.emit('view');
            this.requestRender();
            return;
        }
        const from = { scale: v.scale, x: v.x, y: v.y };
        const t0 = performance.now();
        const ease = (t) => 1 - Math.pow(1 - t, 3);
        const step = (now) => {
            const t = Math.min(1, (now - t0) / duration);
            const k = ease(t);
            v.scale = Math.exp(Math.log(from.scale) + (Math.log(target.scale) - Math.log(from.scale)) * k);
            v.x = from.x + (target.x - from.x) * k;
            v.y = from.y + (target.y - from.y) * k;
            v.fitted = fitted;
            if (t >= 1) {
                Object.assign(v, target);
                this.clampView();
                this.viewAnim = 0;
            } else {
                this.viewAnim = requestAnimationFrame(step);
            }
            this.emit('view');
            this.renderer.drawNow();
        };
        this.viewAnim = requestAnimationFrame(step);
    }

    stopViewAnimation() {
        if (this.viewAnim) {
            cancelAnimationFrame(this.viewAnim);
            this.viewAnim = 0;
        }
    }

    zoomTo(scale, anchor = this.visibleCenter(), { animate = false } = {}) {
        const v = this.view;
        const s = clamp(scale, this.minZoom(), MAX_ZOOM);
        const k = s / v.scale;
        this.setView({ scale: s, x: anchor.x - (anchor.x - v.x) * k, y: anchor.y - (anchor.y - v.y) * k }, { animate, duration: 160 });
    }

    zoomBy(factor, anchor) {
        this.zoomTo(this.view.scale * factor, anchor);
    }

    zoomStep(dir, anchor) {
        const cur = this.view.scale;
        const next = dir > 0 ? ZOOM_STEPS.find((z) => z > cur * 1.001) ?? MAX_ZOOM : [...ZOOM_STEPS].reverse().find((z) => z < cur / 1.001) ?? this.minZoom();
        this.zoomTo(next, anchor, { animate: true });
    }

    panBy(dx, dy) {
        this.stopViewAnimation();
        this.view.x += dx;
        this.view.y += dy;
        this.view.fitted = false;
        this.clampView();
        this.emit('view');
        this.requestRender();
    }

    /** Keep at least a sliver of the canvas on screen. */
    clampView() {
        const v = this.view;
        const w = this.doc.width * v.scale;
        const h = this.doc.height * v.scale;
        const mx = Math.min(64, w / 2);
        const my = Math.min(64, h / 2);
        v.x = clamp(v.x, mx - w, this.vp.w - mx);
        v.y = clamp(v.y, my - h, this.vp.h - my);
    }

    screenToDoc(p) {
        const v = this.view;
        return { x: (p.x - v.x) / v.scale, y: (p.y - v.y) / v.scale };
    }

    docToScreen(p) {
        const v = this.view;
        return { x: v.x + p.x * v.scale, y: v.y + p.y * v.scale };
    }
}
