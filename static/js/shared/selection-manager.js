import { isTypingField } from "./dom-helpers.js";

class SelectionManager {
    constructor(config) {
        this.selectedIds = new Set();
        this.lastSelectedId = null;
        this.selectionAnchorId = null;
        this.isDragging = false;
        this.dragStartId = null;
        this.scrollAnimationFrame = null;
        this.currentScrollSpeed = 0;
        this.config = {
            containerSelector: "",
            itemSelector: "tr:not(.virtual-spacer)",
            selectedClass: "bg-zinc-800/80 ring-1 ring-inset ring-zinc-700/50",
            defaultHoverClass: "hover:bg-zinc-800",
            selectedHoverClass: "hover:bg-zinc-700!",
            disabledClass: "cursor-not-allowed opacity-50",
            getItemId: (element) => element.dataset.id,
            isItemSelectable: (element) => !element.classList.contains("cursor-not-allowed"),
            getAllIds: null,
            onSelectionChange: () => {},
            ...config,
        };

        this.classes = {
            selected: this.config.selectedClass.split(" ").filter(Boolean),
            defaultHover: this.config.defaultHoverClass.split(" ").filter(Boolean),
            selectedHover: this.config.selectedHoverClass.split(" ").filter(Boolean),
        };
    }

    _getSelectableIds() {
        if (this.config.getAllIds) {
            return this.config.getAllIds() || [];
        }

        const container = document.querySelector(this.config.containerSelector);
        if (!container) return [];
        return Array.from(container.querySelectorAll(this.config.itemSelector))
            .filter((el) => this.config.isItemSelectable(el))
            .map((el) => this.config.getItemId(el))
            .filter(Boolean);
    }

