// Modal dialogs: export, keyboard shortcuts and confirmation.

import { $, $$, h, settings, modKey } from './dom.js';
import { FORMATS, exportSize, exportFits, renderComposite, canvasToBlob, downloadBlob, safeFilename } from './exporter.js';
import { sliderRow, segmented } from './controls.js';
import { toast } from './toast.js';

function wireBackdropClose(dlg) {
    dlg.addEventListener('click', (e) => {
        if (e.target === dlg) dlg.close('cancel');
    });
}

export class ExportDialog {
    constructor(app) {
        this.app = app;
        this.dlg = $('#exportDialog');
        this.name = $('#exportName');
        this.preview = $('#exportPreview');
        this.format = FORMATS[settings.get('exportFormat')] ? settings.get('exportFormat') : 'image/png';
        this.quality = settings.get('exportQuality', 92);
        this.scale = 1;
        this.busy = false;
        this.previewToken = 0;

        this.formatSeg = segmented($('#exportFormat'), (v) => {
            this.format = v;
            settings.set('exportFormat', v);
            this.sync();
        });
        this.scaleSeg = segmented($('#exportScale'), (v) => {
            this.scale = Number(v);
            this.sync();
        });
        this.qualityRow = sliderRow({
            id: 'exportQuality',
            label: 'Quality',
            min: 10,
            max: 100,
            def: 92,
            fillFrom: 10,
            unit: '%',
            resettable: false,
            onInput: (v) => {
                this.quality = v;
            },
            onCommit: (v) => settings.set('exportQuality', v)
        });
        this.qualityRow.set(this.quality);
        $('#exportQualityField').append(this.qualityRow.el);

        $('#exportDownload').addEventListener('click', () => this.run('download'));
        $('#exportShare').addEventListener('click', () => this.run('share'));
        $('#exportCopy').addEventListener('click', () => this.run('copy'));
        this.name.addEventListener('keydown', (e) => {
            // Enter would submit the form via the first submit button (close).
            if (e.key === 'Enter') {
                e.preventDefault();
                this.run('download');
            }
        });
        wireBackdropClose(this.dlg);

        this.canShare = (() => {
            try {
                return Boolean(navigator.canShare && navigator.canShare({ files: [new File([new Blob(['x'])], 'x.png', { type: 'image/png' })] }));
            } catch {
                return false;
            }
        })();
        this.canCopy = Boolean(window.isSecureContext && navigator.clipboard && navigator.clipboard.write && window.ClipboardItem);
        $('#exportShare').hidden = !this.canShare;
        $('#exportCopy').hidden = !this.canCopy;
    }

    open() {
        const app = this.app;
        if (!app.layers.length || this.dlg.open) return;
        if (!this.name.value) this.name.value = app.layers.length === 1 ? app.layers[0].name : 'composition';
        this.formatSeg.select(this.format, false);
        if (!exportFits(app.doc, this.scale)) this.scale = [1, 0.5, 0.25].find((s) => exportFits(app.doc, s)) || 0.25;
        this.scaleSeg.select(String(this.scale), false);
        this.sync();
        this.dlg.showModal();
        this.renderPreview();
    }

    sync() {
        const doc = this.app.doc;
        const fmt = FORMATS[this.format];
        $('#exportExt').textContent = `.${fmt.ext}`;
        $('#exportQualityField').hidden = !fmt.lossy;
        for (const b of this.scaleSeg.buttons) b.disabled = !exportFits(doc, Number(b.dataset.value));
        const { w, h: hh } = exportSize(doc, this.scale);
        $('#exportDims').textContent = `${w.toLocaleString('en-US')} × ${hh.toLocaleString('en-US')} px`;
        let note = '';
        if (!fmt.alpha && !doc.background) note = 'JPEG has no transparency, so transparent areas become white.';
        else if (fmt.alpha && !doc.background && this.format === 'image/png') note = 'Transparent areas are preserved.';
        $('#exportNote').textContent = note;
    }

    async renderPreview() {
        const token = ++this.previewToken;
        const doc = this.app.doc;
        const scale = Math.min(1, 560 / Math.max(doc.width, doc.height));
        try {
            const c = await renderComposite(this.app.state, this.app.assets, { scale });
            if (token !== this.previewToken) return;
            this.preview.width = c.width;
            this.preview.height = c.height;
            this.preview.getContext('2d').drawImage(c, 0, 0);
            c.width = 0;
        } catch (err) {
            console.warn('Preview failed', err);
        }
    }

    async renderBlob(type) {
        const fmt = FORMATS[type];
        const canvas = await renderComposite(this.app.state, this.app.assets, {
            scale: this.scale,
            background: fmt.alpha ? null : '#ffffff'
        });
        try {
            return await canvasToBlob(canvas, type, fmt.lossy ? this.quality / 100 : undefined);
        } finally {
            canvas.width = 0;
        }
    }

    setBusy(on, mode) {
        this.busy = on;
        for (const b of $$('.dialog-foot .btn', this.dlg)) {
            b.disabled = on;
            b.classList.toggle('is-loading', on && b.id === `export${mode[0].toUpperCase()}${mode.slice(1)}`);
        }
    }

