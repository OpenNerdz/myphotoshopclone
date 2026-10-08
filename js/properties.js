// Properties panel: layer appearance, transform, adjustments and canvas settings.

import { $, $$, h, icon, settings } from './dom.js';
import { FILTER_DEFS, PRESETS, presetFilters, filterKey, defaultFilters, cssFilter, blurRadius, BLEND_MODES } from './filters.js';
import { layerBounds, layerSize, normalizeAngle } from './geometry.js';
import { sliderRow, numberField, segmented } from './controls.js';

export class PropertiesPanel {
    constructor(app) {
        this.app = app;
        this.root = $('#props');
        this.aspectLocked = true;
        this.docAspectLocked = false;
        this.presetThumbAsset = null;

        this.buildAppearance();
        this.buildTransform();
        this.buildAdjustments();
        this.buildCanvas();
        this.bindSections();

        app.on('selection', () => this.sync());
        app.on('structure', () => this.sync());
        app.on('doc', () => this.syncDoc());
        app.on('layer', (l) => {
            if (l.id === app.state.selectedId) this.syncLayer(l);
        });
    }

    get layer() {
        return this.app.selected;
    }

    /** Slider callbacks shared by every live-preview control. */
    interaction() {
        return {
            onStart: () => {
                this.app.interacting = true;
            },
            onEnd: () => {
                this.app.interacting = false;
                this.app.requestRender();
            }
        };
    }

    // ------------------------------------------------------------ builders

    buildAppearance() {
        const app = this.app;
        this.opacity = sliderRow({
            id: 'p-opacity',
            label: 'Opacity',
            min: 0,
            max: 100,
            def: 100,
            fillFrom: 0,
            unit: '%',
            ...this.interaction(),
            onInput: (v) => this.layer && app.updateLayer(this.layer.id, { opacity: v / 100 }),
            onCommit: () => this.layer && app.commit('Opacity', `opacity:${this.layer.id}`)
        });
        $('#appearanceRows').append(this.opacity.el);

        const select = $('#blendSelect');
        let group = null;
        for (const b of BLEND_MODES) {
            if (b.group) {
                group = h('optgroup', { label: b.group });
                select.append(group);
            } else {
                (group || select).append(h('option', { value: b.value }, b.label));
            }
        }
        select.addEventListener('change', () => {
            if (this.layer) app.updateLayer(this.layer.id, { blend: select.value }, { commit: 'Blend mode' });
        });
        this.blend = select;
    }

