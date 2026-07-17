import { SelectionManager } from "./selection-manager.ts";
import { type ContextMenuItem, ContextMenuManager } from "./context-menu.ts";

export const CLASSES = {
    defaultHover: "hover:bg-zinc-800",
    noAccess: "is-inaccessible",
    row: "cursor-pointer",
};

export interface ContextMenuContext {
    selectedItems?: string[];
}

export interface ListManagerConfig {
    containerSelector: string;
    itemSelector?: string;
    itemDataAttribute?: string;
    isContextMenuEnabled?: boolean;
    isSelectionEnabled?: boolean;
    getItemId?: (element: HTMLElement) => string | undefined;
    isItemSelectable?: (element: HTMLElement) => boolean;
    getContextMenuItems?: (context?: ContextMenuContext) => ContextMenuItem[];
    onSelectionChange?: (items: string[]) => void;
}

type ResolvedListManagerConfig = ListManagerConfig &
    Required<
        Pick<
            ListManagerConfig,
            "getContextMenuItems" | "isContextMenuEnabled" | "isSelectionEnabled" | "onSelectionChange"
        >
    >;

export class ListManager {
    config: ResolvedListManagerConfig;
    selectionManager: SelectionManager | null;
    contextMenu: ContextMenuManager<ContextMenuContext> | null;

    constructor(config: ListManagerConfig) {
        this.config = {
            getContextMenuItems: () => [],
            isContextMenuEnabled: true,
            isSelectionEnabled: true,
            onSelectionChange: () => {},
            ...config,
        };

        this.selectionManager = this.config.isSelectionEnabled
            ? new SelectionManager({
                  containerSelector: this.config.containerSelector,
                  itemSelector: this.config.itemSelector ?? "tr",
                  getItemId: this.config.getItemId,
                  ...(this.config.isItemSelectable ? { isItemSelectable: this.config.isItemSelectable } : {}),
                  onSelectionChange: (items) => {
                      this.config.onSelectionChange(items);
                  },
              })
            : null;

        this.contextMenu = this.config.isContextMenuEnabled
            ? new ContextMenuManager<ContextMenuContext>({
                  getMenuItems: this.config.getContextMenuItems,
              })
            : null;
    }

    initialize(): void {
        if (this.selectionManager) {
            this.selectionManager.initialize();
        }

        this.initializeContextMenu();
        this.initializePreventDefaults();
    }

    initializeContextMenu(): void {
        if (!this.config.isContextMenuEnabled || !this.contextMenu) return;

        const container = document.querySelector(this.config.containerSelector);
        if (!container) return;

        container.addEventListener("contextmenu", (event) => {
            event.preventDefault();
            const target = event.target as HTMLElement;
            const row = target.closest<HTMLElement>(this.config.itemSelector ?? "tr");
            if (!row || !row.dataset?.[this.config.itemDataAttribute ?? "path"]) return;

            const rowId = this.selectionManager?.config.getItemId(row);
            if (rowId && !this.selectionManager?.selectedIds.has(rowId)) {
                this.selectionManager?.clearSelection(false);
                this.selectionManager?.toggleItemSelection(row, true);
                this.config.onSelectionChange(this.selectionManager?.getSelectedItems() ?? []);
            }

            this.contextMenu!.show((event as MouseEvent).clientX, (event as MouseEvent).clientY);
        });

        document.addEventListener("click", (event) => {
            if (!(event.target as HTMLElement).closest(".context-menu")) {
                this.contextMenu!.hide();
            }
        });

        window.addEventListener(
            "scroll",
            () => {
                this.contextMenu!.hide();
            },
            { capture: true, passive: true },
        );
    }

    initializePreventDefaults(): void {
        const container = document.querySelector(this.config.containerSelector);
        if (!container) return;

        container.addEventListener("mousedown", (event) => {
            event.preventDefault();
        });

        container.addEventListener("selectstart", (event) => {
            event.preventDefault();
        });
    }

    getSelectedItems(): string[] {
        return this.selectionManager?.getSelectedItems() ?? [];
    }

    clearSelection(): void {
        this.selectionManager?.clearSelection();
    }
}
