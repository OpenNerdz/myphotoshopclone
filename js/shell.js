// App chrome: top bar, menu, file intake (picker, drop, paste), keyboard
// shortcuts, zoom bar, resizable side panel and the phone bottom sheet.

import { $, $$, isTypingTarget, modKey, settings, isMac, trackPointer } from './dom.js';
import { clamp } from './geometry.js';
import { openShortcuts } from './dialogs.js';
import { toast } from './toast.js';

const PANEL_MIN = 280;
const PANEL_MAX = 520;
const PANEL_DEFAULT = 328;

export class Shell {
    constructor(app) {
        this.app = app;
        this.root = $('#app');
        this.panel = $('#panel');
        this.fileInput = $('#fileInput');
        this.phoneQuery = window.matchMedia('(max-width: 767px)');
        this.sideSheetQuery = window.matchMedia('(max-width: 767px) and (orientation: landscape)');
        this.isPhone = this.phoneQuery.matches;
        this.tab = null;
        this.dragDepth = 0;

        this.bindTopbar();
        this.bindMenu();
        this.bindActions();
        this.bindFiles();
        this.bindKeyboard();
        this.bindZoomBar();
        this.bindPanelResize();
        this.bindSheet();

        for (const el of $$('.mod-key')) el.textContent = modKey;

        app.on('history', () => this.syncHistory());
        app.on('structure', () => this.syncStructure());
        app.on('view', () => this.syncZoom());
        app.on('doc', () => this.syncDoc());
        app.on('tool', () => this.syncTool());
        app.on('selection', () => this.syncNav());
    }

    // ------------------------------------------------------------ top bar

    bindTopbar() {
        $('#addBtn').addEventListener('click', () => this.openFilePicker());
        $('#exportBtn').addEventListener('click', () => this.app.exportDialog.open());
        $('#undoBtn').addEventListener('click', () => this.app.undo());
        $('#redoBtn').addEventListener('click', () => this.app.redo());
        for (const b of $$('.tool-btn[data-tool]')) {
            b.addEventListener('click', () => this.app.setTool(b.dataset.tool));
        }
    }

    syncHistory() {
        const h = this.app.history;
        const undo = $('#undoBtn');
        const redo = $('#redoBtn');
        undo.disabled = !h.canUndo;
        redo.disabled = !h.canRedo;
        undo.title = h.canUndo ? `Undo ${h.undoLabel} (${modKey}+Z)` : 'Undo';
        redo.title = h.canRedo ? `Redo ${h.redoLabel} (${modKey}+Shift+Z)` : 'Redo';
    }

    syncStructure() {
        const has = this.app.layers.length > 0;
        this.root.classList.toggle('has-layers', has);
        $('#emptyState').hidden = has;
        $('#zoomBar').hidden = !has;
        $('#exportBtn').disabled = !has;
        this.syncNav();
    }

    syncTool() {
        const tool = this.app.tool;
        this.root.dataset.tool = tool;
        for (const b of $$('.tool-btn[data-tool]')) b.setAttribute('aria-pressed', String(b.dataset.tool === tool));
        if (tool === 'crop' && this.isPhone) this.closeSheet();
        this.syncNav();
        this.updateInsets();
    }

    syncDoc() {
        const d = this.app.doc;
        $('#docSize').textContent = `${d.width} × ${d.height}`;
    }

    // --------------------------------------------------------------- menu

    bindMenu() {
        const btn = $('#menuBtn');
        const menu = $('#mainMenu');
        const items = () => $$('.menu-item', menu).filter((i) => !i.disabled);
        const close = (focusButton = false) => {
            if (menu.hidden) return;
            menu.hidden = true;
            btn.setAttribute('aria-expanded', 'false');
            if (focusButton) btn.focus();
        };
        const open = () => {
            const has = this.app.layers.length > 0;
            for (const i of $$('[data-action="fit-layers"], [data-action="trim"], [data-action="clear"]', menu)) i.disabled = !has;
            menu.hidden = false;
            btn.setAttribute('aria-expanded', 'true');
            const first = items()[0];
            if (first) first.focus();
        };
        this.closeMenu = close;
        btn.addEventListener('click', () => (menu.hidden ? open() : close()));
        menu.addEventListener('click', (e) => {
            if (e.target.closest('.menu-item')) close();
        });
        menu.addEventListener('keydown', (e) => {
            const list = items();
            const i = list.indexOf(document.activeElement);
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                const next = list[(i + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length];
                next && next.focus();
            } else if (e.key === 'Home' || e.key === 'End') {
                e.preventDefault();
                (e.key === 'Home' ? list[0] : list[list.length - 1]).focus();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                close(true);
            } else if (e.key === 'Tab') {
                close();
            }
        });
        document.addEventListener('pointerdown', (e) => {
            if (!menu.hidden && !menu.contains(e.target) && !btn.contains(e.target)) close();
        });
    }

