// Reusable form controls: slider rows, scrubbable number fields, segmented buttons.

import { h, icon } from './dom.js';

const decimals = (step) => {
    const s = String(step);
    return s.includes('.') ? s.split('.')[1].length : 0;
};

const snap = (v, min, max, step) => {
    const clamped = Math.min(max, Math.max(min, v));
    const snapped = Math.round((clamped - min) / step) * step + min;
    return Number(snapped.toFixed(decimals(step)));
};

/**
 * Drag horizontally on `handle` to change a value (Figma-style scrubbing).
 * Only mouse/pen — on touch the gesture would fight with scrolling.
 */
export function attachScrub(handle, { get, set, commit, step = 1, perPixel = step }) {
    handle.classList.add('scrubbable');
    handle.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'touch' || e.button !== 0) return;
        const startX = e.clientX;
        const startV = get();
        let moved = false;
        handle.setPointerCapture(e.pointerId);
        const move = (ev) => {
            const dx = ev.clientX - startX;
            if (!moved && Math.abs(dx) < 3) return;
            if (!moved) document.body.classList.add('is-scrubbing');
            moved = true;
            const mult = ev.shiftKey ? 10 : ev.altKey ? 0.1 : 1;
            set(startV + dx * perPixel * mult);
        };
        const up = (ev) => {
            handle.removeEventListener('pointermove', move);
            handle.removeEventListener('pointerup', up);
            handle.removeEventListener('pointercancel', up);
            document.body.classList.remove('is-scrubbing');
            if (moved) {
                ev.preventDefault();
                commit();
            }
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', up);
        handle.addEventListener('pointercancel', up);
    });
}

/**
 * Labelled range slider with an editable value and a reset button.
 * Callbacks: onInput(value) live, onCommit(value) when the change is final,
 * onStart()/onEnd() bracket a pointer drag.
 */
export function sliderRow({
    id,
    label,
    min,
    max,
    step = 1,
    def = min,
    unit = '',
    fillFrom = def,
    track = '',
    onInput,
    onCommit,
    onStart,
    onEnd,
    resettable = true
}) {
    const range = h('input', { type: 'range', class: `range${track ? ` range-${track}` : ''}`, id, min, max, step });
    const num = h('input', {
        type: 'number',
        class: 'num',
        min,
        max,
        step,
        inputmode: step < 1 || min < 0 ? 'decimal' : 'numeric',
        'aria-label': `${label} value`
    });
    const labelEl = h('label', { class: 'slider-label', for: id }, label);
    const row = h(
        'div',
        { class: 'slider-row', dataset: { key: id } },
        labelEl,
        range,
        h('span', { class: 'num-wrap' }, num, unit ? h('span', { class: 'num-unit', 'aria-hidden': 'true' }, unit) : null)
    );
    let resetBtn = null;
    if (resettable) {
        resetBtn = h('button', { type: 'button', class: 'reset-btn', title: `Reset ${label.toLowerCase()}`, 'aria-label': `Reset ${label.toLowerCase()}` }, icon('reset'));
        row.append(resetBtn);
    }

    let value = def;
    const paint = () => {
        const span = max - min || 1;
        const a = (Math.min(fillFrom, value) - min) / span;
        const b = (Math.max(fillFrom, value) - min) / span;
        range.style.setProperty('--a', a.toFixed(4));
        range.style.setProperty('--b', b.toFixed(4));
        row.classList.toggle('changed', value !== def);
    };
    const set = (v, { silent = false } = {}) => {
        value = snap(Number(v), min, max, step);
        if (Number(range.value) !== value) range.value = String(value);
        if (document.activeElement !== num || silent) num.value = String(value);
        paint();
        return value;
    };
    const emit = (v, final) => {
        const next = set(v);
        onInput && onInput(next);
        if (final && onCommit) onCommit(next);
    };

    range.addEventListener('input', () => {
        set(range.value);
        num.value = String(value);
        onInput && onInput(value);
    });
    range.addEventListener('change', () => {
        onCommit && onCommit(value);
    });
    range.addEventListener('pointerdown', () => {
        onStart && onStart();
        const startValue = value;
        let changed = false;
        const onChange = () => {
            changed = true;
        };
        range.addEventListener('change', onChange);
        const end = () => {
            window.removeEventListener('pointerup', end, true);
            window.removeEventListener('pointercancel', end, true);
            onEnd && onEnd();
            // A drag the browser cancels (e.g. to scroll) never fires `change`.
            setTimeout(() => {
                range.removeEventListener('change', onChange);
                if (!changed && value !== startValue && onCommit) onCommit(value);
            }, 0);
        };
        window.addEventListener('pointerup', end, true);
        window.addEventListener('pointercancel', end, true);
    });
    num.addEventListener('change', () => {
        const parsed = parseFloat(num.value);
        if (Number.isFinite(parsed)) emit(parsed, true);
        num.value = String(value);
    });
    num.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') num.blur();
        if (e.key === 'Escape') {
            num.value = String(value);
            num.blur();
        }
    });
    num.addEventListener('focus', () => num.select());
    num.addEventListener('blur', () => {
        num.value = String(value);
    });
    if (resetBtn) resetBtn.addEventListener('click', () => emit(def, true));
    labelEl.addEventListener('dblclick', () => emit(def, true));

    attachScrub(labelEl, {
        get: () => value,
        set: (v) => emit(v, false),
        commit: () => onCommit && onCommit(value),
        step,
        perPixel: Math.max(step, (max - min) / 240)
    });

    set(def);
    return {
        el: row,
        range,
        set,
        get value() {
            return value;
        }
    };
}

