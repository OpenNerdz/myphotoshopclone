// Procedurally generated sample images so first-time visitors can try the
// editor without hunting for files.

import { createCanvas } from './images.js';

function mulberry32(seed) {
    return () => {
        seed |= 0;
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function ridge(ctx, w, h, baseY, amp, color, rand, roughness = 0.5) {
    const pts = [];
    const n = 9;
    for (let i = 0; i <= n; i++) pts.push({ x: (i / n) * w, y: baseY - rand() * amp });
    // Midpoint displacement for a natural silhouette.
    let seg = pts;
    let disp = amp * roughness;
    for (let k = 0; k < 5; k++) {
        const next = [];
        for (let i = 0; i < seg.length - 1; i++) {
            const a = seg[i];
            const b = seg[i + 1];
            next.push(a, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 + (rand() - 0.5) * disp });
        }
        next.push(seg[seg.length - 1]);
        seg = next;
        disp *= 0.55;
    }
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (const p of seg) ctx.lineTo(p.x, p.y);
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
}

function landscape() {
    const w = 1600;
    const h = 1000;
    const c = createCanvas(w, h);
    const ctx = c.getContext('2d');
    const rand = mulberry32(7);

    const sky = ctx.createLinearGradient(0, 0, 0, h * 0.7);
    sky.addColorStop(0, '#1b2a5e');
    sky.addColorStop(0.45, '#7a4f9a');
    sky.addColorStop(0.75, '#f08a5d');
    sky.addColorStop(1, '#ffd08a');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h);

    const sun = ctx.createRadialGradient(w * 0.62, h * 0.56, 10, w * 0.62, h * 0.56, 260);
    sun.addColorStop(0, 'rgba(255,244,214,1)');
    sun.addColorStop(0.25, 'rgba(255,214,150,0.9)');
    sun.addColorStop(1, 'rgba(255,170,110,0)');
    ctx.fillStyle = sun;
    ctx.fillRect(0, 0, w, h);

    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    for (let i = 0; i < 90; i++) {
        const r = rand() * 1.4 + 0.3;
        ctx.globalAlpha = rand() * 0.7 + 0.2;
        ctx.beginPath();
        ctx.arc(rand() * w, rand() * h * 0.35, r, 0, Math.PI * 2);
        ctx.fill();
    }
    ctx.globalAlpha = 1;

    ridge(ctx, w, h, h * 0.62, 220, '#6b4a7e', rand, 0.6);
    ridge(ctx, w, h, h * 0.7, 160, '#4b3466', rand, 0.55);
    ridge(ctx, w, h, h * 0.8, 120, '#2d2147', rand, 0.5);

    const lake = ctx.createLinearGradient(0, h * 0.82, 0, h);
    lake.addColorStop(0, '#f2a46f');
    lake.addColorStop(1, '#271c40');
    ctx.fillStyle = lake;
    ctx.fillRect(0, h * 0.82, w, h * 0.18);
    ctx.fillStyle = 'rgba(255,236,200,0.5)';
    for (let i = 0; i < 26; i++) {
        const y = h * 0.84 + i * 6;
        const half = 200 - i * 7;
        ctx.fillRect(w * 0.62 - half / 2 + (rand() - 0.5) * 30, y, half, 2);
    }
    ridge(ctx, w, h, h * 0.95, 60, '#140f24', rand, 0.4);
    return c;
}

function lightLeak() {
    const w = 1600;
    const h = 1000;
    const c = createCanvas(w, h);
    const ctx = c.getContext('2d');
    const rand = mulberry32(42);
    const colors = ['255,120,80', '255,200,90', '120,180,255', '255,90,170', '150,255,210'];
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 46; i++) {
        const x = rand() * w;
        const y = rand() * h;
        const r = 18 + rand() * 90;
        const col = colors[Math.floor(rand() * colors.length)];
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        const a = 0.25 + rand() * 0.45;
        g.addColorStop(0, `rgba(${col},${a})`);
        g.addColorStop(0.7, `rgba(${col},${a * 0.6})`);
        g.addColorStop(1, `rgba(${col},0)`);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
    }
    const leak = ctx.createLinearGradient(0, 0, w, h);
    leak.addColorStop(0, 'rgba(255,110,60,0.55)');
    leak.addColorStop(0.35, 'rgba(255,110,60,0)');
    leak.addColorStop(0.75, 'rgba(90,140,255,0)');
    leak.addColorStop(1, 'rgba(90,140,255,0.45)');
    ctx.fillStyle = leak;
    ctx.fillRect(0, 0, w, h);
    return c;
}

const toBlob = (canvas) => new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), 'image/png'));

/** @returns {Promise<Array<{name: string, blob: Blob, overrides?: object}>>} */
export async function createSampleBlobs() {
    const land = landscape();
    const leak = lightLeak();
    const [a, b] = await Promise.all([toBlob(land), toBlob(leak)]);
    land.width = 0;
    leak.width = 0;
    // Order: bottom layer first; each added layer goes on top.
    return [
        { name: 'Sunset landscape.png', blob: a },
        { name: 'Bokeh light leak.png', blob: b, overrides: { blend: 'screen', opacity: 0.85 } }
    ];
}