    buildTransform() {
        const app = this.app;
        const grid = $('#transformFields');
        const commitKey = (what) => `${what}:${this.layer && this.layer.id}`;

        // X / Y show the bounding box's top-left corner; the layer itself is positioned by its centre.
        const move = (axis) => (v, commit) => {
            const l = this.layer;
            if (!l) return;
            app.updateLayer(l.id, { [axis]: l[axis] + (v - layerBounds(l)[axis]) }, commit ? { commit: 'Move layer', key: commitKey('pos') } : {});
        };
        this.fx = numberField({ label: 'X', title: 'X position (left edge)', unit: 'px', onChange: move('x') });
        this.fy = numberField({ label: 'Y', title: 'Y position (top edge)', unit: 'px', onChange: move('y') });
        const resize = (axis) => (v, commit) => {
            const l = this.layer;
            if (!l || v <= 0) return;
            const patch = {};
            if (axis === 'w') {
                patch.scaleX = v / l.width;
                if (this.aspectLocked) patch.scaleY = l.scaleY * (patch.scaleX / l.scaleX);
            } else {
                patch.scaleY = v / l.height;
                if (this.aspectLocked) patch.scaleX = l.scaleX * (patch.scaleY / l.scaleY);
            }
            app.updateLayer(l.id, patch, commit ? { commit: 'Resize layer', key: commitKey('size') } : {});
        };
        this.fw = numberField({ label: 'W', title: 'Width', unit: 'px', min: 1, onChange: resize('w') });
        this.fh = numberField({ label: 'H', title: 'Height', unit: 'px', min: 1, onChange: resize('h') });
        this.linkBtn = this.makeLinkButton('Lock aspect ratio', () => {
            this.aspectLocked = !this.aspectLocked;
            this.syncLink(this.linkBtn, this.aspectLocked);
        });
        this.syncLink(this.linkBtn, this.aspectLocked);
        grid.append(this.fx.el, this.fy.el, h('span'), this.fw.el, this.fh.el, this.linkBtn);

        this.rotation = sliderRow({
            id: 'p-rotation',
            label: 'Rotate',
            min: -180,
            max: 180,
            def: 0,
            unit: '°',
            ...this.interaction(),
            onInput: (v) => this.layer && app.updateLayer(this.layer.id, { rotation: normalizeAngle(v) }),
            onCommit: () => this.layer && app.commit('Rotate layer', commitKey('rotate'))
        });
        $('#rotationRow').append(this.rotation.el);

        this.flipButtons = $$('[data-transform="flip-h"], [data-transform="flip-v"]');
        for (const btn of $$('[data-transform]')) {
            btn.addEventListener('click', () => {
                const l = this.layer;
                if (!l) return;
                switch (btn.dataset.transform) {
                    case 'rotate-ccw':
                        return app.rotateBy(l.id, -90);
                    case 'rotate-cw':
                        return app.rotateBy(l.id, 90);
                    case 'flip-h':
                        return app.flip(l.id, 'h');
                    case 'flip-v':
                        return app.flip(l.id, 'v');
                    case 'fit':
                        return app.fitLayer(l.id, 'contain');
                    case 'fill':
                        return app.fitLayer(l.id, 'cover');
                    case 'center':
                        return app.centerLayer(l.id);
                    case 'reset':
                        return app.resetTransform(l.id);
                }
            });
        }
    }

    makeLinkButton(label, onClick) {
        return h('button', { type: 'button', class: 'link-btn', title: label, 'aria-label': label, onclick: onClick }, icon('link'));
    }

    syncLink(btn, on) {
        btn.setAttribute('aria-pressed', String(on));
        btn.querySelector('use').setAttribute('href', on ? '#i-link' : '#i-unlink');
    }

    buildAdjustments() {
        const app = this.app;
        const presets = $('#presets');
        // Preset thumbnails are previewed with CSS filters, which only depend on the preset.
        this.presetButtons = PRESETS.map((p) => {
            const filters = presetFilters(p);
            const css = cssFilter(filters, blurRadius(filters, 48));
            const img = h('img', { alt: '', draggable: 'false', decoding: 'async' });
            if (css !== 'none') img.style.filter = css;
            const btn = h(
                'button',
                { type: 'button', class: 'preset', 'aria-pressed': 'false', dataset: { id: p.id } },
                h('span', { class: 'preset-thumb' }, img),
                h('span', { class: 'preset-name' }, p.name)
            );
            btn.addEventListener('click', () => {
                if (this.layer) app.updateLayer(this.layer.id, { filters: presetFilters(p) }, { commit: `${p.name} preset` });
            });
            presets.append(btn);
            return { key: filterKey(filters), btn, img };
        });

        const rows = $('#adjustRows');
        this.filterRows = {};
        for (const def of FILTER_DEFS) {
            const row = sliderRow({
                id: `f-${def.key}`,
                label: def.label,
                min: def.min,
                max: def.max,
                step: def.step || 1,
                def: def.def,
                unit: def.unit,
                track: def.track || '',
                ...this.interaction(),
                onInput: (v) => {
                    if (!this.layer) return;
                    app.updateLayer(this.layer.id, { filters: { [def.key]: v } });
                },
                onCommit: () => this.layer && app.commit(def.label, `filter:${def.key}:${this.layer.id}`)
            });
            this.filterRows[def.key] = row;
            rows.append(row.el);
        }
        $('#resetAdjustBtn').addEventListener('click', () => {
            if (this.layer) app.updateLayer(this.layer.id, { filters: defaultFilters() }, { commit: 'Reset adjustments' });
        });
    }

