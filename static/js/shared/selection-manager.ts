import { isTypingField } from "./dom-helpers";

export interface SelectionManagerConfig {
    containerSelector: string;
    itemSelector?: string;
    selectedClass?: string;
    defaultHoverClass?: string;
    selectedHoverClass?: string;
    disabledClass?: string;
    getItemId?: (element: HTMLElement) => string | undefined;
    isItemSelectable?: (element: HTMLElement) => boolean;
    getAllIds?: (() => string[]) | null;
    onSelectionChange?: (items: string[]) => void;
}

interface ResolvedSelectionManagerConfig {
    containerSelector: string;
    itemSelector: string;
    selectedClass: string;
    defaultHoverClass: string;
    selectedHoverClass: string;
    disabledClass: string;
    getItemId: (element: HTMLElement) => string | undefined;
    isItemSelectable: (element: HTMLElement) => boolean;
    getAllIds: (() => string[]) | null;
    onSelectionChange: (items: string[]) => void;
}

export class SelectionManager {
    selectedIds = new Set<string>();
    lastSelectedId: string | null = null;
    selectionAnchorId: string | null = null;
    isDragging = false;
    dragStartId: string | null = null;
    private dragAllIdsCache: string[] | null = null;
    private lastClientY: number | null = null;
    private lastTargetItem: HTMLElement | null = null;
    private currentScrollSpeed = 0;
    private scrollAnimationFrame: number | null = null;

    config: ResolvedSelectionManagerConfig;
    classes: { selected: string[]; defaultHover: string[]; selectedHover: string[] };

    constructor(config: SelectionManagerConfig) {
        this.config = {
            defaultHoverClass: "hover:bg-zinc-800",
            disabledClass: "cursor-not-allowed opacity-50",
            getAllIds: null,
            getItemId: (element) => element.dataset.id,
            isItemSelectable: (element) => !element.classList.contains("cursor-not-allowed"),
            itemSelector: "tr:not(.virtual-spacer)",
            onSelectionChange: () => {},
            selectedClass: "bg-zinc-800/80 ring-1 ring-inset ring-zinc-700/50",
            selectedHoverClass: "hover:bg-zinc-700!",
            ...config,
        };

        this.classes = {
            defaultHover: this.config.defaultHoverClass.split(" ").filter(Boolean),
            selected: this.config.selectedClass.split(" ").filter(Boolean),
            selectedHover: this.config.selectedHoverClass.split(" ").filter(Boolean),
        };
    }

    private getSelectableIds(): string[] {
        if (this.config.getAllIds) {
            return this.config.getAllIds() || [];
        }

        const container = document.querySelector(this.config.containerSelector);
        if (!container) return [];
        return [...container.querySelectorAll<HTMLElement>(this.config.itemSelector)]
            .filter((el) => this.config.isItemSelectable(el))
            .map((el) => this.config.getItemId(el))
            .filter((id): id is string => Boolean(id));
    }

    initialize(): void {
        const container = document.querySelector(this.config.containerSelector);
        if (!container) return;

        container.addEventListener("mousedown", (e) => {
            const item = (e.target as HTMLElement).closest<HTMLElement>(this.config.itemSelector);
            if (item && this.config.getItemId(item)) {
                if ((e as MouseEvent).button === 0) {
                    if (isTypingField(document.activeElement) && document.activeElement instanceof HTMLElement) {
                        document.activeElement.blur();
                    }
                    this.handleItemSelection(item, e as MouseEvent);
                    this.handleDragStart(e as MouseEvent, item);
                }
            } else {
                this.clearSelection(true);
            }
        });

        container.addEventListener("dragstart", (e) => {
            if (this.isDragging) {
                e.preventDefault();
            }
        });

        // Deselect when clicking outside the container
        document.addEventListener("mousedown", (e) => {
            const found = document.querySelector(this.config.containerSelector);
            if (found && !found.contains(e.target as Node)) {
                const scrollContainer = (found.closest(".overflow-auto") as HTMLElement) || (found as HTMLElement);
                const rect = scrollContainer.getBoundingClientRect();
                const me = e;

                const isInside =
                    me.clientX >= rect.left &&
                    me.clientX <= rect.right &&
                    me.clientY >= rect.top &&
                    me.clientY <= rect.bottom;
                if (
                    isInside &&
                    (me.clientX > rect.left + scrollContainer.clientWidth ||
                        me.clientY > rect.top + scrollContainer.clientHeight)
                ) {
                    return;
                }

                const target = e.target as HTMLElement;
                if (
                    target.closest(".context-menu") ||
                    target.closest("#fileActionsBar") ||
                    target.closest("#endTaskContainer") ||
                    target.closest("nav")
                ) {
                    return;
                }
                this.clearSelection();
            }
        });

        document.addEventListener("mousemove", (e) => {
            if (this.isDragging) {
                this.handleDragMove(e);
            }
        });

        document.addEventListener("mouseup", () => {
            if (this.isDragging) {
                this.handleDragEnd();
            }
        });

        // Global keyboard shortcuts
        document.addEventListener("keydown", (e) => {
            const target = e.target as HTMLElement;
            if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;

            if ((e.ctrlKey || e.metaKey) && e.code === "KeyA") {
                const found = document.querySelector<HTMLElement>(this.config.containerSelector);
                if (!found || found.offsetParent === null) return;

                e.preventDefault();
                this.selectedIds = new Set(this.getSelectableIds());
                this.notifyItemsUpdate();
                this.config.onSelectionChange(this.getSelectedItems());
            }
        });
    }