    initialize() {
        const container = document.querySelector(this.config.containerSelector);
        if (!container) return;

        container.addEventListener("mousedown", (e) => {
            const item = e.target.closest(this.config.itemSelector);
            if (item && this.config.getItemId(item)) {
                if (e.button === 0) {
                    if (isTypingField(document.activeElement)) document.activeElement.blur();
                    this.handleItemSelection(item, e);
                    this.handleDragStart(e, item);
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
            const container = document.querySelector(this.config.containerSelector);
            if (container && !container.contains(e.target)) {
                const scrollContainer = container.closest(".overflow-auto") || container;
                const rect = scrollContainer.getBoundingClientRect();

                const isInside =
                    e.clientX >= rect.left &&
                    e.clientX <= rect.right &&
                    e.clientY >= rect.top &&
                    e.clientY <= rect.bottom;
                if (
                    isInside &&
                    (e.clientX > rect.left + scrollContainer.clientWidth ||
                        e.clientY > rect.top + scrollContainer.clientHeight)
                ) {
                    return;
                }

                if (
                    e.target.closest(".context-menu") ||
                    e.target.closest("#fileActionsBar") ||
                    e.target.closest("#endTaskContainer") ||
                    e.target.closest("nav")
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
            if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;

            if ((e.ctrlKey || e.metaKey) && e.code === "KeyA") {
                const container = document.querySelector(this.config.containerSelector);
                if (!container || container.offsetParent === null) return;

                e.preventDefault();
                this.selectedIds = new Set(this._getSelectableIds());
                this.notifyItemsUpdate();
                this.config.onSelectionChange(this.getSelectedItems());
            }
        });
    }

    handleItemSelection(item, event) {
        if (!this.config.isItemSelectable(item)) return;
        const id = this.config.getItemId(item);

        if (event.shiftKey) {
            if (!this.selectionAnchorId) {
                let allIds = this._getSelectableIds();
                if (allIds.length > 0) {
                    this.selectionAnchorId = allIds[0]; // matches standard explorer behavior
                    this.handleRangeSelection(id, this.selectionAnchorId);
                } else {
                    this.selectionAnchorId = id;
                    this.toggleItemSelection(item, true);
                }
            } else {
                this.handleRangeSelection(id, this.selectionAnchorId);
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

    notifyItemsUpdate() {
        const container = document.querySelector(this.config.containerSelector);
        if (!container) return;
        const items = container.querySelectorAll(this.config.itemSelector);
        items.forEach((item) => {
            const id = this.config.getItemId(item);
            if (id) this.updateElementClasses(item, this.selectedIds.has(id));
        });
    }

    handleDragStart(event, item) {
        if (!this.config.isItemSelectable(item)) return;
        if (event.button !== 0 || event.shiftKey || event.ctrlKey || event.metaKey) return;

        this.isDragging = true;
        this.dragStartId = this.config.getItemId(item);

        this.dragAllIdsCache = this._getSelectableIds();

        if (!this.selectedIds.has(this.dragStartId)) {
            this.clearSelection(false);
            this.selectionAnchorId = this.dragStartId;
            this.toggleItemSelection(item, true);
        }

        event.preventDefault();
    }

    handleDragMove(event) {
        if (!this.isDragging || !this.dragStartId) return;

        this.lastClientY = event.clientY;
        this.lastTargetItem = event.target.closest(this.config.itemSelector);
        this._processDragSelection();

        const container = document.querySelector(this.config.containerSelector);
        const scrollThreshold = 60;
        const maxScrollSpeed = 80;
        const scrollContainer = container.closest(".overflow-auto");

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

    _processDragSelection() {
        if (!this.isDragging || !this.dragStartId || this.lastClientY == null) return;
        const container = document.querySelector(this.config.containerSelector);
        let targetItem = this.lastTargetItem;

        if (!targetItem || !container.contains(targetItem)) {
            const items = Array.from(container.querySelectorAll(this.config.itemSelector)).filter((item) =>
                this.config.isItemSelectable(item),
            );
            if (items.length > 0) {
                if (this.lastClientY <= items[0].getBoundingClientRect().top) {
                    targetItem = items[0];
                } else if (this.lastClientY >= items[items.length - 1].getBoundingClientRect().bottom) {
                    targetItem = items[items.length - 1];
                } else {
                    targetItem = items.find((item) => {
                        const rect = item.getBoundingClientRect();
                        return this.lastClientY >= rect.top && this.lastClientY <= rect.bottom;
                    });
                }
            }
        }

        if (targetItem) {
            const targetId = this.config.getItemId(targetItem);
            if (targetId !== this.lastSelectedId) {
                this.handleRangeSelection(targetId, this.dragStartId);
            }
        }

        this.lastTargetItem = null;
    }

    handleDragEnd() {
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

    startScrollAnimation(scrollContainer) {
        if (this.scrollAnimationFrame) return;

        const animate = () => {
            if (!this.isDragging || this.currentScrollSpeed === 0) {
                this.scrollAnimationFrame = null;
                return;
            }

            scrollContainer.scrollTop += this.currentScrollSpeed;

            requestAnimationFrame(() => this._processDragSelection());

            this.scrollAnimationFrame = requestAnimationFrame(animate);
        };

        this.scrollAnimationFrame = requestAnimationFrame(animate);
    }

    handleRangeSelection(targetId, anchorId) {
        let allIds = this.dragAllIdsCache || this._getSelectableIds();
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

    clearSelection(notify = true) {
        this.selectedIds.clear();
        this.lastSelectedId = null;
        this.selectionAnchorId = null;
        this.notifyItemsUpdate();
        if (notify) this.config.onSelectionChange(this.getSelectedItems());
    }

    getSelectedItems() {
        return Array.from(this.selectedIds);
    }

    toggleItemSelection(item, add) {
        const id = this.config.getItemId(item);
        if (!id) return;
        if (add) this.selectedIds.add(id);
        else this.selectedIds.delete(id);
        this.updateElementClasses(item, add);
    }

    getItemClasses(id) {
        if (this.selectedIds.has(id)) {
            return [...this.classes.selected, ...this.classes.selectedHover].join(" ");
        }
        return this.classes.defaultHover.join(" ");
    }

    updateElementClasses(item, isSelected) {
        if (isSelected) {
            item.classList.add(...this.classes.selected, ...this.classes.selectedHover);
            item.classList.remove(...this.classes.defaultHover);
        } else {
            item.classList.remove(...this.classes.selected, ...this.classes.selectedHover);
            item.classList.add(...this.classes.defaultHover);
        }
    }
}

export { SelectionManager };
