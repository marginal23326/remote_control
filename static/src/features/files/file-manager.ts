import { apiCall } from "@/shared/api";
import { CLASSES, type ContextMenuContext, ListManager } from "@/shared/list-manager";
import type { ContextMenuItem } from "@/shared/context-menu";
import { formatDate, formatFileSize } from "@/shared/format";
import {
    bindDebouncedInput,
    byId,
    escapeHtml,
    updateSortIndicators as renderSortIndicators,
} from "@/shared/dom-helpers";
import { showConfirmModal, showPromptModal } from "@/shared/modal";
import { LoadingButton, showNotification } from "@/shared/feedback";
import { registerShortcuts } from "@/core/shortcuts";
import { getParentPath, getSeparator, joinPath } from "./path-utils";
import { renderBreadcrumbs } from "./breadcrumbs";
import { AccessChecker } from "./access-checker";
import { uploadFiles } from "./upload-service";
import { DropZone } from "./drop-zone";
import { computeVisibleRange, renderEmptyRow, renderFileRow, renderSpacerRow } from "./file-list-renderer";
import type { ApiMessageResponse, FileListItem, RenderableFileItem } from "@/shared/types";

type SortColumn = "name" | "size" | "modified";
type SortDirection = "asc" | "desc";

interface FileManagerElements {
    fileList: HTMLElement | null;
    currentPath: HTMLElement | null;
    searchInput: HTMLInputElement | null;
    scrollContainer: HTMLElement | null;
}

class FileManager extends ListManager {
    currentPath = "";
    navigationHistory: string[] = [];
    currentFileList: RenderableFileItem[] = [];
    filteredList: RenderableFileItem[] = [];
    collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
    sortColumn: SortColumn = "name";
    sortDirection: SortDirection = "asc";
    buttons: Record<string, LoadingButton> = {};
    dropZone: DropZone | null = null;
    elements: FileManagerElements = {
        currentPath: null,
        fileList: null,
        scrollContainer: null,
        searchInput: null,
    };
    rowHeight = 21;
    rowHeightNeedsUpdate = true;
    buffer = 15;
    resizeObserver: ResizeObserver | null = null;
    lastRenderedRange = { start: -1, end: -1 };
    ticking = false;
    isLoading = false;
    scrollToPath: string | null = null;
    currentUploadXhr: XMLHttpRequest | null = null;
    accessChecker!: AccessChecker;
    lastContainerHeight = 0;
    private navToken = 0;
    private hasError = false;

    constructor() {
        super({
            containerSelector: "#fileList",
            getContextMenuItems: (context?: ContextMenuContext) => {
                const selectedItems = context?.selectedItems ?? this.getSelectedItems();
                if (selectedItems.length === 0) return [];

                const items: ContextMenuItem[] = [
                    {
                        label: "Download",
                        action: () => {
                            this.handleDownload(selectedItems);
                        },
                    },
                ];

                if (selectedItems.length === 1) {
                    items.push({
                        label: "Rename (F2)",
                        action: () => {
                            this.renameSelectedItem();
                        },
                    });
                }

                items.push({ label: "Delete (Del)", action: () => this.handleDelete(selectedItems) });
                return items;
            },
            getItemId: (element) => element.dataset.path,
            itemDataAttribute: "path",
            onSelectionChange: () => {
                this.updateFileOperationsUI();
            },
        });

        this.accessChecker = new AccessChecker({
            checkAccess: (batch) => apiCall<string[]>(`/api/files/check-access`, "POST", batch),
            getVisiblePaths: () => {
                const { start, end } = this.lastRenderedRange;
                return new Set(
                    this.filteredList
                        .slice(Math.max(0, start), end)
                        .filter((i) => i.is_dir)
                        .map((i) => i.path),
                );
            },
            onResolved: (path, accessible) => {
                if (!accessible) {
                    const row = this.elements.fileList!.querySelector(`tr[data-path=${CSS.escape(path)}]`);
                    if (row) row.classList.add(CLASSES.noAccess);
                }
            },
        });
    }

