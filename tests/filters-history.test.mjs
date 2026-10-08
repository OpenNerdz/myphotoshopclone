import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    FILTER_DEFS,
    defaultFilters,
    normalizeFilters,
    isIdentity,
    cssFilter,
    colorMatrix,
    isIdentityMatrix,
    applyColorMatrix,
    applyColorSteps,
    colorSteps,
    blurRadius,
    PRESETS,
    presetFilters,
    BLEND_MODES,
    isBlendMode
} from '../js/filters.js';
import { History } from '../js/history.js';

test('defaults are identity', () => {
    const f = defaultFilters();
    assert.ok(isIdentity(f));
    assert.equal(cssFilter(f), 'none');
    assert.ok(isIdentityMatrix(colorMatrix(f)));
});

test('normalizeFilters clamps and fills missing keys', () => {
    const f = normalizeFilters({ brightness: 999, hue: 'x' });
    assert.equal(f.brightness, 200);
    assert.equal(f.hue, 0);
    assert.equal(Object.keys(f).length, FILTER_DEFS.length);
});

test('cssFilter only emits non-default functions', () => {
    const f = { ...defaultFilters(), contrast: 120, grayscale: 50 };
    assert.equal(cssFilter(f), 'contrast(120%) grayscale(50%)');
    assert.equal(cssFilter({ ...defaultFilters(), blur: 4 }, 8), 'blur(8px)');
});

test('blur radius scales with image size', () => {
    assert.equal(blurRadius({ blur: 5 }, 2000), 10);
    assert.equal(blurRadius({ blur: 5 }, 500), 2.5);
});

const px = (r, g, b) => new Uint8ClampedArray([r, g, b, 255]);

test('colour matrix: brightness, contrast, invert, grayscale', () => {
    let d = px(100, 50, 200);
    applyColorMatrix(d, colorMatrix({ ...defaultFilters(), brightness: 200 }));
    assert.deepEqual([...d.slice(0, 3)], [200, 100, 255]);

    d = px(0, 128, 255);
    applyColorMatrix(d, colorMatrix({ ...defaultFilters(), contrast: 0 }));
    assert.deepEqual([...d.slice(0, 3)], [128, 128, 128]);

    d = px(0, 100, 255);
    applyColorMatrix(d, colorMatrix({ ...defaultFilters(), invert: 100 }));
    assert.deepEqual([...d.slice(0, 3)], [255, 155, 0]);

    d = px(255, 0, 0);
    applyColorMatrix(d, colorMatrix({ ...defaultFilters(), grayscale: 100 }));
    assert.equal(d[0], d[1]);
    assert.equal(d[1], d[2]);
});

test('hue rotate by 360° is (nearly) identity', () => {
    const d = px(200, 40, 90);
    applyColorMatrix(d, colorMatrix({ ...defaultFilters(), hue: 360 }));
    assert.deepEqual([...d.slice(0, 3)], [200, 40, 90]);
});

test('steps clamp between functions like CSS filters do', () => {
    const f = { ...defaultFilters(), brightness: 200, contrast: 50 };
    const d = px(200, 100, 0);
    applyColorSteps(d, colorSteps(f));
    // brightness: 400→255 (clamped), 200, 0; then contrast ½ around 127.5
    assert.deepEqual([...d.slice(0, 3)], [191, 164, 64]);
    const composed = px(200, 100, 0);
    applyColorMatrix(composed, colorMatrix(f));
    assert.notDeepEqual([...composed.slice(0, 3)], [...d.slice(0, 3)], 'single composed matrix would drift');
});

test('transparent pixels are skipped by the matrix', () => {
    const d = new Uint8ClampedArray([10, 20, 30, 0]);
    applyColorMatrix(d, colorMatrix({ ...defaultFilters(), invert: 100 }));
    assert.deepEqual([...d], [10, 20, 30, 0]);
});

test('presets and blend modes are well formed', () => {
    assert.ok(isIdentity(presetFilters(PRESETS[0])));
    for (const p of PRESETS) assert.deepEqual(normalizeFilters(presetFilters(p)), presetFilters(p));
    assert.ok(isBlendMode('multiply'));
    assert.ok(!isBlendMode('nope'));
    assert.equal(BLEND_MODES[0].value, 'source-over');
});

test('history push/undo/redo', () => {
    const h = new History(10);
    h.reset({ v: 0 });
    h.push({ v: 1 }, { label: 'one' });
    h.push({ v: 2 }, { label: 'two' });
    assert.equal(h.undoLabel, 'two');
    assert.deepEqual(h.undo(), { state: { v: 1 }, label: 'two' });
    assert.equal(h.redoLabel, 'two');
    assert.deepEqual(h.redo(), { state: { v: 2 }, label: 'two' });
    assert.equal(h.redo(), null);
    h.undo();
    h.push({ v: 3 });
    assert.ok(!h.canRedo, 'pushing clears the redo stack');
});

test('history coalesces keyed pushes inside the window', () => {
    const h = new History(10);
    h.reset({ v: 0 });
    h.push({ v: 1 }, { key: 'nudge', now: 1000 });
    h.push({ v: 2 }, { key: 'nudge', now: 1500 });
    h.push({ v: 3 }, { key: 'nudge', now: 1900 });
    assert.equal(h.past.length, 1);
    assert.deepEqual(h.undo().state, { v: 0 });
    h.redo();
    h.push({ v: 4 }, { key: 'nudge', now: 5000 });
    assert.equal(h.past.length, 2, 'outside the window it records a new entry');
});

test('history respects its limit and lists reachable states', () => {
    const h = new History(3);
    h.reset({ v: 0 });
    for (let i = 1; i <= 6; i++) h.push({ v: i });
    assert.equal(h.past.length, 3);
    assert.deepEqual([...h.states()].map((s) => s.v), [3, 4, 5, 6]);
});
