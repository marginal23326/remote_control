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
    private renderedRows: HTMLElement[] = [];
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
        this.renderedRows = [];
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

        const { container } = this.options;
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

        const { end: oldEnd, start: oldStart } = this.renderedRange;
        if (!force && startIndex === oldStart && endIndex === oldEnd) {
            return;
        }

        const paddingTop = startIndex * this.measuredRowHeight;
        const paddingBottom = Math.max(0, totalHeight - endIndex * this.measuredRowHeight);

        const canPatch = !force && totalItems > 0 && oldStart !== -1 && startIndex < oldEnd && endIndex > oldStart;

        if (canPatch) {
            this.patchRows(items, startIndex, endIndex, oldStart, oldEnd, paddingTop, paddingBottom);
        } else {
            this.rebuild(items, startIndex, endIndex, totalItems, paddingTop, paddingBottom);
        }

        this.renderedRange = { end: endIndex, start: startIndex };
    }

    private parseRows(html: string): HTMLElement[] {
        if (!html) return [];
        const tmp = document.createElement(this.options.list.tagName);
        tmp.innerHTML = html;
        return Array.from(tmp.children) as HTMLElement[];
    }

    private renderRowsHtml(items: T[], start: number, end: number): string {
        let html = "";
        for (let i = start; i < end; i++) {
            const item = items[i];
            if (item) html += this.options.renderRow(item);
        }
        return html;
    }

    private rebuild(
        items: T[],
        startIndex: number,
        endIndex: number,
        totalItems: number,
        paddingTop: number,
        paddingBottom: number,
    ): void {
        const { list } = this.options;

        let html = "";
        if (paddingTop > 0) html += renderSpacerRow(paddingTop);
        html += this.renderRowsHtml(items, startIndex, endIndex);
        if (totalItems === 0) html += this.options.renderEmpty();
        if (paddingBottom > 0) html += renderSpacerRow(paddingBottom);

        list.innerHTML = html;

        this.renderedRows = Array.from(list.querySelectorAll<HTMLElement>(":scope > tr[data-path]"));
    }

    private patchRows(
        items: T[],
        startIndex: number,
        endIndex: number,
        oldStart: number,
        oldEnd: number,
        paddingTop: number,
        paddingBottom: number,
    ): void {
        const dropFront = Math.min(this.renderedRows.length, Math.max(0, startIndex - oldStart));
        for (let i = 0; i < dropFront; i++) this.renderedRows.shift()?.remove();

        const dropBack = Math.min(this.renderedRows.length, Math.max(0, oldEnd - endIndex));
        for (let i = 0; i < dropBack; i++) this.renderedRows.pop()?.remove();

        const first = this.renderedRows[0];
        if (startIndex < oldStart && first) {
            const rows = this.parseRows(this.renderRowsHtml(items, startIndex, oldStart));
            first.before(...rows);
            this.renderedRows.unshift(...rows);
        }

        const last = this.renderedRows.at(-1);
        if (endIndex > oldEnd && last) {
            const rows = this.parseRows(this.renderRowsHtml(items, oldEnd, endIndex));
            last.after(...rows);
            this.renderedRows.push(...rows);
        }

        this.setSpacer(true, paddingTop);
        this.setSpacer(false, paddingBottom);
    }

    private setSpacer(isTop: boolean, height: number): void {
        const { list } = this.options;
        const current = (isTop ? list.firstElementChild : list.lastElementChild) as HTMLElement | null;
        const isSpacer = current?.classList.contains("virtual-spacer") ?? false;

        if (height <= 0) {
            if (isSpacer) current?.remove();
            return;
        }

        if (isSpacer && current) {
            current.style.height = `${height}px`;
            const cell = current.firstElementChild as HTMLElement | null;
            if (cell) cell.style.height = `${height}px`;
            return;
        }

        const spacer = this.parseRows(renderSpacerRow(height))[0];
        if (!spacer) return;

        if (isTop) this.renderedRows[0]?.before(spacer);
        else this.renderedRows.at(-1)?.after(spacer);
    }
}