    initializeElements(): void {
        this.elements.fileList = byId("fileList");
        this.elements.currentPath = byId("currentPath");
        this.elements.searchInput = byId<HTMLInputElement>("searchInput");
        this.elements.scrollContainer = this.elements.fileList!.closest<HTMLElement>(".overflow-auto");

        if (this.elements.scrollContainer) {
            this.elements.scrollContainer.addEventListener("scroll", () => {
                if (!this.ticking) {
                    window.requestAnimationFrame(() => {
                        this.renderViewport();
                        this.ticking = false;
                    });
                    this.ticking = true;
                }
            });

            this.lastContainerHeight = this.elements.scrollContainer?.clientHeight || 0;
            this.resizeObserver = new ResizeObserver(() => {
                if (this.filteredList.length > 0) {
                    const newHeight = this.elements.scrollContainer!.clientHeight || 0;
                    if (newHeight !== this.lastContainerHeight) {
                        this.lastContainerHeight = newHeight;
                        this.rowHeightNeedsUpdate = true;
                        window.requestAnimationFrame(() => {
                            this.renderViewport(true);
                        });
                    }
                }
            });
            this.resizeObserver.observe(this.elements.scrollContainer);
        }
    }

    initializeButtons(): void {
        const buttonConfigs: Record<string, string> = {
            deleteItem: "Deleting...",
            downloadFile: "Downloading...",
            refresh: "",
        };

        this.buttons = Object.fromEntries(
            Object.entries(buttonConfigs)
                .map(([id, loadingText]): [string, LoadingButton] | null => {
                    const button = byId<HTMLButtonElement>(id);
                    if (button) {
                        button.classList.add(
                            "inline-flex",
                            "items-center",
                            "justify-center",
                            "gap-1.5",
                            "whitespace-nowrap",
                        );
                        return [id, new LoadingButton(button, loadingText)];
                    }
                    return null;
                })
                .filter((entry): entry is [string, LoadingButton] => entry !== null),
        );
    }

    async handleFileUpload(files: FileList, isDropZone = false): Promise<void> {
        if (files.length === 0) return;

        if (!this.currentPath) {
            showNotification("Please navigate to a directory before uploading files.", "error");
            return;
        }

        if (isDropZone) this.dropZone!.setLoading();

        const uploadLabel = document.querySelector('label[for="fileUpload"] span');
        const cancelBtn = byId("cancelUpload");
        if (uploadLabel) uploadLabel.textContent = "Uploading... 0%";
        if (cancelBtn) cancelBtn.classList.remove("hidden");

        try {
            const { promise, xhr } = uploadFiles(this.currentPath, files, {
                onProgress: (pct) => {
                    if (uploadLabel) uploadLabel.textContent = `Uploading... ${pct}%`;
                },
            });
            this.currentUploadXhr = xhr;
            const response = await promise;

            if (response.message) showNotification(response.message, "info");

            if (response.count !== files.length) {
                showNotification(
                    `Only ${response.count} of ${files.length} files were uploaded successfully.`,
                    "warning",
                );
            }

            const lastFile = files[files.length - 1]!.name;
            const scrollToPath = joinPath(this.currentPath, lastFile);
            await this.listFiles(this.currentPath, scrollToPath);
        } catch (error) {
            if ((error as Error).name === "AbortError") {
                showNotification("Upload cancelled", "info");
                await this.listFiles(this.currentPath);
            } else {
                console.error(`Error in upload:`, error);
                showNotification(`Error: ${(error as Error).message}`, "error");
            }
        } finally {
            this.currentUploadXhr = null;
            if (isDropZone) this.dropZone!.reset();
            if (uploadLabel) uploadLabel.textContent = "Upload";
            if (cancelBtn) cancelBtn.classList.add("hidden");

            const fileInput = byId<HTMLInputElement>("fileUpload");
            if (fileInput) fileInput.value = "";
        }
    }

    async handleApiCall(
        apiEndpoint: string,
        method: string,
        data: unknown,
        successCallback?: (response: ApiMessageResponse) => void | Promise<void>,
    ): Promise<void> {
        try {
            const response = await apiCall<ApiMessageResponse>(apiEndpoint, method, data);
            if (response.message) showNotification(response.message, "info");
            void successCallback?.(response);
        } catch (error) {
            console.error(`Error in ${apiEndpoint}:`, error);
            showNotification(`Error: ${(error as Error).message}`, "error");
        }
    }

