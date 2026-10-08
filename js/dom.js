// Small DOM helpers shared by the UI modules.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Inline icon referencing the sprite in index.html. */
export function icon(name, className = 'icon') {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', className);
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.appendChild(use);
    return svg;
}

/** Tiny element factory: h('button', { class: 'x', onclick }, 'Label'). */
export function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (v === true) el.setAttribute(k, '');
        else el.setAttribute(k, String(v));
    }
    for (const c of children.flat()) {
        if (c == null || c === false) continue;
        el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
}

export function isTypingTarget(el) {
    if (!el || el === document.body) return false;
    if (el.isContentEditable) return true;
    const tag = el.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag !== 'INPUT') return false;
    const type = (el.type || '').toLowerCase();
    return !['range', 'checkbox', 'radio', 'button', 'submit', 'color', 'file'].includes(type);
}

export const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
export const modKey = isMac ? '⌘' : 'Ctrl';

export const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export const settings = {
    get(key, fallback = null) {
        try {
            const raw = localStorage.getItem(`ios:${key}`);
            return raw == null ? fallback : JSON.parse(raw);
        } catch {
            return fallback;
        }
    },
    set(key, value) {
        try {
            localStorage.setItem(`ios:${key}`, JSON.stringify(value));
        } catch {
            /* storage unavailable (private mode / quota) — settings are optional */
        }
    }
};

export function debounce(fn, ms) {
    let t = 0;
    const wrapped = (...args) => {
        clearTimeout(t);
        t = setTimeout(() => fn(...args), ms);
    };
    wrapped.flush = (...args) => {
        clearTimeout(t);
        fn(...args);
    };
    wrapped.cancel = () => clearTimeout(t);
    return wrapped;
}

let uidCounter = 0;
export const uid = (prefix) => `${prefix}_${Date.now().toString(36)}${(uidCounter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export const formatInt = (v) => Math.round(v).toLocaleString('en-US');

export const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
