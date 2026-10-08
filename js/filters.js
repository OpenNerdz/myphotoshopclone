// Adjustment definitions, CSS filter strings and an equivalent colour matrix
// (used when the browser's canvas does not support `ctx.filter`, e.g. Safari).
// Pure module — no DOM access.

export const FILTER_DEFS = [
    { key: 'brightness', label: 'Brightness', min: 0, max: 200, def: 100, unit: '%' },
    { key: 'contrast', label: 'Contrast', min: 0, max: 200, def: 100, unit: '%' },
    { key: 'saturation', label: 'Saturation', min: 0, max: 200, def: 100, unit: '%' },
    { key: 'hue', label: 'Hue', min: -180, max: 180, def: 0, unit: '°', track: 'hue' },
    { key: 'blur', label: 'Blur', min: 0, max: 20, def: 0, step: 0.5, unit: '' },
    { key: 'grayscale', label: 'Grayscale', min: 0, max: 100, def: 0, unit: '%' },
    { key: 'sepia', label: 'Sepia', min: 0, max: 100, def: 0, unit: '%' },
    { key: 'invert', label: 'Invert', min: 0, max: 100, def: 0, unit: '%' }
];

const DEFAULTS = Object.freeze(Object.fromEntries(FILTER_DEFS.map((d) => [d.key, d.def])));

export const defaultFilters = () => ({ ...DEFAULTS });

/** Fill in missing keys and clamp values into their valid ranges. */
export function normalizeFilters(f) {
    f = f && typeof f === 'object' ? f : {};
    const out = {};
    for (const d of FILTER_DEFS) {
        const v = Number(f[d.key]);
        out[d.key] = Number.isFinite(v) ? Math.min(d.max, Math.max(d.min, v)) : d.def;
    }
    return out;
}

export function isIdentity(f) {
    for (const d of FILTER_DEFS) {
        if ((f[d.key] ?? d.def) !== d.def) return false;
    }
    return true;
}

export function filterKey(f) {
    return FILTER_DEFS.map((d) => f[d.key] ?? d.def).join('|');
}

/**
 * Blur is stored relative to the image so it looks identical at any zoom level
 * and export size: `blur` units are pixels per 1000px of the image's long side.
 */
export const blurRadius = (f, longestSide) => ((f.blur || 0) * longestSide) / 1000;

/** CSS filter string for the given adjustments; `blurPx` is resolution-specific. */
export function cssFilter(f, blurPx = 0) {
    const parts = [];
    if (f.brightness !== 100) parts.push(`brightness(${f.brightness}%)`);
    if (f.contrast !== 100) parts.push(`contrast(${f.contrast}%)`);
    if (f.saturation !== 100) parts.push(`saturate(${f.saturation}%)`);
    if (f.hue) parts.push(`hue-rotate(${f.hue}deg)`);
    if (f.grayscale) parts.push(`grayscale(${f.grayscale}%)`);
    if (f.sepia) parts.push(`sepia(${f.sepia}%)`);
    if (f.invert) parts.push(`invert(${f.invert}%)`);
    if (blurPx > 0) parts.push(`blur(${Math.round(blurPx * 100) / 100}px)`);
    return parts.length ? parts.join(' ') : 'none';
}

// ---- Colour matrices (Filter Effects spec), 3 rows × 4 columns [r g b offset], 0..1 domain.

const scaleMatrix = (s, offset = 0) => [s, 0, 0, offset, 0, s, 0, offset, 0, 0, s, offset];

function saturateMatrix(s) {
    return [
        0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s, 0,
        0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s, 0,
        0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s, 0
    ];
}

function hueMatrix(deg) {
    const a = (deg * Math.PI) / 180;
    const c = Math.cos(a);
    const s = Math.sin(a);
    return [
        0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928, 0,
        0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.14, 0.072 - c * 0.072 - s * 0.283, 0,
        0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072, 0
    ];
}

function grayscaleMatrix(amount) {
    const g = 1 - Math.min(1, amount);
    return [
        0.2126 + 0.7874 * g, 0.7152 - 0.7152 * g, 0.0722 - 0.0722 * g, 0,
        0.2126 - 0.2126 * g, 0.7152 + 0.2848 * g, 0.0722 - 0.0722 * g, 0,
        0.2126 - 0.2126 * g, 0.7152 - 0.7152 * g, 0.0722 + 0.9278 * g, 0
    ];
}

function sepiaMatrix(amount) {
    const g = 1 - Math.min(1, amount);
    return [
        0.393 + 0.607 * g, 0.769 - 0.769 * g, 0.189 - 0.189 * g, 0,
        0.349 - 0.349 * g, 0.686 + 0.314 * g, 0.168 - 0.168 * g, 0,
        0.272 - 0.272 * g, 0.534 - 0.534 * g, 0.131 + 0.869 * g, 0
    ];
}

/**
 * The colour matrices for each active adjustment, in CSS filter order. CSS
 * clamps to [0, 1] after every function, so they must be applied one by one
 * (composing them into a single matrix drifts once values leave the range).
 */