    updateFileOperationsUI(): void {
        const selectedCount = this.selectionManager?.selectedIds?.size ?? 0;
        const hasSelection = selectedCount > 0;
        const downloadBtn = byId("downloadFile");
        const deleteBtn = byId("deleteItem");
        if (downloadBtn) downloadBtn.style.display = hasSelection ? "" : "none";
        if (deleteBtn) deleteBtn.style.display = hasSelection ? "" : "none";

        const countEl = byId("fileSelectionCount");
        if (countEl) {
            countEl.classList.toggle("hidden", !hasSelection);
            countEl.textContent = `${selectedCount} selected`;
        }
    }

    updateBreadcrumbs(): void {
        renderBreadcrumbs(this.elements.currentPath, this.currentPath, (path) => this.listFiles(path));
    }

    updateFileList(items: FileListItem[], scrollToPath: string | null = null): void {
        this.currentFileList = items.map((item) => ({
            ...item,
            _formattedDate: item.last_modified ? formatDate(item.last_modified) : "-",
            _formattedSize: item.is_dir ? "-" : formatFileSize(item.size ?? 0),
            _nameLower: item.name.toLowerCase(),
            _safeName: escapeHtml(item.name),
            _safePath: escapeHtml(item.path),
        }));

        this.scrollToPath = scrollToPath;
        this.applySortAndFilter();
    }

    selectPath(path: string): void {
        if (!this.selectionManager) return;
        this.selectionManager.clearSelection(false);
        this.selectionManager.selectedIds.add(path);
        this.selectionManager.lastSelectedId = path;
        this.selectionManager.selectionAnchorId = path;
        this.selectionManager.config.onSelectionChange(this.selectionManager.getSelectedItems());
    }

    applySortAndFilter(resetScroll = false): void {
        const term = (this.elements.searchInput?.value ?? "").toLowerCase();
        const list = this.currentFileList.filter((item) => !term || item._nameLower.includes(term));

        const dirMul = this.sortDirection === "asc" ? 1 : -1;
        list.sort((a, b) => {
            if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;

            if (this.sortColumn === "name") {
                return dirMul * this.collator.compare(a.name, b.name);
            }

            const key: "size" | "last_modified" = this.sortColumn === "modified" ? "last_modified" : "size";
            return dirMul * ((a[key] ?? 0) - (b[key] ?? 0));
        });

        this.filteredList = list;

        this.renderViewport(true);

        if (this.elements.scrollContainer) {
            if (this.scrollToPath && this.rowHeight > 0) {
                const index = this.filteredList.findIndex((i) => i.path === this.scrollToPath);
                if (index !== -1) {
                    const targetScroll = index * this.rowHeight;
                    const containerHeight = this.elements.scrollContainer.clientHeight;
                    const currentScroll = this.elements.scrollContainer.scrollTop;

                    if (
                        targetScroll < currentScroll ||
                        targetScroll > currentScroll + containerHeight - this.rowHeight
                    ) {
                        this.elements.scrollContainer.scrollTop = Math.max(0, targetScroll - containerHeight / 2);
                    }
                }
                this.scrollToPath = null;
            } else if (resetScroll) {
                this.elements.scrollContainer.scrollTop = 0;
            }
        }
    }

    renderViewport(force = false): void {
        if (!this.elements.scrollContainer || this.isLoading) return;

        if (this.rowHeightNeedsUpdate) {
            const firstRealRow = this.elements.fileList!.querySelector<HTMLElement>(`tr[data-path]`);
            if (firstRealRow) {
                const measured = firstRealRow.getBoundingClientRect().height;
                if (measured > 0) {
                    this.rowHeight = measured;
                    this.rowHeightNeedsUpdate = false;
                }
            }
        }

        const containerHeight = this.elements.scrollContainer.clientHeight || 500;
        const { scrollTop } = this.elements.scrollContainer;
        const totalItems = this.filteredList.length;
        const totalHeight = totalItems * this.rowHeight;

        const { startIndex, endIndex } = computeVisibleRange({
            buffer: this.buffer,
            containerHeight,
            rowHeight: this.rowHeight,
            scrollTop,
            totalItems,
        });

        if (!force && startIndex === this.lastRenderedRange.start && endIndex === this.lastRenderedRange.end) {
            return;
        }
        this.lastRenderedRange = { end: endIndex, start: startIndex };

        const paddingTop = startIndex * this.rowHeight;
        const paddingBottom = Math.max(0, totalHeight - endIndex * this.rowHeight);

        let html = "";
        if (paddingTop > 0) {
            html += renderSpacerRow(paddingTop);
        }

        for (let i = startIndex; i < endIndex; i++) {
            const item = this.filteredList[i];
            if (!item) continue;

            const cachedAccess = this.accessChecker.get(item.path);
            const accessCls = item.is_dir && cachedAccess === false ? CLASSES.noAccess : "";

            if (item.is_dir && cachedAccess === undefined) {
                this.accessChecker.queuePath(item.path);
            }

            const selectedCls = this.selectionManager
                ? this.selectionManager.getItemClasses(item.path)
                : CLASSES.defaultHover;

            html += renderFileRow(item, { accessCls, rowHeight: this.rowHeight, selectedCls });
        }

        if (totalItems === 0) {
            html += renderEmptyRow();
        }

        if (paddingBottom > 0) {
            html += renderSpacerRow(paddingBottom);
        }

        this.elements.fileList!.innerHTML = html;
    }

