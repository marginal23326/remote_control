export interface AccessCheckerConfig {
    checkAccess: (paths: string[]) => Promise<string[]>;
    getVisiblePaths: () => Set<string>;
    onResolved?: (path: string, accessible: boolean) => void;
}

export class AccessChecker {
    private readonly cache = new Map<string, boolean>();
    private readonly queue = new Set<string>();
    private timer: ReturnType<typeof setTimeout> | null = null;
    private readonly checkAccess: (paths: string[]) => Promise<string[]>;
    private readonly getVisiblePaths: () => Set<string>;
    private readonly onResolved?: (path: string, accessible: boolean) => void;

    constructor({ checkAccess, getVisiblePaths, onResolved }: AccessCheckerConfig) {
        this.checkAccess = checkAccess;
        this.getVisiblePaths = getVisiblePaths;
        this.onResolved = onResolved;
    }

    get(path: string): boolean | undefined {
        return this.cache.get(path);
    }

    reset(): void {
        this.cache.clear();
        this.queue.clear();
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    queuePath(path: string): void {
        this.queue.add(path);
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => this.flush(), 100);
    }

    async flush(): Promise<void> {
        if (this.queue.size === 0) return;

        const visiblePaths = this.getVisiblePaths();
        const batch = [...this.queue].filter((p) => visiblePaths.has(p));
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
        } catch (error) {
            console.warn("Failed to check directory access:", error);
        }
    }
}
