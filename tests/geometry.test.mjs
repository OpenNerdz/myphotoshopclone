import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    normalizeAngle,
    layerBounds,
    hitLayer,
    toSourcePixel,
    unionRect,
    roundRect,
    aspectRectWithin,
    scaleFromHandle,
    rotateFromPointer,
    snapRect,
    dragRect
} from '../js/geometry.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

const layer = (over = {}) => ({
    x: 100,
    y: 50,
    width: 200,
    height: 100,
    scaleX: 1,
    scaleY: 1,
    rotation: 0,
    flipH: false,
    flipV: false,
    ...over
});

test('normalizeAngle wraps into (-180, 180]', () => {
    assert.equal(normalizeAngle(0), 0);
    assert.equal(normalizeAngle(190), -170);
    assert.equal(normalizeAngle(-190), 170);
    assert.equal(normalizeAngle(180), 180);
    assert.equal(normalizeAngle(-180), 180);
    assert.equal(normalizeAngle(720 + 45), 45);
});

test('layerBounds of an unrotated layer is its rect', () => {
    assert.deepEqual(layerBounds(layer()), { x: 0, y: 0, w: 200, h: 100 });
});

test('layerBounds grows when rotated 90°', () => {
    const b = layerBounds(layer({ rotation: 90 }));
    near(b.w, 100);
    near(b.h, 200);
    near(b.x, 50);
    near(b.y, -50);
});

test('hitLayer respects rotation', () => {
    const l = layer({ rotation: 90 });
    assert.ok(hitLayer(l, 100, 140)); // inside after rotation
    assert.ok(!hitLayer(l, 190, 50)); // was inside before rotation
});

test('toSourcePixel maps corners and handles flips', () => {
    const l = layer({ scaleX: 2, scaleY: 2 });
    const p = toSourcePixel(l, 100 - 200, 50 - 100);
    near(p.x, 0);
    near(p.y, 0);
    const f = toSourcePixel({ ...l, flipH: true }, 100 - 200, 50 - 100);
    near(f.x, 200);
});

test('unionRect and roundRect', () => {
    assert.equal(unionRect([]), null);
    assert.deepEqual(unionRect([{ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: -5, w: 10, h: 10 }]), { x: 0, y: -5, w: 15, h: 15 });
    assert.deepEqual(roundRect({ x: 0.4, y: 0.6, w: 10.2, h: 0.1 }), { x: 0, y: 1, w: 11, h: 1 });
});

test('aspectRectWithin centres the largest fitting rect', () => {
    assert.deepEqual(aspectRectWithin({ x: 0, y: 0, w: 200, h: 100 }, 1), { x: 50, y: 0, w: 100, h: 100 });
});

test('scaleFromHandle: corner keeps aspect and anchors the opposite corner', () => {
    const start = layer();
    // Drag the SE corner from (200,100) to (300,150): twice the size.
    const r = scaleFromHandle(start, 'se', { x: 300, y: 150 }, { keepAspect: true });
    near(r.scaleX, 1.5);
    near(r.scaleY, 1.5);
    // NW corner (0,0) must stay put.
    near(r.x - (200 * r.scaleX) / 2, 0);
    near(r.y - (100 * r.scaleY) / 2, 0);
});

test('scaleFromHandle: edge handle scales one axis', () => {
    const r = scaleFromHandle(layer(), 'e', { x: 400, y: 999 });
    near(r.scaleX, 2);
    near(r.scaleY, 1);
    near(r.y, 50);
    near(r.x, 200);
});

test('scaleFromHandle: from centre doubles the delta', () => {
    const r = scaleFromHandle(layer(), 'e', { x: 250, y: 50 }, { fromCenter: true });
    near(r.scaleX, 1.5);
    near(r.x, 100);
});

test('scaleFromHandle works on rotated layers', () => {
    const start = layer({ rotation: 90 });
    // East handle of a 90° rotated layer points down (+y). Its tip is at (100, 150).
    const r = scaleFromHandle(start, 'e', { x: 100, y: 250 });
    near(r.scaleX, 1.5);
    near(r.x, 100);
    near(r.y, 100);
});

test('scaleFromHandle enforces a minimum size', () => {
    const r = scaleFromHandle(layer(), 'se', { x: -500, y: -500 }, { keepAspect: true, minSize: 10 });
    near(Math.min(200 * r.scaleX, 100 * r.scaleY), 10);
});

test('rotateFromPointer computes delta angle and snaps', () => {
    const start = layer();
    const r = rotateFromPointer(start, { x: 200, y: 50 }, { x: 100, y: 150 });
    near(r, 90);
    const s = rotateFromPointer(start, { x: 200, y: 50 }, { x: 200, y: 70 }, 15);
    assert.equal(s % 15, 0);
});

test('snapRect picks the closest target within the threshold', () => {
    const s = snapRect({ x: 3, y: 50, w: 100, h: 100 }, [0, 500], [0, 500], 5);
    assert.equal(s.dx, -3);
    assert.equal(s.guideX, 0);
    assert.equal(s.dy, 0);
    assert.equal(s.guideY, null);
});

test('dragRect move is clamped to bounds', () => {
    const r = dragRect({ x: 0, y: 0, w: 50, h: 50 }, 'move', 100, -10, { bounds: { x: 0, y: 0, w: 100, h: 100 } });
    assert.deepEqual(r, { x: 50, y: 0, w: 50, h: 50 });
});

test('dragRect resize respects min size and bounds', () => {
    const r = dragRect({ x: 10, y: 10, w: 50, h: 50 }, 'se', -100, 500, { bounds: { x: 0, y: 0, w: 100, h: 100 }, min: 8 });
    assert.deepEqual(r, { x: 10, y: 10, w: 8, h: 90 });
});

test('dragRect with aspect keeps the ratio and stays in bounds', () => {
    const r = dragRect({ x: 0, y: 0, w: 40, h: 40 }, 'se', 200, 10, { aspect: 2, bounds: { x: 0, y: 0, w: 100, h: 100 } });
    near(r.w / r.h, 2);
    assert.ok(r.x + r.w <= 100.0001 && r.y + r.h <= 100.0001);
    const e = dragRect({ x: 20, y: 20, w: 40, h: 40 }, 'e', 20, 0, { aspect: 1 });
    near(e.w, 60);
    near(e.h, 60);
    near(e.y, 10); // centred vertically on the original centre
});