    async listFiles(
        path: string,
        scrollToPath: string | null = null,
        { skipHistory = false }: { skipHistory?: boolean } = {},
    ): Promise<void> {
        this.hasError = false;
        this.clearSelection();
        this.accessChecker.reset();
        this.scrollToPath = null;
        this.lastRenderedRange = { end: -1, start: -1 };
        this.updateFileOperationsUI();
        const fileList = byId("fileList")!;

        this.isLoading = true;
        const token = ++this.navToken;

        const isSamePath = path === this.currentPath;
        const previousPath = this.currentPath;

        if (!isSamePath) {
            this.currentFileList = [];
            this.filteredList = [];
            fileList.innerHTML = `<tr><td colspan="3" class="p-4 text-center text-zinc-400">Loading...</td></tr>`;
            this.setSearchMode(false);
        }

        try {
            const response = await apiCall<FileListItem[]>(`/api/files?path=${encodeURIComponent(path)}`);
            if (token !== this.navToken) return;
            this.isLoading = false;

            if (!isSamePath && !skipHistory) {
                this.navigationHistory.push(previousPath);
            }

            this.currentPath = path;
            this.updateBreadcrumbs();
            this.updateNavButtons();

            if (!isSamePath) {
                const sep = getSeparator(this.currentPath);
                const parent = path.endsWith(sep) ? path : path + sep;
                if (previousPath.startsWith(parent)) {
                    scrollToPath = previousPath;
                    this.selectPath(previousPath);
                }
            }

            this.updateFileList(response, scrollToPath);
        } catch (error) {
            if (token !== this.navToken) return;
            this.isLoading = false;
            this.hasError = true;
            console.error("Error listing files:", error);
            fileList.innerHTML = `<tr><td colspan="3" class="p-4 text-center text-red-400"></td></tr>`;
            fileList.querySelector("td")!.textContent = (error as Error).message;
        }
    }

    private async recoverFromError(): Promise<boolean> {
        if (!this.hasError) return false;
        this.hasError = false;
        await this.listFiles(this.currentPath, null, { skipHistory: true });
        return true;
    }

    async goBack(): Promise<void> {
        if (await this.recoverFromError()) return;
        if (this.navigationHistory.length === 0) return;
        const previous = this.navigationHistory.pop()!;
        await this.listFiles(previous, null, { skipHistory: true });
    }

    async goUp(): Promise<void> {
        if (this.currentPath === "") return;
        if (await this.recoverFromError()) return;
        await this.listFiles(getParentPath(this.currentPath));
    }

    async goHome(): Promise<void> {
        try {
            const { path } = await apiCall<{ path: string }>("/api/files/home");
            await this.listFiles(path);
        } catch (error) {
            showNotification(`Could not open home directory: ${(error as Error).message}`, "error");
        }
    }

    updateNavButtons(): void {
        const backBtn = byId<HTMLButtonElement>("navBackBtn");
        const upBtn = byId<HTMLButtonElement>("navUpBtn");
        if (backBtn) backBtn.disabled = this.navigationHistory.length === 0;
        if (upBtn) upBtn.disabled = this.currentPath === "";
    }