    async run(mode) {
        if (this.busy) return;
        this.setBusy(true, mode);
        const base = safeFilename(this.name.value, 'composition');
        try {
            if (mode === 'copy') {
                // Pass the promise straight to ClipboardItem so Safari keeps the user gesture.
                const blob = this.renderBlob('image/png');
                await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
                toast('Copied to clipboard as PNG', { type: 'success' });
                return;
            }
            const requested = this.format;
            const blob = await this.renderBlob(requested);
            let fmt = FORMATS[requested];
            if (blob.type && blob.type !== requested) {
                const actual = FORMATS[blob.type] || FORMATS['image/png'];
                toast(`${fmt.label} export isn’t supported by this browser, so it was saved as ${actual.label}.`);
                fmt = actual;
            }
            const filename = `${base}.${fmt.ext}`;
            if (mode === 'share') {
                await this.share(blob, filename);
            } else {
                downloadBlob(blob, filename);
                toast(`Saved ${filename}`, { type: 'success' });
            }
            this.dlg.close('done');
        } catch (err) {
            if (err && err.name === 'AbortError') return;
            console.error(err);
            toast(`Export failed${err && err.message ? `: ${err.message}` : ''}`, { type: 'error', duration: 6000 });
        } finally {
            this.setBusy(false, mode);
        }
    }

    async share(blob, filename) {
        const file = new File([blob], filename, { type: blob.type });
        try {
            await navigator.share({ files: [file], title: filename });
        } catch (err) {
            // Large renders can outlive the user gesture; offer a fresh tap.
            if (err && err.name === 'NotAllowedError') {
                toast('Your image is ready', {
                    duration: 0,
                    action: { label: 'Share', run: () => navigator.share({ files: [file], title: filename }).catch(() => {}) }
                });
                return;
            }
            throw err;
        }
    }
}

const SHORTCUTS = () => [
    [
        'General',
        [
            [['I'], 'Add images'],
            [[modKey, 'V'], 'Paste image'],
            [[modKey, 'Z'], 'Undo'],
            [[modKey, 'Shift', 'Z'], 'Redo'],
            [[modKey, 'S'], 'Export'],
            [['?'], 'Show shortcuts']
        ]
    ],
    [
        'Tools',
        [
            [['V'], 'Move tool'],
            [['H'], 'Hand tool'],
            [['Space'], 'Pan while held'],
            [['C'], 'Crop canvas'],
            [['Enter'], 'Apply crop'],
            [['Esc'], 'Cancel crop / deselect']
        ]
    ],
    [
        'Layers',
        [
            [['←', '↑', '→', '↓'], 'Nudge 1 px (Shift: 10 px)'],
            [[modKey, 'D'], 'Duplicate layer'],
            [['Del'], 'Delete layer'],
            [[modKey, ']'], 'Bring forward (Shift: to front)'],
            [[modKey, '['], 'Send backward (Shift: to back)'],
            [['A'], 'Fit all layers to canvas'],
            [['F2'], 'Rename (in layer list)']
        ]
    ],
    [
        'View & transform',
        [
            [[modKey, '0'], 'Fit canvas to screen'],
            [[modKey, '1'], 'Actual pixels (100%)'],
            [[modKey, '+'], 'Zoom in'],
            [[modKey, '−'], 'Zoom out'],
            [[modKey, 'Scroll'], 'Zoom at pointer'],
            [['Shift'], 'Constrain move · free scale · snap rotation'],
            [['Alt'], 'Scale from centre'],
            [[modKey], 'Hold while moving to disable snapping']
        ]
    ]
];

let shortcutsBuilt = false;

export function openShortcuts() {
    const dlg = $('#shortcutsDialog');
    if (!shortcutsBuilt) {
        shortcutsBuilt = true;
        const body = $('#shortcutsBody');
        for (const [title, rows] of SHORTCUTS()) {
            body.append(
                h(
                    'section',
                    { class: 'shortcut-group' },
                    h('h3', {}, title),
                    h(
                        'dl',
                        {},
                        rows.map(([keys, label]) => [
                            h('dt', {}, keys.map((k, i) => [i ? h('span', { class: 'plus' }, '+') : null, h('kbd', {}, k)])),
                            h('dd', {}, label)
                        ])
                    )
                )
            );
        }
        wireBackdropClose(dlg);
    }
    if (!dlg.open) dlg.showModal();
}

/** Promise-based replacement for window.confirm(). */
export function confirmDialog({ title, message = '', confirmLabel = 'OK', danger = false }) {
    const dlg = $('#confirmDialog');
    $('#confirmTitle').textContent = title;
    $('#confirmMessage').textContent = message;
    const ok = $('#confirmOk');
    ok.textContent = confirmLabel;
    ok.classList.toggle('btn-danger', danger);
    ok.classList.toggle('btn-primary', !danger);
    if (!dlg.dataset.wired) {
        dlg.dataset.wired = '1';
        wireBackdropClose(dlg);
    }
    return new Promise((resolve) => {
        dlg.returnValue = '';
        dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true });
        dlg.showModal();
        ok.focus();
    });
}