    handleItemSelection(item: HTMLElement, event: MouseEvent): void {
        if (!this.config.isItemSelectable(item)) return;
        const id = this.config.getItemId(item);
        if (!id) return;

        if (event.shiftKey) {
            if (this.selectionAnchorId) {
                this.handleRangeSelection(id, this.selectionAnchorId);
            } else {
                const allIds = this.getSelectableIds();
                if (allIds.length > 0) {
                    // Matches standard explorer behavior
                    this.selectionAnchorId = allIds[0]!;
                    this.handleRangeSelection(id, this.selectionAnchorId);
                } else {
                    this.selectionAnchorId = id;
                    this.toggleItemSelection(item, true);
                }
            }
            this.lastSelectedId = id;
        } else if (event.ctrlKey || event.metaKey) {
            this.toggleItemSelection(item, !this.selectedIds.has(id));
            this.lastSelectedId = id;
            this.selectionAnchorId = id;
        } else {
            this.clearSelection(false);
            this.toggleItemSelection(item, true);
            this.lastSelectedId = id;
            this.selectionAnchorId = id;
        }

        this.config.onSelectionChange(this.getSelectedItems());
    }

    notifyItemsUpdate(): void {
        const container = document.querySelector(this.config.containerSelector);
        if (!container) return;
        const items = container.querySelectorAll<HTMLElement>(this.config.itemSelector);
        items.forEach((item) => {
            const id = this.config.getItemId(item);
            if (id) this.updateElementClasses(item, this.selectedIds.has(id));
        });
    }

    handleDragStart(event: MouseEvent, item: HTMLElement): void {
        if (!this.config.isItemSelectable(item)) return;
        if (event.button !== 0 || event.shiftKey || event.ctrlKey || event.metaKey) return;

        this.isDragging = true;
        this.dragStartId = this.config.getItemId(item) ?? null;

        this.dragAllIdsCache = this.getSelectableIds();

        if (this.dragStartId && !this.selectedIds.has(this.dragStartId)) {
            this.clearSelection(false);
            this.selectionAnchorId = this.dragStartId;
            this.toggleItemSelection(item, true);
        }

        event.preventDefault();
    }

    handleDragMove(event: MouseEvent): void {
        if (!this.isDragging || !this.dragStartId) return;

        this.lastClientY = event.clientY;
        this.lastTargetItem = (event.target as HTMLElement).closest<HTMLElement>(this.config.itemSelector);
        this.processDragSelection();

        const container = document.querySelector(this.config.containerSelector)!;
        const scrollThreshold = 60;
        const maxScrollSpeed = 80;
        const scrollContainer = container.closest<HTMLElement>(".overflow-auto");

        if (scrollContainer) {
            const containerRect = scrollContainer.getBoundingClientRect();
            const distFromTop = this.lastClientY - containerRect.top;
            const distFromBottom = containerRect.bottom - this.lastClientY;

            if (distFromTop < scrollThreshold) {
                const multiplier = Math.min(1, Math.max(0, (scrollThreshold - distFromTop) / scrollThreshold));
                this.currentScrollSpeed = -maxScrollSpeed * multiplier;
            } else if (distFromBottom < scrollThreshold) {
                const multiplier = Math.min(1, Math.max(0, (scrollThreshold - distFromBottom) / scrollThreshold));
                this.currentScrollSpeed = maxScrollSpeed * multiplier;
            } else {
                this.currentScrollSpeed = 0;
            }

            if (this.currentScrollSpeed !== 0) {
                this.startScrollAnimation(scrollContainer);
            }
        }
    }