    handleDownload(paths: string[]): void {
        if (!paths || paths.length === 0) {
            showNotification("No files selected for download.", "warning");
            return;
        }

        let iframe = byId<HTMLIFrameElement>("global-download-iframe");
        if (!iframe) {
            iframe = document.createElement("iframe");
            iframe.id = "global-download-iframe";
            iframe.name = "global-download-iframe";
            iframe.style.display = "none";
            document.body.append(iframe);
        }

        iframe.addEventListener("load", () => {
            try {
                const text = iframe.contentDocument?.body?.textContent;
                if (text) {
                    const data = JSON.parse(text) as { status: string; message?: string };
                    if (data.status === "error") {
                        showNotification(data.message ?? "Download failed.", "error");
                    }
                }
            } catch {
                /* Ignore */
            }
        });

        const form = document.createElement("form");
        form.method = "POST";
        form.action = "/api/download";
        form.target = "global-download-iframe";
        form.style.display = "none";

        paths.forEach((path) => {
            const input = document.createElement("input");
            input.type = "hidden";
            input.name = "paths[]";
            input.value = path;
            form.append(input);
        });

        document.body.append(form);
        form.submit();
        form.remove();
    }

    async handleDelete(paths: string[]): Promise<void> {
        if (!paths || paths.length === 0) return;
        const itemName = paths[0]!.split(/[/\\]/u).pop();
        const confirmMessage =
            paths.length === 1
                ? `Are you sure you want to delete "${itemName}"?`
                : `Are you sure you want to delete ${paths.length} items?`;

        const confirmed = await showConfirmModal({
            confirmLabel: "Delete",
            danger: true,
            message: confirmMessage,
            title: "Delete",
        });
        if (!confirmed) return;

        await this.handleApiCall("/api/delete", "POST", { paths }, async (_response) => {
            await this.listFiles(this.currentPath);
            this.clearSelection();
        });
    }

    initializeEventListeners(): void {
        this.elements.fileList!.addEventListener("dblclick", (e) => {
            const row = (e.target as HTMLElement).closest<HTMLElement>("tr");
            if (row && row.dataset.isDir === "true") void this.listFiles(row.dataset.path!);
        });

        const handleButtonClick = async (buttonId: string, action: () => Promise<void> | void) => {
            const button = this.buttons[buttonId];
            if (button) {
                await button.withLoading(action);
            } else {
                await action();
            }
        };

        byId("refresh")?.addEventListener(
            "click",
            () => void handleButtonClick("refresh", () => this.listFiles(this.currentPath)),
        );

        byId("downloadFile")?.addEventListener("click", () =>
            handleButtonClick("downloadFile", () => {
                this.handleDownload(this.getSelectedItems());
            }),
        );

        byId("fileUpload")?.addEventListener("change", async (e) => {
            const { files } = e.target as HTMLInputElement;
            if (!files || files.length === 0) return;
            await this.handleFileUpload(files);
        });

        byId("cancelUpload")?.addEventListener("click", () => {
            this.currentUploadXhr?.abort();
        });

        byId("deleteItem")?.addEventListener(
            "click",
            () =>
                void handleButtonClick("deleteItem", async () => {
                    await this.handleDelete(this.getSelectedItems());
                }),
        );

        byId("createFolder")?.addEventListener("click", () => {
            void (async () => {
                const folderName = await showPromptModal({
                    confirmLabel: "Create",
                    label: "Please enter the folder name",
                    sanitize: (value) => value.replaceAll(/[/\\]/gu, ""),
                    title: "Create folder",
                });
                if (!folderName) return;

                await this.handleApiCall(
                    "/api/create_folder",
                    "POST",
                    { folderName, parentPath: this.currentPath },
                    async () => {
                        await this.listFiles(this.currentPath, joinPath(this.currentPath, folderName));
                    },
                );
            })();
        });

        // --- Navigation: Back / Up / Home ---
        byId("navBackBtn")?.addEventListener("click", () => this.goBack());
        byId("navUpBtn")?.addEventListener("click", () => this.goUp());
        byId("homeButton")?.addEventListener("click", () => this.goHome());

        // --- Search mode helpers ---
        const searchToggleBtn = byId("searchToggleBtn");
        searchToggleBtn?.addEventListener("click", () => {
            const searchWrapper = byId("searchWrapper");
            if (searchWrapper?.classList.contains("is-swapped-out")) {
                this.setSearchMode(true);
            } else {
                this.setSearchMode(false, true);
            }
        });

        // Class-based toggles for directory/edit transitions
        const pathContainer = byId("pathContainer");
        const pathInput = byId<HTMLInputElement>("pathInput");

        if (pathContainer && pathInput) {
            pathContainer.addEventListener("click", () => {
                if (pathContainer.classList.contains("editing")) return;
                pathContainer.classList.add("editing");
                pathInput.value = this.currentPath;
                pathInput.focus();
                pathInput.select();
            });

            pathInput.addEventListener("blur", () => {
                pathContainer.classList.remove("editing");
            });

            pathInput.addEventListener("keydown", (e) => {
                if (e.key === "Enter") {
                    const newPath = pathInput.value.trim();
                    pathInput.blur();
                    if (newPath !== this.currentPath) {
                        void this.listFiles(newPath);
                    }
                } else if (e.key === "Escape") {
                    pathInput.blur();
                }
            });
        }

        const searchInput = byId<HTMLInputElement>("searchInput");
        if (searchInput) {
            bindDebouncedInput(searchInput, () => {
                this.applySortAndFilter(true);
            });
            searchInput.addEventListener("click", (e) => {
                e.stopPropagation();
            });
            searchInput.addEventListener("keydown", (e) => {
                if (e.key === "Escape") this.setSearchMode(false, true);
            });
        }

        registerShortcuts("fileSection", {
            delete: () => byId("deleteItem")?.click(),
            f2: () => {
                this.renameSelectedItem();
            },
        });
    }