    buildCanvas() {
        const app = this.app;
        const apply = (axis) => (v, commit) => {
            if (!commit) return;
            const d = app.doc;
            let w = axis === 'w' ? v : d.width;
            let hgt = axis === 'h' ? v : d.height;
            if (this.docAspectLocked) {
                if (axis === 'w') hgt = Math.round((v * d.height) / d.width);
                else w = Math.round((v * d.width) / d.height);
            }
            app.resizeDoc(w, hgt);
            this.syncDoc();
        };
        this.dw = numberField({ label: 'W', title: 'Canvas width', unit: 'px', min: 1, max: 16384, onChange: apply('w') });
        this.dh = numberField({ label: 'H', title: 'Canvas height', unit: 'px', min: 1, max: 16384, onChange: apply('h') });
        this.docLink = this.makeLinkButton('Lock canvas aspect ratio', () => {
            this.docAspectLocked = !this.docAspectLocked;
            this.syncLink(this.docLink, this.docAspectLocked);
        });
        this.syncLink(this.docLink, this.docAspectLocked);
        $('#docFields').append(this.dw.el, this.dh.el, this.docLink);

        const preset = $('#docPreset');
        preset.addEventListener('change', () => {
            const [w, hgt] = preset.value.split('x').map(Number);
            if (w && hgt) app.resizeDoc(w, hgt, 'Canvas preset');
            this.syncDoc();
        });

        const color = $('#bgColor');
        this.bgMode = segmented($('#bgMode'), (mode) => {
            app.setBackground(mode === 'color' ? color.value : null);
        });
        color.addEventListener('input', () => {
            app.setBackground(color.value, { commit: false });
            this.bgMode.select('color', false);
        });
        color.addEventListener('change', () => app.setBackground(color.value));
    }

    bindSections() {
        const collapsed = settings.get('collapsedSections', {});
        for (const sec of $$('.psection')) {
            const head = $('.psection-head', sec);
            const name = sec.dataset.section;
            const setOpen = (open) => {
                head.setAttribute('aria-expanded', String(open));
                sec.classList.toggle('collapsed', !open);
            };
            setOpen(!collapsed[name]);
            head.addEventListener('click', () => {
                const open = head.getAttribute('aria-expanded') !== 'true';
                setOpen(open);
                collapsed[name] = !open;
                settings.set('collapsedSections', collapsed);
            });
        }
    }

    // ---------------------------------------------------------------- sync

    sync() {
        const l = this.layer;
        this.root.dataset.mode = l ? 'layer' : 'canvas';
        this.root.toggleAttribute('data-empty', !this.app.layers.length);
        if (l) this.syncLayer(l);
        this.syncDoc();
    }

    syncLayer(l) {
        this.opacity.set(Math.round(l.opacity * 100));
        if (this.blend.value !== l.blend) this.blend.value = l.blend;

        const b = layerBounds(l);
        const { w, h: hh } = layerSize(l);
        this.fx.set(Math.round(b.x));
        this.fy.set(Math.round(b.y));
        this.fw.set(Math.round(w));
        this.fh.set(Math.round(hh));
        this.rotation.set(Math.round(l.rotation * 10) / 10);
        for (const btn of this.flipButtons) {
            btn.setAttribute('aria-pressed', String(btn.dataset.transform === 'flip-h' ? l.flipH : l.flipV));
        }

        for (const def of FILTER_DEFS) this.filterRows[def.key].set(l.filters[def.key]);

        const asset = this.app.assets.get(l.assetId);
        const thumb = asset ? asset.thumb : '';
        const fk = filterKey(l.filters);
        for (const { key, btn, img } of this.presetButtons) {
            if (img.getAttribute('src') !== thumb) img.src = thumb;
            btn.setAttribute('aria-pressed', String(key === fk));
        }
    }

    syncDoc() {
        const d = this.app.doc;
        this.dw.set(d.width);
        this.dh.set(d.height);
        const preset = $('#docPreset');
        const key = `${d.width}x${d.height}`;
        preset.value = [...preset.options].some((o) => o.value === key) ? key : '';
        this.bgMode.select(d.background ? 'color' : 'transparent', false);
        if (d.background) $('#bgColor').value = d.background;
    }
}
