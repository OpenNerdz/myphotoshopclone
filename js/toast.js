// Accessible toast notifications with optional action (e.g. "Undo").

import { h, icon } from './dom.js';

const ICONS = { info: 'info', success: 'check', error: 'alert' };

let region = null;

function getRegion() {
    if (!region) region = document.getElementById('toasts');
    return region;
}

/**
 * @param {string} message
 * @param {{type?: 'info'|'success'|'error', action?: {label: string, run: Function},
 *          duration?: number, spinner?: boolean}} opts  duration 0 = sticky
 */
export function toast(message, { type = 'info', action = null, duration = 3600, spinner = false } = {}) {
    const root = getRegion();
    const text = h('span', { class: 'toast-text' }, message);
    const lead = spinner ? h('span', { class: 'spinner', 'aria-hidden': 'true' }) : icon(ICONS[type] || 'info', 'icon toast-icon');
    const el = h('div', { class: `toast toast-${type}`, role: type === 'error' ? 'alert' : 'status' }, lead, text);

    let timer = 0;
    const close = () => {
        clearTimeout(timer);
        if (!el.isConnected || el.classList.contains('leaving')) return;
        el.classList.add('leaving');
        el.addEventListener('animationend', () => el.remove(), { once: true });
        setTimeout(() => el.remove(), 400);
    };

    if (action) {
        el.append(
            h(
                'button',
                {
                    class: 'toast-action',
                    type: 'button',
                    onclick: () => {
                        close();
                        action.run();
                    }
                },
                action.label
            )
        );
    }
    el.append(h('button', { class: 'toast-close', type: 'button', 'aria-label': 'Dismiss', onclick: close }, icon('x')));

    root.append(el);
    // Keep at most four toasts on screen.
    while (root.children.length > 4) root.firstElementChild.remove();

    const arm = (ms) => {
        clearTimeout(timer);
        if (ms > 0) timer = setTimeout(close, ms);
    };
    arm(duration);
    el.addEventListener('pointerenter', () => clearTimeout(timer));
    el.addEventListener('pointerleave', () => arm(duration ? 1600 : 0));

    return {
        close,
        update(next, nextOpts = {}) {
            text.textContent = next;
            if (nextOpts.type) {
                el.className = `toast toast-${nextOpts.type}`;
                const newLead = icon(ICONS[nextOpts.type] || 'info', 'icon toast-icon');
                el.firstElementChild.replaceWith(newLead);
            }
            if (nextOpts.duration !== undefined) arm(nextOpts.duration);
        }
    };
}