    setSearchMode(active: boolean, refilter = false): void {
        byId("pathContainer")?.classList.toggle("is-swapped-out", active);
        byId("searchWrapper")?.classList.toggle("is-swapped-out", !active);
        byId("searchIcon")?.classList.toggle("hidden", active);
        byId("searchCloseIcon")?.classList.toggle("hidden", !active);

        if (active) {
            this.elements.searchInput?.focus();
        } else {
            if (this.elements.searchInput) this.elements.searchInput.value = "";
            if (refilter) this.applySortAndFilter(true);
        }
    }

    renameSelectedItem(): void {
        const selected = this.getSelectedItems();
        if (selected.length === 1) void this.openRenameModal(selected[0]!);
    }

    async openRenameModal(oldPath: string): Promise<void> {
        const fileItem = this.currentFileList.find((f) => f.path === oldPath);
        const currentName = fileItem ? fileItem.name : oldPath.split(/[/\\]/u).pop();

        const newName = await showPromptModal({
            confirmLabel: "Rename",
            initialValue: currentName,
            label: "Please enter the new name",
            sanitize: (value) => value.replaceAll(/[/\\]/gu, ""),
            title: `Rename "${currentName}"`,
        });
        if (!newName || newName === currentName) return;

        await this.handleApiCall("/api/rename", "POST", { newName, oldPath }, async () => {
            await this.listFiles(this.currentPath, joinPath(this.currentPath, newName));
        });
    }

    initializeSortListeners(): void {
        document.querySelectorAll<HTMLElement>("#fileTable th[data-sort]").forEach((th) => {
            th.classList.add("whitespace-nowrap");
            th.addEventListener("mousedown", (e) => {
                e.stopPropagation();
            });

            th.addEventListener("click", () => {
                const sortField = th.dataset.sort as SortColumn;
                if (this.sortColumn === sortField) {
                    this.sortDirection = this.sortDirection === "asc" ? "desc" : "asc";
                } else {
                    this.sortColumn = sortField;
                    this.sortDirection = "asc";
                }
                this.updateSortIndicators();
                this.applySortAndFilter(true);
            });
        });
        this.updateSortIndicators();
    }

    updateSortIndicators(): void {
        renderSortIndicators("#fileTable th[data-sort]", this.sortColumn, this.sortDirection === "asc");
    }

    override initialize(): void {
        this.initializeElements();
        this.initializeButtons();
        this.dropZone = new DropZone("dropZone", (files, isDrop) => void this.handleFileUpload(files, isDrop));
        this.initializeEventListeners();
        this.initializeSortListeners();
        super.initialize();

        if (this.selectionManager) {
            this.selectionManager.config.getAllIds = () => this.filteredList.map((i) => i.path);
        }

        void this.listFiles(this.currentPath);
    }
}

export function initializeFileManagement(): void {
    const fileManager = new FileManager();
    fileManager.initialize();
}
