// Snapshot-based undo/redo stack. Entries hold plain data only.

export class History {
    constructor(limit = 100) {
        this.limit = limit;
        this.past = [];
        this.future = [];
        this.present = null;
        this.lastKey = null;
        this.lastTime = 0;
    }

    reset(state, label = '') {
        this.past = [];
        this.future = [];
        this.present = { state, label };
        this.lastKey = null;
    }

    /**
     * Record a new state. Consecutive pushes sharing a `key` within `window` ms
     * are merged into one entry (e.g. holding an arrow key to nudge a layer).
     */
    push(state, { label = '', key = null, window = 1000, now = Date.now() } = {}) {
        const coalesce = key !== null && key === this.lastKey && now - this.lastTime < window && this.past.length > 0;
        if (coalesce) {
            this.present = { state, label };
        } else {
            if (this.present) this.past.push(this.present);
            if (this.past.length > this.limit) this.past.splice(0, this.past.length - this.limit);
            this.present = { state, label };
        }
        this.future = [];
        this.lastKey = key;
        this.lastTime = now;
    }

    undo() {
        if (!this.past.length) return null;
        const undone = this.present;
        this.future.push(undone);
        this.present = this.past.pop();
        this.lastKey = null;
        return { state: this.present.state, label: undone.label };
    }

    redo() {
        if (!this.future.length) return null;
        this.past.push(this.present);
        this.present = this.future.pop();
        this.lastKey = null;
        return { state: this.present.state, label: this.present.label };
    }

    get canUndo() {
        return this.past.length > 0;
    }

    get canRedo() {
        return this.future.length > 0;
    }

    get undoLabel() {
        return this.canUndo ? this.present.label : '';
    }

    get redoLabel() {
        return this.canRedo ? this.future[this.future.length - 1].label : '';
    }

    /** Every state currently reachable via undo/redo (used for asset GC). */
    *states() {
        for (const e of this.past) yield e.state;
        if (this.present) yield this.present.state;
        for (const e of this.future) yield e.state;
    }
}
