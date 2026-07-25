import { computeVisibleRange, renderSpacerRow } from "./file-list-renderer";

export interface VirtualListRange {
    start: number;
    end: number;
}

interface VirtualListOptions<T> {
    container: HTMLElement;
    list: HTMLElement;
    buffer?: number;
    getItems: () => T[];
    renderRow: (item: T) => string;
    renderEmpty: () => string;
    isPaused: () => boolean;
}

export class VirtualList<T> {
    private readonly buffer: number;
    private measuredRowHeight = 21;
    private rowHeightNeedsUpdate = true;
    private lastContainerHeight = 0;
    private renderedRange: VirtualListRange = { end: -1, start: -1 };
    private ticking = false;

    constructor(private readonly options: VirtualListOptions<T>) {
        this.buffer = options.buffer ?? 15;
    }

    get rowHeight(): number {
        return this.measuredRowHeight;
    }

    get visibleRange(): VirtualListRange {
        return this.renderedRange;
    }

    attach(): void {
        const { container } = this.options;

        container.addEventListener("scroll", () => {
            if (this.ticking) return;
            this.ticking = true;
            window.requestAnimationFrame(() => {
                this.render();
                this.ticking = false;
            });
        });

        this.lastContainerHeight = container.clientHeight || 0;
        const resizeObserver = new ResizeObserver(() => {
            if (this.options.getItems().length === 0) return;
            const newHeight = container.clientHeight || 0;
            if (newHeight === this.lastContainerHeight) return;
            this.lastContainerHeight = newHeight;
            this.rowHeightNeedsUpdate = true;
            window.requestAnimationFrame(() => this.render(true));
        });
        resizeObserver.observe(container);
    }

    resetRange(): void {
        this.renderedRange = { end: -1, start: -1 };
    }

    render(force = false): void {
        if (this.options.isPaused()) return;

        if (this.rowHeightNeedsUpdate) {
            const firstRealRow = this.options.list.querySelector<HTMLElement>("tr[data-path]");
            if (firstRealRow) {
                const measured = firstRealRow.getBoundingClientRect().height;
                if (measured > 0) {
                    this.measuredRowHeight = measured;
                    this.rowHeightNeedsUpdate = false;
                }
            }
        }

        const { container, list } = this.options;
        const containerHeight = container.clientHeight || 500;
        const { scrollTop } = container;
        const items = this.options.getItems();
        const totalItems = items.length;
        const totalHeight = totalItems * this.measuredRowHeight;

        const { startIndex, endIndex } = computeVisibleRange({
            buffer: this.buffer,
            containerHeight,
            rowHeight: this.measuredRowHeight,
            scrollTop,
            totalItems,
        });

        if (!force && startIndex === this.renderedRange.start && endIndex === this.renderedRange.end) {
            return;
        }
        this.renderedRange = { end: endIndex, start: startIndex };

        const paddingTop = startIndex * this.measuredRowHeight;
        const paddingBottom = Math.max(0, totalHeight - endIndex * this.measuredRowHeight);

        let html = "";
        if (paddingTop > 0) {
            html += renderSpacerRow(paddingTop);
        }

        for (let i = startIndex; i < endIndex; i++) {
            const item = items[i];
            if (item) html += this.options.renderRow(item);
        }

        if (totalItems === 0) {
            html += this.options.renderEmpty();
        }

        if (paddingBottom > 0) {
            html += renderSpacerRow(paddingBottom);
        }

        list.innerHTML = html;
    }
}
