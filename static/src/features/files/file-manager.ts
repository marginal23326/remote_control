import { apiCall } from "@/shared/api";
import { CLASSES, type ContextMenuContext, ListManager } from "@/shared/list-manager";
import type { ContextMenuItem } from "@/shared/context-menu";
import { formatDate, formatFileSize } from "@/shared/format";
import {
    bindDebouncedInput,
    bindSortableHeaders,
    byId,
    escapeHtml,
    onAsync,
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
import { renderEmptyRow, renderFileRow } from "./file-list-renderer";
import { VirtualList } from "./virtual-list";
import type { ApiMessageResponse, FileListItem, RenderableFileItem } from "@/shared/types";

type SortColumn = "name" | "size" | "modified";
type SortDirection = "asc" | "desc";

interface FileManagerElements {
    fileList: HTMLElement | null;
    currentPath: HTMLElement | null;
    searchInput: HTMLInputElement | null;
    scrollContainer: HTMLElement | null;
}

async function handleApiCall(
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

function handleDownload(paths: string[]): void {
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

let currentPath = "";
let navigationHistory: string[] = [];
let currentFileList: RenderableFileItem[] = [];
let filteredList: RenderableFileItem[] = [];
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const sortState: { column: SortColumn; direction: SortDirection } = { column: "name", direction: "asc" };
let dropZone: DropZone | null = null;
let isLoading = false;
let pendingScrollPath: string | null = null;
let currentUploadXhr: XMLHttpRequest | null = null;
let navToken = 0;
let hasError = false;

const listManager = new ListManager({
    containerSelector: "#fileList",
    getContextMenuItems: (context?: ContextMenuContext) => {
        const selectedItems = context?.selectedItems ?? listManager.getSelectedItems();
        if (selectedItems.length === 0) return [];

        const items: ContextMenuItem[] = [
            {
                label: "Download",
                action: () => {
                    handleDownload(selectedItems);
                },
            },
        ];

        if (selectedItems.length === 1) {
            items.push({
                label: "Rename (F2)",
                action: () => {
                    renameSelectedItem();
                },
            });
        }

        items.push({ label: "Delete (Del)", action: () => void handleDelete(selectedItems) });
        return items;
    },
    getItemId: (element) => element.dataset.path,
    itemDataAttribute: "path",
    onSelectionChange: () => {
        updateFileOperationsUI();
    },
});

const accessChecker = new AccessChecker({
    checkAccess: (batch) => apiCall<string[]>(`/api/files/check-access`, "POST", batch),
    getVisiblePaths: () => {
        const { start, end } = virtualList?.visibleRange ?? { end: -1, start: -1 };
        return new Set(
            filteredList
                .slice(Math.max(0, start), end)
                .filter((i) => i.is_dir)
                .map((i) => i.path),
        );
    },
    onResolved: (path, accessible) => {
        if (!accessible) {
            const row = elements.fileList!.querySelector(`tr[data-path=${CSS.escape(path)}]`);
            if (row) row.classList.add(CLASSES.noAccess);
        }
    },
});

const elements: FileManagerElements = {
    currentPath: byId("currentPath"),
    fileList: byId("fileList"),
    scrollContainer: null,
    searchInput: byId<HTMLInputElement>("searchInput"),
};
elements.scrollContainer = elements.fileList!.closest<HTMLElement>(".overflow-auto");

let virtualList: VirtualList<RenderableFileItem> | null = null;
if (elements.scrollContainer) {
    virtualList = new VirtualList<RenderableFileItem>({
        container: elements.scrollContainer,
        getItems: () => filteredList,
        isPaused: () => isLoading,
        list: elements.fileList!,
        renderEmpty: renderEmptyRow,
        renderRow: (item) => {
            const cachedAccess = accessChecker.get(item.path);
            const accessCls = item.is_dir && cachedAccess === false ? CLASSES.noAccess : "";

            if (item.is_dir && cachedAccess === undefined) {
                accessChecker.queuePath(item.path);
            }

            const selectedCls = listManager.selectionManager
                ? listManager.selectionManager.getItemClasses(item.path)
                : CLASSES.defaultHover;

            return renderFileRow(item, { accessCls, rowHeight: virtualList!.rowHeight, selectedCls });
        },
    });
    virtualList.attach();
}

const buttonConfigs: Record<string, string> = {
    deleteItem: "Deleting...",
    downloadFile: "Downloading...",
    refresh: "",
};

const buttons: Record<string, LoadingButton> = Object.fromEntries(
    Object.entries(buttonConfigs)
        .map(([id, loadingText]): [string, LoadingButton] | null => {
            const button = byId<HTMLButtonElement>(id);
            if (button) {
                button.classList.add("inline-flex", "items-center", "justify-center", "gap-1.5", "whitespace-nowrap");
                return [id, new LoadingButton(button, loadingText)];
            }
            return null;
        })
        .filter((entry): entry is [string, LoadingButton] => entry !== null),
);

async function handleFileUpload(files: FileList, isDropZone = false): Promise<void> {
    if (files.length === 0) return;

    if (!currentPath) {
        showNotification("Please navigate to a directory before uploading files.", "error");
        return;
    }

    if (isDropZone) dropZone!.setLoading();

    const uploadLabel = document.querySelector('label[for="fileUpload"] span');
    const cancelBtn = byId("cancelUpload");
    if (uploadLabel) uploadLabel.textContent = "Uploading... 0%";
    if (cancelBtn) cancelBtn.classList.remove("hidden");

    try {
        const { promise, xhr } = uploadFiles(currentPath, files, {
            onProgress: (pct) => {
                if (uploadLabel) uploadLabel.textContent = `Uploading... ${pct}%`;
            },
        });
        currentUploadXhr = xhr;
        const response = await promise;

        if (response.message) showNotification(response.message, "info");

        if (response.count !== files.length) {
            showNotification(`Only ${response.count} of ${files.length} files were uploaded successfully.`, "warning");
        }

        const lastFile = files[files.length - 1]!.name;
        const scrollToPath = joinPath(currentPath, lastFile);
        await listFiles(currentPath, scrollToPath);
    } catch (error) {
        if ((error as Error).name === "AbortError") {
            showNotification("Upload cancelled", "info");
            await listFiles(currentPath);
        } else {
            console.error(`Error in upload:`, error);
            showNotification(`Error: ${(error as Error).message}`, "error");
        }
    } finally {
        currentUploadXhr = null;
        if (isDropZone) dropZone!.reset();
        if (uploadLabel) uploadLabel.textContent = "Upload";
        if (cancelBtn) cancelBtn.classList.add("hidden");

        const fileInput = byId<HTMLInputElement>("fileUpload");
        if (fileInput) fileInput.value = "";
    }
}

function updateFileOperationsUI(): void {
    const selectedCount = listManager.selectionManager?.selectedIds?.size ?? 0;
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

function updateBreadcrumbs(): void {
    renderBreadcrumbs(elements.currentPath, currentPath, (path) => void listFiles(path));
}

function updateFileList(items: FileListItem[], scrollToPath: string | null = null): void {
    currentFileList = items.map((item) => ({
        ...item,
        _formattedDate: item.last_modified ? formatDate(item.last_modified) : "-",
        _formattedSize: item.is_dir ? "-" : formatFileSize(item.size ?? 0),
        _nameLower: item.name.toLowerCase(),
        _safeName: escapeHtml(item.name),
        _safePath: escapeHtml(item.path),
    }));

    pendingScrollPath = scrollToPath;
    applySortAndFilter();
}

function selectPath(path: string): void {
    if (!listManager.selectionManager) return;
    listManager.selectionManager.clearSelection(false);
    listManager.selectionManager.selectedIds.add(path);
    listManager.selectionManager.lastSelectedId = path;
    listManager.selectionManager.selectionAnchorId = path;
    listManager.selectionManager.config.onSelectionChange(listManager.selectionManager.getSelectedItems());
}

function applySortAndFilter(resetScroll = false): void {
    const term = (elements.searchInput?.value ?? "").toLowerCase();
    const list = currentFileList.filter((item) => !term || item._nameLower.includes(term));

    const dirMul = sortState.direction === "asc" ? 1 : -1;
    list.sort((a, b) => {
        if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;

        if (sortState.column === "name") {
            return dirMul * collator.compare(a.name, b.name);
        }

        const key: "size" | "last_modified" = sortState.column === "modified" ? "last_modified" : "size";
        return dirMul * ((a[key] ?? 0) - (b[key] ?? 0));
    });

    filteredList = list;

    virtualList?.render(true);

    if (elements.scrollContainer) {
        const rowHeight = virtualList!.rowHeight;
        if (pendingScrollPath && rowHeight > 0) {
            const index = filteredList.findIndex((i) => i.path === pendingScrollPath);
            if (index !== -1) {
                const targetScroll = index * rowHeight;
                const containerHeight = elements.scrollContainer.clientHeight;
                const currentScroll = elements.scrollContainer.scrollTop;

                if (targetScroll < currentScroll || targetScroll > currentScroll + containerHeight - rowHeight) {
                    elements.scrollContainer.scrollTop = Math.max(0, targetScroll - containerHeight / 2);
                }
            }
            pendingScrollPath = null;
        } else if (resetScroll) {
            elements.scrollContainer.scrollTop = 0;
        }
    }
}

async function listFiles(
    path: string,
    scrollToPath: string | null = null,
    { skipHistory = false }: { skipHistory?: boolean } = {},
): Promise<void> {
    hasError = false;
    listManager.clearSelection();
    accessChecker.reset();
    pendingScrollPath = null;
    virtualList?.resetRange();
    updateFileOperationsUI();
    const fileList = byId("fileList")!;

    isLoading = true;
    const token = ++navToken;

    const isSamePath = path === currentPath;
    const previousPath = currentPath;

    if (!isSamePath) {
        currentFileList = [];
        filteredList = [];
        fileList.innerHTML = `<tr><td colspan="3" class="p-4 text-center text-zinc-400">Loading...</td></tr>`;
        setSearchMode(false);
    }

    try {
        const response = await apiCall<FileListItem[]>(`/api/files?path=${encodeURIComponent(path)}`);
        if (token !== navToken) return;
        isLoading = false;

        if (!isSamePath && !skipHistory) {
            navigationHistory.push(previousPath);
        }

        currentPath = path;
        updateBreadcrumbs();
        updateNavButtons();

        if (!isSamePath) {
            const sep = getSeparator(currentPath);
            const parent = path.endsWith(sep) ? path : path + sep;
            if (previousPath.startsWith(parent)) {
                scrollToPath = previousPath;
                selectPath(previousPath);
            }
        }

        updateFileList(response, scrollToPath);
    } catch (error) {
        if (token !== navToken) return;
        isLoading = false;
        hasError = true;
        console.error("Error listing files:", error);
        fileList.innerHTML = `<tr><td colspan="3" class="p-4 text-center text-red-400"></td></tr>`;
        fileList.querySelector("td")!.textContent = (error as Error).message;
    }
}

async function recoverFromError(): Promise<boolean> {
    if (!hasError) return false;
    hasError = false;
    await listFiles(currentPath, null, { skipHistory: true });
    return true;
}

async function goBack(): Promise<void> {
    if (await recoverFromError()) return;
    if (navigationHistory.length === 0) return;
    const previous = navigationHistory.pop()!;
    await listFiles(previous, null, { skipHistory: true });
}

async function goUp(): Promise<void> {
    if (currentPath === "") return;
    if (await recoverFromError()) return;
    await listFiles(getParentPath(currentPath));
}

async function goHome(): Promise<void> {
    try {
        const { path } = await apiCall<{ path: string }>("/api/files/home");
        await listFiles(path);
    } catch (error) {
        showNotification(`Could not open home directory: ${(error as Error).message}`, "error");
    }
}

function updateNavButtons(): void {
    const backBtn = byId<HTMLButtonElement>("navBackBtn");
    const upBtn = byId<HTMLButtonElement>("navUpBtn");
    if (backBtn) backBtn.disabled = navigationHistory.length === 0;
    if (upBtn) upBtn.disabled = currentPath === "";
}

async function handleDelete(paths: string[]): Promise<void> {
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

    await handleApiCall("/api/delete", "POST", { paths }, async (_response) => {
        await listFiles(currentPath);
        listManager.clearSelection();
    });
}

function initializeEventListeners(): void {
    elements.fileList!.addEventListener("dblclick", (e) => {
        const row = (e.target as HTMLElement).closest<HTMLElement>("tr");
        if (row && row.dataset.isDir === "true") void listFiles(row.dataset.path!);
    });

    const handleButtonClick = async (buttonId: string, action: () => Promise<void> | void) => {
        const button = buttons[buttonId];
        if (button) {
            await button.withLoading(action);
        } else {
            await action();
        }
    };

    byId("refresh")?.addEventListener("click", () => void handleButtonClick("refresh", () => listFiles(currentPath)));

    byId("downloadFile")?.addEventListener(
        "click",
        () =>
            void handleButtonClick("downloadFile", () => {
                handleDownload(listManager.getSelectedItems());
            }),
    );

    onAsync(byId("fileUpload"), "change", async (e) => {
        const { files } = e.target as HTMLInputElement;
        if (!files || files.length === 0) return;
        await handleFileUpload(files);
    });

    byId("cancelUpload")?.addEventListener("click", () => {
        currentUploadXhr?.abort();
    });

    byId("deleteItem")?.addEventListener(
        "click",
        () =>
            void handleButtonClick("deleteItem", async () => {
                await handleDelete(listManager.getSelectedItems());
            }),
    );

    onAsync(byId("createFolder"), "click", async () => {
        const folderName = await showPromptModal({
            confirmLabel: "Create",
            label: "Please enter the folder name",
            sanitize: (value) => value.replaceAll(/[/\\]/gu, ""),
            title: "Create folder",
        });
        if (!folderName) return;

        await handleApiCall("/api/create_folder", "POST", { folderName, parentPath: currentPath }, async () => {
            await listFiles(currentPath, joinPath(currentPath, folderName));
        });
    });

    // --- Navigation: Back / Up / Home ---
    onAsync(byId("navBackBtn"), "click", () => goBack());
    onAsync(byId("navUpBtn"), "click", () => goUp());
    onAsync(byId("homeButton"), "click", () => goHome());

    // --- Search mode helpers ---
    const searchToggleBtn = byId("searchToggleBtn");
    searchToggleBtn?.addEventListener("click", () => {
        const searchWrapper = byId("searchWrapper");
        if (searchWrapper?.classList.contains("is-swapped-out")) {
            setSearchMode(true);
        } else {
            setSearchMode(false, true);
        }
    });

    // Class-based toggles for directory/edit transitions
    const pathContainer = byId("pathContainer");
    const pathInput = byId<HTMLInputElement>("pathInput");

    if (pathContainer && pathInput) {
        pathContainer.addEventListener("click", () => {
            if (pathContainer.classList.contains("editing")) return;
            pathContainer.classList.add("editing");
            pathInput.value = currentPath;
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
                if (newPath !== currentPath) {
                    void listFiles(newPath);
                }
            } else if (e.key === "Escape") {
                pathInput.blur();
            }
        });
    }

    const searchInput = byId<HTMLInputElement>("searchInput");
    if (searchInput) {
        bindDebouncedInput(searchInput, () => {
            applySortAndFilter(true);
        });
        searchInput.addEventListener("click", (e) => {
            e.stopPropagation();
        });
        searchInput.addEventListener("keydown", (e) => {
            if (e.key === "Escape") setSearchMode(false, true);
        });
    }

    registerShortcuts("fileSection", {
        delete: () => byId("deleteItem")?.click(),
        f2: () => {
            renameSelectedItem();
        },
    });
}

function setSearchMode(active: boolean, refilter = false): void {
    byId("pathContainer")?.classList.toggle("is-swapped-out", active);
    byId("searchWrapper")?.classList.toggle("is-swapped-out", !active);
    byId("searchIcon")?.classList.toggle("hidden", active);
    byId("searchCloseIcon")?.classList.toggle("hidden", !active);

    if (active) {
        elements.searchInput?.focus();
    } else {
        if (elements.searchInput) elements.searchInput.value = "";
        if (refilter) applySortAndFilter(true);
    }
}

function renameSelectedItem(): void {
    const selected = listManager.getSelectedItems();
    if (selected.length === 1) void openRenameModal(selected[0]!);
}

async function openRenameModal(oldPath: string): Promise<void> {
    const fileItem = currentFileList.find((f) => f.path === oldPath);
    const currentName = fileItem ? fileItem.name : oldPath.split(/[/\\]/u).pop();

    const newName = await showPromptModal({
        confirmLabel: "Rename",
        initialValue: currentName,
        label: "Please enter the new name",
        sanitize: (value) => value.replaceAll(/[/\\]/gu, ""),
        title: `Rename "${currentName}"`,
    });
    if (!newName || newName === currentName) return;

    await handleApiCall("/api/rename", "POST", { newName, oldPath }, async () => {
        await listFiles(currentPath, joinPath(currentPath, newName));
    });
}

function initializeSortListeners(): void {
    document.querySelectorAll<HTMLElement>("#fileTable th[data-sort]").forEach((th) => {
        th.classList.add("whitespace-nowrap");
        th.addEventListener("mousedown", (e) => {
            e.stopPropagation();
        });
    });

    bindSortableHeaders("#fileTable th[data-sort]", sortState, () => {
        updateSortIndicators();
        applySortAndFilter(true);
    });
    updateSortIndicators();
}

function updateSortIndicators(): void {
    renderSortIndicators("#fileTable th[data-sort]", sortState.column, sortState.direction === "asc");
}

export function initializeFileManagement(): void {
    dropZone = new DropZone("dropZone", (files, isDrop) => void handleFileUpload(files, isDrop));
    initializeEventListeners();
    initializeSortListeners();
    listManager.initialize();

    if (listManager.selectionManager) {
        listManager.selectionManager.config.getAllIds = () => filteredList.map((i) => i.path);
    }

    void listFiles(currentPath);
}
