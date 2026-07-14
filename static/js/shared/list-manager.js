import { SelectionManager } from "./selection-manager.js";
import { ContextMenuManager } from "./context-menu.js";

const CLASSES = {
    row: "cursor-pointer",
    noAccess: "is-inaccessible",
    defaultHover: "hover:bg-zinc-800",
};

class ListManager {
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

        window.addEventListener(
            "scroll",
            () => {
                this.contextMenu.hide();
            },
            { capture: true, passive: true },
        );
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

export { ListManager, CLASSES };
