// static/js/modules/utils.js
async function apiCall(endpoint, method = "GET", data = null) {
    const options = {
        method,
        headers: {},
    };
    if (data) {
        if (data instanceof FormData) {
            options.body = data;
        } else {
            options.headers["Content-Type"] = "application/json";
            options.body = JSON.stringify(data);
        }
    }

    const response = await fetch(endpoint, options);

    if (response.status === 401) {
        window.location.href = "/login";
        return;
    }

    if (!response.ok) {
        const contentType = response.headers.get("content-type");
        if (contentType && contentType.includes("application/json")) {
            const errData = await response.json();
            throw new Error(errData.message || `API Error: ${response.status}`);
        }
        throw new Error(`HTTP error! status: ${response.status}`);
    }

    return response.json();
}

function formatFileSize(bytes) {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

function formatDate(timestamp) {
    const date = new Date(timestamp);
    return date.toLocaleString();
}

const SVG_TEMPLATES = {
    folder: (colorClass = "text-zinc-400") => `
        <svg class="w-4 h-4 ${colorClass}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-width="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/>
        </svg>`,
    file: () => `
        <svg class="w-4 h-4 text-zinc-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-width="2" d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M9 5a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2M9 5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2m-3 7h3m-3 4h3m-6-4h0m0 4h0"/>
        </svg>`,
    spinner: (size = 4) => {
        const rem = size * 0.25;
        return `
        <svg style="width:${rem}rem;height:${rem}rem" class="animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke-width="4"/>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 0 1 8-8V0C5 0 0 5 0 12zm2 5a8 8 0 0 1-2-5H0c0 3 1 6 3 8z"/>
        </svg>`;
    },
    upload: (size = 10, colorClass = "text-zinc-600") => {
        const rem = size * 0.25;
        return `
        <svg style="width:${rem}rem;height:${rem}rem" class="mx-auto mb-2 ${colorClass}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-width="2" d="M4 16v1a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-1m-4-8-4-4m0 0L8 8m4-4v12"/>
        </svg>`;
    },
    cross: () => `
        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
        </svg>`,
};

const CLASSES = {
    row: "cursor-pointer",
    noAccess: "is-inaccessible",
    defaultHover: "hover:bg-zinc-800",
};

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
                    e.target.closest("#fileOperations") ||
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
                    this.selectionAnchorId = allIds[0];
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
        const maxScrollSpeed = 15;
        const scrollContainer = container.closest(".overflow-auto");

        if (scrollContainer) {
            const containerRect = scrollContainer.getBoundingClientRect();

            if (this.lastClientY < containerRect.top + scrollThreshold) {
                const distance = this.lastClientY - containerRect.top;
                this.currentScrollSpeed = -maxScrollSpeed * Math.max(0, (scrollThreshold - distance) / scrollThreshold);
            } else if (this.lastClientY > containerRect.bottom - scrollThreshold) {
                const distance = containerRect.bottom - this.lastClientY;
                this.currentScrollSpeed = maxScrollSpeed * Math.max(0, (scrollThreshold - distance) / scrollThreshold);
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

// Context menu manager
class ContextMenuManager {
    constructor(config) {
        this.menuElement = null;
        this.config = {
            menuClass: "context-menu",
            menuItemClass:
                "px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100 rounded-md cursor-pointer select-none transition-colors",
            getMenuItems: () => [],
            ...config,
        };
    }

    hide() {
        if (this.menuElement) {
            this.menuElement.remove();
            this.menuElement = null;
        }
    }

    show(x, y, context) {
        this.hide();

        const items = this.config.getMenuItems(context);
        if (!items.length) return;

        this.menuElement = document.createElement("div");
        this.menuElement.classList.add(this.config.menuClass);
        this.menuElement.style.position = "fixed";
        this.menuElement.style.left = `${x}px`;
        this.menuElement.style.top = `${y}px`;
        this.menuElement.style.zIndex = "30";

        const ul = document.createElement("ul");
        ul.className =
            "bg-zinc-900 border border-zinc-800 rounded-lg p-1 shadow-lg min-w-[140px] flex flex-col gap-0.5";

        items.forEach((item) => {
            const li = document.createElement("li");
            li.className = this.config.menuItemClass;
            li.textContent = item.label;
            li.addEventListener("click", () => {
                item.action();
                this.hide();
            });
            ul.appendChild(li);
        });

        this.menuElement.appendChild(ul);
        document.body.appendChild(this.menuElement);
    }
}

class UIManager {
    constructor(config) {
        this.config = {
            containerSelector: "",
            isContextMenuEnabled: true,
            isSelectionEnabled: true,
            getContextMenuItems: () => [],
            onSelectionChange: () => {},
            ...config,
        };

        this.selectionManager = this.config.isSelectionEnabled
            ? new SelectionManager({
                  containerSelector: this.config.containerSelector,
                  itemSelector: this.config.itemSelector || "tr",
                  getItemId: this.config.getItemId,
                  ...(this.config.isItemSelectable ? { isItemSelectable: this.config.isItemSelectable } : {}),
                  onSelectionChange: (items) => {
                      this.config.onSelectionChange(items);
                  },
              })
            : null;

        this.contextMenu = this.config.isContextMenuEnabled
            ? new ContextMenuManager({
                  getMenuItems: this.config.getContextMenuItems,
              })
            : null;
    }

    initialize() {
        if (this.selectionManager) {
            this.selectionManager.initialize();
        }

        this.initializeContextMenu();
        this.initializePreventDefaults();
    }

    initializeContextMenu() {
        if (!this.config.isContextMenuEnabled || !this.contextMenu) return;

        const container = document.querySelector(this.config.containerSelector);
        if (!container) return;

        container.addEventListener("contextmenu", (event) => {
            event.preventDefault();
            const row = event.target.closest(this.config.itemSelector || "tr");
            if (!row || !row.dataset?.[this.config.itemDataAttribute || "path"]) return;

            if (!this.selectionManager?.selectedIds.has(this.selectionManager?.config.getItemId(row))) {
                this.selectionManager?.clearSelection(false);
                this.selectionManager?.toggleItemSelection(row, true);
                this.config.onSelectionChange(this.selectionManager?.getSelectedItems() || []);
            }

            this.contextMenu.show(event.clientX, event.clientY);
        });

        document.addEventListener("click", (event) => {
            if (!event.target.closest(".context-menu")) {
                this.contextMenu.hide();
            }
        });
    }

    initializePreventDefaults() {
        const container = document.querySelector(this.config.containerSelector);
        if (!container) return;

        container.addEventListener("mousedown", (event) => {
            event.preventDefault();
        });

        container.addEventListener("selectstart", (event) => {
            event.preventDefault();
        });
    }

    getSelectedItems() {
        return this.selectionManager?.getSelectedItems() || [];
    }

    clearSelection() {
        this.selectionManager?.clearSelection();
    }
}

class BaseFileManager extends UIManager {
    constructor() {
        super({
            containerSelector: "#fileList",
            itemDataAttribute: "path",
            getItemId: (element) => element.dataset.path,
            getContextMenuItems: (context) => {
                const selectedItems = context?.selectedItems || this.getSelectedItems();
                if (!selectedItems.length) return [];

                const items = [];
                const singleItem = selectedItems.length === 1;

                items.push({
                    label: "Download",
                    action: () => this.handleDownload(selectedItems),
                });

                if (singleItem) {
                    items.push({
                        label: "Rename",
                        action: () => this.openRenameModal(selectedItems[0]),
                    });
                }

                items.push({
                    label: "Delete",
                    action: () => this.handleDelete(selectedItems),
                });

                return items;
            },
            onSelectionChange: () => this.updateFileOperationsUI(),
        });
    }
}

class BaseTaskManager extends UIManager {
    constructor(config = {}) {
        const onKillProcess = config.onKillProcess || (() => {});
        const customGetMenuItems = config.getContextMenuItems;
        super({
            containerSelector: "#taskList",
            itemDataAttribute: "pid",
            getItemId: (element) => element.dataset.pid,
            isItemSelectable: (_element) => true,
            getContextMenuItems: () => {
                const selected = this.getSelectedItems();
                const defaultItems =
                    selected.length > 0
                        ? [
                              {
                                  label: "End Task",
                                  action: () => {
                                      onKillProcess(selected);
                                  },
                              },
                          ]
                        : [];

                if (customGetMenuItems) {
                    return customGetMenuItems(defaultItems, selected);
                }
                return defaultItems;
            },
            onSelectionChange: (selectedItems) => {
                const endTaskContainer = document.getElementById("endTaskContainer");
                endTaskContainer.classList.toggle("hidden", selectedItems.length === 0);
            },
        });
    }
}

const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" };
const escapeHtml = (str) => (str || "").replace(/[&<>"']/g, (m) => HTML_ESCAPES[m]);

export { apiCall, formatFileSize, formatDate, SVG_TEMPLATES, CLASSES, BaseFileManager, BaseTaskManager, escapeHtml };
