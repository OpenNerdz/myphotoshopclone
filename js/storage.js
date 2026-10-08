// IndexedDB autosave so a refresh or accidental tab close never loses work.
// Images are stored as their original Blobs; the project is plain JSON.

const DB_NAME = 'image-overlay-studio';
const DB_VERSION = 1;
const ASSETS = 'assets';
const META = 'meta';
const PROJECT_KEY = 'project';

let dbPromise = null;

function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        if (!('indexedDB' in window)) {
            reject(new Error('IndexedDB unavailable'));
            return;
        }
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(ASSETS)) db.createObjectStore(ASSETS, { keyPath: 'id' });
            if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error('IndexedDB blocked'));
    });
    dbPromise.catch(() => {
        dbPromise = null;
    });
    return dbPromise;
}

const done = (tx) =>
    new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
    });

const request = (req) =>
    new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });

/**
 * Persist the project. `assets` lists records ({id, name, blob}) that are not
 * stored yet; anything not in `keepIds` is deleted. Images in `keepIds` that are
 * missing from the database (e.g. removed by another tab) are re-saved using
 * `lookup(id)`. Resolves with the ids that had to be repaired.
 */
export async function saveProject(project, assets, keepIds, lookup = () => null) {
    const db = await openDB();
    const tx = db.transaction([ASSETS, META], 'readwrite');
    const store = tx.objectStore(ASSETS);
    const put = (a) => store.put({ id: a.id, name: a.name, blob: a.blob });
    for (const a of assets) put(a);
    tx.objectStore(META).put(project, PROJECT_KEY);
    const stored = new Set(await request(store.getAllKeys()));
    const queued = new Set(assets.map((a) => a.id));
    const repaired = [];
    for (const id of keepIds) {
        if (stored.has(id) || queued.has(id)) continue;
        const a = lookup(id);
        if (a && a.blob) {
            put(a);
            repaired.push(id);
        }
    }
    for (const key of stored) if (!keepIds.has(key)) store.delete(key);
    await done(tx);
    return repaired;
}

/** @returns {Promise<{project: object, assets: Map<string, {id, name, blob}>} | null>} */
export async function loadProject() {
    const db = await openDB();
    const tx = db.transaction([ASSETS, META], 'readonly');
    const project = await request(tx.objectStore(META).get(PROJECT_KEY));
    if (!project) return null;
    const records = await request(tx.objectStore(ASSETS).getAll());
    return { project, assets: new Map(records.map((r) => [r.id, r])) };
}

export async function clearProject() {
    const db = await openDB();
    const tx = db.transaction([ASSETS, META], 'readwrite');
    tx.objectStore(ASSETS).clear();
    tx.objectStore(META).delete(PROJECT_KEY);
    await done(tx);
}