export function colorSteps(f) {
    const steps = [];
    if (f.brightness !== 100) steps.push(scaleMatrix(f.brightness / 100));
    if (f.contrast !== 100) {
        const c = f.contrast / 100;
        steps.push(scaleMatrix(c, 0.5 - 0.5 * c));
    }
    if (f.saturation !== 100) steps.push(saturateMatrix(f.saturation / 100));
    if (f.hue) steps.push(hueMatrix(f.hue));
    if (f.grayscale) steps.push(grayscaleMatrix(f.grayscale / 100));
    if (f.sepia) steps.push(sepiaMatrix(f.sepia / 100));
    if (f.invert) {
        const a = Math.min(1, f.invert / 100);
        steps.push(scaleMatrix(1 - 2 * a, a));
    }
    return steps;
}

/** Apply colour matrices in sequence, clamping between steps like CSS does. */
export function applyColorSteps(data, steps) {
    if (!steps.length) return;
    if (steps.length === 1) {
        const [m0, m1, m2, m3, m4, m5, m6, m7, m8, m9, m10, m11] = steps[0];
        const o3 = m3 * 255;
        const o7 = m7 * 255;
        const o11 = m11 * 255;
        for (let i = 0; i < data.length; i += 4) {
            if (data[i + 3] === 0) continue;
            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];
            // Uint8ClampedArray clamps and rounds on assignment.
            data[i] = m0 * r + m1 * g + m2 * b + o3;
            data[i + 1] = m4 * r + m5 * g + m6 * b + o7;
            data[i + 2] = m8 * r + m9 * g + m10 * b + o11;
        }
        return;
    }
    const flat = new Float64Array(steps.length * 12);
    steps.forEach((m, k) => {
        for (let j = 0; j < 12; j++) flat[k * 12 + j] = j % 4 === 3 ? m[j] * 255 : m[j];
    });
    const n = steps.length;
    for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] === 0) continue;
        let r = data[i];
        let g = data[i + 1];
        let b = data[i + 2];
        for (let k = 0; k < n; k++) {
            const o = k * 12;
            let nr = flat[o] * r + flat[o + 1] * g + flat[o + 2] * b + flat[o + 3];
            let ng = flat[o + 4] * r + flat[o + 5] * g + flat[o + 6] * b + flat[o + 7];
            let nb = flat[o + 8] * r + flat[o + 9] * g + flat[o + 10] * b + flat[o + 11];
            r = nr < 0 ? 0 : nr > 255 ? 255 : nr;
            g = ng < 0 ? 0 : ng > 255 ? 255 : ng;
            b = nb < 0 ? 0 : nb > 255 ? 255 : nb;
        }
        data[i] = r;
        data[i + 1] = g;
        data[i + 2] = b;
    }
}

export const PRESETS = [
    { id: 'original', name: 'Original', filters: {} },
    { id: 'vivid', name: 'Vivid', filters: { saturation: 140, contrast: 112, brightness: 104 } },
    { id: 'warm', name: 'Warm', filters: { sepia: 25, saturation: 120, brightness: 104 } },
    { id: 'fade', name: 'Fade', filters: { contrast: 82, brightness: 112, saturation: 78 } },
    { id: 'drama', name: 'Drama', filters: { contrast: 140, saturation: 115, brightness: 92 } },
    { id: 'vintage', name: 'Vintage', filters: { sepia: 55, contrast: 92, saturation: 85, brightness: 106 } },
    { id: 'mono', name: 'Mono', filters: { grayscale: 100, contrast: 110 } },
    { id: 'noir', name: 'Noir', filters: { grayscale: 100, contrast: 150, brightness: 90 } },
    { id: 'dreamy', name: 'Dreamy', filters: { blur: 2, brightness: 110, saturation: 120, contrast: 90 } },
    { id: 'invert', name: 'Negative', filters: { invert: 100 } }
];

export const presetFilters = (preset) => ({ ...DEFAULTS, ...preset.filters });

export const BLEND_MODES = [
    { value: 'source-over', label: 'Normal' },
    { group: 'Darken' },
    { value: 'multiply', label: 'Multiply' },
    { value: 'darken', label: 'Darken' },
    { value: 'color-burn', label: 'Color burn' },
    { group: 'Lighten' },
    { value: 'screen', label: 'Screen' },
    { value: 'lighten', label: 'Lighten' },
    { value: 'color-dodge', label: 'Color dodge' },
    { value: 'lighter', label: 'Add' },
    { group: 'Contrast' },
    { value: 'overlay', label: 'Overlay' },
    { value: 'soft-light', label: 'Soft light' },
    { value: 'hard-light', label: 'Hard light' },
    { group: 'Inversion' },
    { value: 'difference', label: 'Difference' },
    { value: 'exclusion', label: 'Exclusion' },
    { group: 'Component' },
    { value: 'hue', label: 'Hue' },
    { value: 'saturation', label: 'Saturation' },
    { value: 'color', label: 'Color' },
    { value: 'luminosity', label: 'Luminosity' }
];

const BLEND_LABELS = Object.fromEntries(BLEND_MODES.filter((b) => b.value).map((b) => [b.value, b.label]));
export const blendLabel = (value) => BLEND_LABELS[value] || 'Normal';
export const isBlendMode = (value) => Object.prototype.hasOwnProperty.call(BLEND_LABELS, value);