    // ------------------------------------------------------------ actions

    bindActions() {
        document.addEventListener('click', (e) => {
            const el = e.target.closest('[data-action]');
            if (!el || el.disabled) return;
            this.runAction(el.dataset.action);
        });
    }

    runAction(action) {
        const app = this.app;
        switch (action) {
            case 'add':
                this.openFilePicker();
                break;
            case 'sample':
                app.loadSamples();
                break;
            case 'fit-layers':
                app.fitAllLayers();
                break;
            case 'trim':
                app.trimToLayers();
                break;
            case 'crop':
                app.setTool('crop');
                break;
            case 'canvas':
                this.showCanvasSettings();
                break;
            case 'shortcuts':
                openShortcuts();
                break;
            case 'clear':
                app.clearAll();
                break;
        }
    }

    showCanvasSettings() {
        this.app.select(null);
        if (this.isPhone) {
            this.openTab('canvas');
        } else {
            const sec = $('[data-section="canvas"]');
            sec.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            const input = $('input', sec);
            if (input) setTimeout(() => input.focus({ preventScroll: true }), 50);
        }
    }

    // -------------------------------------------------------- file intake

    openFilePicker() {
        this.fileInput.click();
    }

    bindFiles() {
        this.fileInput.addEventListener('change', () => {
            const files = [...this.fileInput.files];
            this.fileInput.value = ''; // allow re-selecting the same file
            if (files.length) this.app.addFiles(files);
        });

        const indicator = $('#dropIndicator');
        const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
        const reset = () => {
            this.dragDepth = 0;
            indicator.classList.remove('active');
        };
        window.addEventListener('dragenter', (e) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            this.dragDepth++;
            indicator.classList.add('active');
        });
        window.addEventListener('dragover', (e) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
        });
        window.addEventListener('dragleave', (e) => {
            if (!hasFiles(e)) return;
            this.dragDepth = Math.max(0, this.dragDepth - 1);
            if (this.dragDepth === 0) indicator.classList.remove('active');
        });
        window.addEventListener('drop', (e) => {
            if (!e.dataTransfer) return;
            e.preventDefault();
            reset();
            const files = [...e.dataTransfer.files];
            if (files.length) this.app.addFiles(files);
            else if ([...e.dataTransfer.types].includes('text/uri-list')) toast('Drop image files from your device. Images dragged from web pages can’t be read.', { type: 'error' });
        });
        window.addEventListener('blur', reset);

        window.addEventListener('paste', (e) => {
            if (isTypingTarget(e.target) || !e.clipboardData) return;
            const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'));
            if (!files.length) {
                for (const item of e.clipboardData.items || []) {
                    if (item.kind === 'file' && item.type.startsWith('image/')) {
                        const f = item.getAsFile();
                        if (f) files.push(f);
                    }
                }
            }
            if (!files.length) return;
            e.preventDefault();
            this.app.addFiles(files.map((f, i) => (f.name && f.name !== 'image.png' ? f : new File([f], `Pasted image${files.length > 1 ? ` ${i + 1}` : ''}.png`, { type: f.type }))));
        });
    }

    // ----------------------------------------------------------- keyboard

    bindKeyboard() {
        window.addEventListener('keydown', (e) => this.onKeyDown(e));
    }

    onKeyDown(e) {
        if (e.defaultPrevented || e.isComposing) return;
        if (document.querySelector('dialog[open]')) return;
        const app = this.app;
        const target = e.target;
        const typing = isTypingTarget(target);
        const inForm = typing || (target && target.matches && target.matches('input, select, textarea'));
        const onButton = target && target.closest && target.closest('button, a, [role="menuitem"]');
        const mod = isMac ? e.metaKey : e.ctrlKey;
        const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
        const sel = app.selected;

        if (mod && !e.altKey) {
            if (key === 'z' && !typing) {
                e.preventDefault();
                if (e.shiftKey) app.redo();
                else app.undo();
                return;
            }
            if (key === 'y' && !typing) {
                e.preventDefault();
                app.redo();
                return;
            }
            if (typing) return;
            const run = (fn) => {
                e.preventDefault();
                fn();
            };
            switch (key) {
                case 'd':
                    return run(() => sel && app.duplicateLayer(sel.id));
                case 's':
                case 'e':
                    return run(() => app.layers.length && app.exportDialog.open());
                case 'o':
                    return run(() => this.openFilePicker());
                case '0':
                    return run(() => app.fitView());
                case '1':
                    return run(() => app.zoomTo(1, app.visibleCenter(), { animate: true }));
                case '=':
                case '+':
                    return run(() => app.zoomStep(1));
                case '-':
                    return run(() => app.zoomStep(-1));
            }
            // Match brackets by physical key: with Shift held, e.key is } or {.
            if (e.code === 'BracketRight') return run(() => sel && (e.shiftKey ? app.moveLayer(sel.id, 0) : app.moveLayerBy(sel.id, -1)));
            if (e.code === 'BracketLeft') return run(() => sel && (e.shiftKey ? app.moveLayer(sel.id, app.layers.length - 1) : app.moveLayerBy(sel.id, 1)));
            return;
        }
        if (e.ctrlKey || e.metaKey || e.altKey) return;

        const cropping = app.tool === 'crop';
        switch (key) {
            case 'Escape':
                if (typing) return; // fields handle Escape themselves
                if (cropping) app.crop.cancel();
                else if (this.isPhone && this.tab) this.closeSheet();
                else app.select(null);
                return;
            case 'Enter':
                if (cropping && !typing && target.id !== 'cropCancel') {
                    e.preventDefault();
                    app.crop.apply();
                }
                return;
            case 'Delete':
            case 'Backspace':
                if (!inForm && sel && !cropping) {
                    e.preventDefault();
                    app.removeLayer(sel.id);
                }
                return;
            case 'ArrowUp':
            case 'ArrowDown':
            case 'ArrowLeft':
            case 'ArrowRight': {
                if (inForm || !sel || cropping || onButton) return;
                e.preventDefault();
                const step = e.shiftKey ? 10 : 1;
                const dx = key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0;
                const dy = key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0;
                app.nudge(sel.id, dx, dy);
                return;
            }
        }
        if (typing) return;
        switch (key) {
            case 'v':
                app.setTool('move');
                break;
            case 'h':
                app.setTool('hand');
                break;
            case 'c':
                app.setTool(cropping ? 'move' : 'crop');
                break;
            case 'i':
                this.openFilePicker();
                break;
            case 'a':
                app.fitAllLayers();
                break;
            case '?':
                openShortcuts();
                break;
            default:
                return;
        }
        e.preventDefault();
    }

    // ----------------------------------------------------------- zoom bar

    bindZoomBar() {
        const app = this.app;
        $('#zoomOutBtn').addEventListener('click', () => app.zoomStep(-1));
        $('#zoomInBtn').addEventListener('click', () => app.zoomStep(1));
        $('#zoomFitBtn').addEventListener('click', () => app.fitView());
        $('#zoomValue').addEventListener('click', () => {
            if (Math.abs(app.view.scale - 1) < 0.005) app.fitView();
            else app.zoomTo(1, app.visibleCenter(), { animate: true });
        });
    }

    syncZoom() {
        // Runs on every pan frame; only touch the DOM when the label changes.
        const s = this.app.view.scale * 100;
        const text = `${s < 10 ? s.toFixed(1) : Math.round(s)}%`;
        const el = $('#zoomValue');
        if (el.textContent !== text) el.textContent = text;
    }

    // -------------------------------------------------- desktop side panel

    bindPanelResize() {
        const handle = $('#panelResizer');
        const setWidth = (w, save = false) => {
            const width = clamp(Math.round(w), PANEL_MIN, PANEL_MAX);
            this.root.style.setProperty('--panel-w', `${width}px`);
            handle.setAttribute('aria-valuenow', String(width));
            if (save) settings.set('panelWidth', width);
            return width;
        };
        setWidth(settings.get('panelWidth', PANEL_DEFAULT));
        handle.setAttribute('aria-valuemin', String(PANEL_MIN));
        handle.setAttribute('aria-valuemax', String(PANEL_MAX));

        handle.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            const startX = e.clientX;
            const startW = this.panel.getBoundingClientRect().width;
            handle.classList.add('active');
            document.body.classList.add('is-resizing');
            trackPointer(handle, e.pointerId, {
                move: (ev) => setWidth(startW - (ev.clientX - startX)),
                end: () => {
                    handle.classList.remove('active');
                    document.body.classList.remove('is-resizing');
                    setWidth(this.panel.getBoundingClientRect().width, true);
                }
            });
        });
        handle.addEventListener('dblclick', () => setWidth(PANEL_DEFAULT, true));
        handle.addEventListener('keydown', (e) => {
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
            e.preventDefault();
            const cur = this.panel.getBoundingClientRect().width;
            setWidth(cur + (e.key === 'ArrowLeft' ? 16 : -16), true);
        });
    }

    // ------------------------------------------------------- phone sheet

    bindSheet() {
        for (const b of $$('#bottomNav [data-tab]')) {
            b.addEventListener('click', () => {
                if (this.tab === b.dataset.tab) this.closeSheet();
                else this.openTab(b.dataset.tab);
            });
        }
        $('#bottomNav [data-nav-tool="crop"]').addEventListener('click', () => {
            this.app.setTool(this.app.tool === 'crop' ? 'move' : 'crop');
        });

        const onQuery = () => {
            this.isPhone = this.phoneQuery.matches;
            this.root.classList.toggle('is-phone', this.isPhone);
            if (!this.isPhone) {
                this.tab = null;
                this.root.dataset.tab = '';
                this.panel.style.removeProperty('height');
            } else {
                this.closeSheet();
            }
            this.updateInsets();
        };
        this.phoneQuery.addEventListener('change', onQuery);
        this.sideSheetQuery.addEventListener('change', () => this.updateInsets());
        onQuery();

        // Keep the canvas framed above the sheet as it resizes.
        const insetsObserver = new ResizeObserver(() => this.updateInsets());
        insetsObserver.observe(this.panel);
        insetsObserver.observe($('#cropBar'));

        // Drag the grabber to resize; drag far enough down to close.
        const grabber = $('#sheetGrabber');
        grabber.addEventListener('pointerdown', (e) => {
            if (!this.isPhone || !this.tab) return;
            e.preventDefault();
            const startY = e.clientY;
            const startH = this.panel.getBoundingClientRect().height;
            const maxH = window.innerHeight * 0.85;
            this.panel.classList.add('dragging');
            let h = startH;
            trackPointer(grabber, e.pointerId, {
                move: (ev) => {
                    h = clamp(startH - (ev.clientY - startY), 0, maxH);
                    this.panel.style.height = `${h}px`;
                },
                end: () => {
                    this.panel.classList.remove('dragging');
                    if (h < 150) {
                        this.closeSheet();
                        this.panel.style.removeProperty('height');
                    } else {
                        this.panel.style.height = `${Math.max(220, h)}px`;
                    }
                }
            });
        });
    }

    openTab(tab) {
        const app = this.app;
        if ((tab === 'adjust' || tab === 'transform') && !app.selected && app.layers.length) app.select(app.layers[0].id);
        if (app.tool === 'crop') app.setTool('move');
        this.tab = tab;
        this.root.dataset.tab = tab;
        this.syncNav();
        this.updateInsets();
        const scroller = $('#props');
        if (scroller) scroller.scrollTop = 0;
    }

    closeSheet() {
        if (!this.tab) return;
        this.tab = null;
        this.root.dataset.tab = '';
        this.syncNav();
        this.updateInsets();
    }

    syncNav() {
        const has = this.app.layers.length > 0;
        for (const b of $$('#bottomNav [data-tab]')) {
            b.setAttribute('aria-pressed', String(this.tab === b.dataset.tab));
            if (b.dataset.tab === 'adjust' || b.dataset.tab === 'transform') b.disabled = !has;
        }
        const crop = $('#bottomNav [data-nav-tool="crop"]');
        crop.disabled = !has;
        crop.setAttribute('aria-pressed', String(this.app.tool === 'crop'));
    }

    /** Tell the view which parts of the viewport are covered by floating UI. */
    updateInsets() {
        const insets = { top: 0, right: 0, bottom: 0, left: 0 };
        // Keep the fitted canvas clear of the floating zoom pill on phones.
        if (this.isPhone) insets.top = 36;
        if (this.isPhone && this.tab) {
            // Landscape phones show the sheet as a side panel so the canvas stays visible.
            const r = this.panel.getBoundingClientRect();
            if (this.sideSheetQuery.matches) insets.right = Math.round(r.width);
            else insets.bottom = Math.round(r.height);
        }
        const bar = $('#cropBar');
        if (this.app.tool === 'crop' && !bar.hidden) {
            const h = bar.getBoundingClientRect().height + 16;
            if (this.isPhone) insets.bottom += h;
            else insets.top += h;
        }
        this.app.setInsets(insets);
    }
}
