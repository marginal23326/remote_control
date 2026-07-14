class AccessChecker {
    constructor({ checkAccess, getVisiblePaths, onResolved }) {
        this.cache = new Map();
        this.queue = new Set();
        this.timer = null;
        this.checkAccess = checkAccess;
        this.getVisiblePaths = getVisiblePaths;
        this.onResolved = onResolved;
    }

    get(path) {
        return this.cache.get(path);
    }

    reset() {
        this.cache.clear();
        this.queue.clear();
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    queuePath(path) {
        this.queue.add(path);
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => this.flush(), 100);
    }

    async flush() {
        if (this.queue.size === 0) return;

        const visiblePaths = this.getVisiblePaths();
        const batch = Array.from(this.queue).filter((p) => visiblePaths.has(p));
        this.queue.clear();

        if (batch.length === 0) return;

        try {
            const inaccessible = await this.checkAccess(batch);
            const inaccessibleSet = new Set(inaccessible);

            for (const path of batch) {
                const accessible = !inaccessibleSet.has(path);
                this.cache.set(path, accessible);
                this.onResolved?.(path, accessible);
            }
        } catch (e) {
            console.warn("Failed to check directory access:", e);
        }
    }
}

export { AccessChecker };