/** Compact labelled number input (e.g. X / Y / W / H). */
export function numberField({ label, title = label, unit = '', step = 1, min = -Infinity, max = Infinity, onChange, scrubStep = step }) {
    const input = h('input', { type: 'number', class: 'num', step, inputmode: 'decimal', 'aria-label': title });
    if (Number.isFinite(min)) input.min = String(min);
    if (Number.isFinite(max)) input.max = String(max);
    const tag = h('span', { class: 'num-field-label', title, 'aria-hidden': 'true' }, label);
    const el = h('label', { class: 'num-field' }, tag, input, unit ? h('span', { class: 'num-unit', 'aria-hidden': 'true' }, unit) : null);
    let value = 0;
    const fmt = (v) => String(Number(v.toFixed(decimals(step))));
    const set = (v) => {
        value = v;
        if (document.activeElement !== input) input.value = fmt(v);
    };
    const apply = (v, commit) => {
        const next = Math.min(max, Math.max(min, v));
        value = next;
        input.value = fmt(next);
        onChange(next, commit);
    };
    input.addEventListener('change', () => {
        const parsed = parseFloat(input.value);
        if (Number.isFinite(parsed)) apply(parsed, true);
        else input.value = fmt(value);
    });
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') input.blur();
        if (e.key === 'Escape') {
            input.value = fmt(value);
            input.blur();
        }
    });
    input.addEventListener('focus', () => input.select());
    input.addEventListener('blur', () => {
        input.value = fmt(value);
    });
    attachScrub(tag, {
        get: () => value,
        set: (v) => apply(v, false),
        commit: () => onChange(value, true),
        step: scrubStep
    });
    return { el, input, set };
}

/** Wire a group of `[data-value]` buttons as a single-choice segmented control. */
export function segmented(container, onChange) {
    const buttons = [...container.querySelectorAll('[data-value]')];
    const select = (val, notify = true) => {
        for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.value === String(val)));
        if (notify) onChange(val);
    };
    container.addEventListener('click', (e) => {
        const b = e.target.closest('[data-value]');
        if (!b || b.disabled || !container.contains(b)) return;
        select(b.dataset.value);
    });
    container.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        const enabled = buttons.filter((b) => !b.disabled);
        const i = enabled.findIndex((b) => b.getAttribute('aria-pressed') === 'true');
        const next = enabled[(i + (e.key === 'ArrowRight' ? 1 : -1) + enabled.length) % enabled.length];
        if (next) {
            e.preventDefault();
            next.focus();
            select(next.dataset.value);
        }
    });
    return { select, buttons };
}