    private processDragSelection(): void {
        if (!this.isDragging || !this.dragStartId || this.lastClientY === null) return;
        const container = document.querySelector(this.config.containerSelector)!;
        let targetItem = this.lastTargetItem;

        if (!targetItem || !container.contains(targetItem)) {
            const items = [...container.querySelectorAll<HTMLElement>(this.config.itemSelector)].filter((item) =>
                this.config.isItemSelectable(item),
            );
            if (items.length > 0) {
                if (this.lastClientY <= items[0]!.getBoundingClientRect().top) {
                    targetItem = items[0]!;
                } else if (this.lastClientY >= items.at(-1)!.getBoundingClientRect().bottom) {
                    targetItem = items.at(-1)!;
                } else {
                    targetItem =
                        items.find((item) => {
                            const rect = item.getBoundingClientRect();
                            return this.lastClientY! >= rect.top && this.lastClientY! <= rect.bottom;
                        }) ?? null;
                }
            }
        }

        if (targetItem) {
            const targetId = this.config.getItemId(targetItem);
            if (targetId && targetId !== this.lastSelectedId) {
                this.handleRangeSelection(targetId, this.dragStartId);
            }
        }

        this.lastTargetItem = null;
    }

    handleDragEnd(): void {
        this.isDragging = false;
        this.dragStartId = null;
        this.dragAllIdsCache = null;
        this.currentScrollSpeed = 0;
        if (this.scrollAnimationFrame) {
            cancelAnimationFrame(this.scrollAnimationFrame);
            this.scrollAnimationFrame = null;
        }
        this.config.onSelectionChange(this.getSelectedItems());
    }

    startScrollAnimation(scrollContainer: HTMLElement): void {
        if (this.scrollAnimationFrame) return;

        const animate = () => {
            if (!this.isDragging || this.currentScrollSpeed === 0) {
                this.scrollAnimationFrame = null;
                return;
            }

            scrollContainer.scrollTop += this.currentScrollSpeed;

            requestAnimationFrame(() => {
                this.processDragSelection();
            });

            this.scrollAnimationFrame = requestAnimationFrame(animate);
        };

        this.scrollAnimationFrame = requestAnimationFrame(animate);
    }

    handleRangeSelection(targetId: string, anchorId: string): void {
        const allIds = this.dragAllIdsCache ?? this.getSelectableIds();
        const currentIndex = allIds.indexOf(targetId);
        const anchorIndex = allIds.indexOf(anchorId);

        if (currentIndex === -1 || anchorIndex === -1) return;

        const start = Math.min(currentIndex, anchorIndex);
        const end = Math.max(currentIndex, anchorIndex);

        this.selectedIds = new Set(allIds.slice(start, end + 1));
        this.lastSelectedId = targetId;
        this.notifyItemsUpdate();
        this.config.onSelectionChange(this.getSelectedItems());
    }

    clearSelection(notify = true): void {
        this.selectedIds.clear();
        this.lastSelectedId = null;
        this.selectionAnchorId = null;
        this.notifyItemsUpdate();
        if (notify) this.config.onSelectionChange(this.getSelectedItems());
    }

    getSelectedItems(): string[] {
        return [...this.selectedIds];
    }

    toggleItemSelection(item: HTMLElement, add: boolean): void {
        const id = this.config.getItemId(item);
        if (!id) return;
        if (add) this.selectedIds.add(id);
        else this.selectedIds.delete(id);
        this.updateElementClasses(item, add);
    }

    getItemClasses(id: string): string {
        if (this.selectedIds.has(id)) {
            return [...this.classes.selected, ...this.classes.selectedHover].join(" ");
        }
        return this.classes.defaultHover.join(" ");
    }

    updateElementClasses(item: HTMLElement, isSelected: boolean): void {
        if (isSelected) {
            item.classList.add(...this.classes.selected, ...this.classes.selectedHover);
            item.classList.remove(...this.classes.defaultHover);
        } else {
            item.classList.remove(...this.classes.selected, ...this.classes.selectedHover);
            item.classList.add(...this.classes.defaultHover);
        }
    }
}
