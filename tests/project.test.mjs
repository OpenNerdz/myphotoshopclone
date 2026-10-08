import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

test('service worker precaches every module and only existing files', () => {
    const sw = read('sw.js');
    const listed = [...sw.matchAll(/^\s+'([^']+)',?$/gm)].map((m) => m[1]);
    const modules = fs.readdirSync(path.join(root, 'js')).filter((f) => f.endsWith('.js'));
    for (const m of modules) assert.ok(listed.includes(`js/${m}`), `sw.js is missing js/${m}`);
    for (const f of listed) {
        if (f === './') continue;
        assert.ok(fs.existsSync(path.join(root, f)), `sw.js lists a missing file: ${f}`);
    }
});

test('index.html only references files that exist', () => {
    const html = read('index.html');
    const refs = [...html.matchAll(/(?:href|src)="([^"#:]+)"/g)].map((m) => m[1]);
    assert.ok(refs.length > 5);
    for (const r of refs) assert.ok(fs.existsSync(path.join(root, r)), `index.html references missing ${r}`);
});

test('every icon used in markup and scripts exists in the sprite', () => {
    const html = read('index.html');
    const defined = new Set([...html.matchAll(/<symbol id="i-([\w-]+)"/g)].map((m) => m[1]));
    const sources = [html, ...fs.readdirSync(path.join(root, 'js')).map((f) => read(`js/${f}`))].join('\n');
    const used = new Set([...sources.matchAll(/#i-([\w-]+)/g)].map((m) => m[1]));
    for (const m of sources.matchAll(/icon\('([\w-]+)'/g)) used.add(m[1]);
    for (const name of used) assert.ok(defined.has(name), `icon "${name}" is used but not defined`);
});

test('manifest is valid JSON with installable icons', () => {
    const m = JSON.parse(read('manifest.webmanifest'));
    assert.equal(m.display, 'standalone');
    const sizes = m.icons.map((i) => i.sizes);
    assert.ok(sizes.includes('192x192') && sizes.includes('512x512'));
    for (const i of m.icons) assert.ok(fs.existsSync(path.join(root, i.src)), `missing ${i.src}`);
});
