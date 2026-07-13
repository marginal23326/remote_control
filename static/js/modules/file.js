// static/js/modules/file.js
import {
    apiCall,
    SVG_TEMPLATES,
    CLASSES,
    formatFileSize,
    formatDate,
    UIManager,
    escapeHtml,
    showPromptModal,
    showConfirmModal,
} from "./utils.js";
import { LoadingButton, showNotification } from "./dom.js";

class FileManager extends UIManager {
    constructor() {
        super({
            containerSelector: "#fileList",
            itemDataAttribute: "path",
            getItemId: (element) => element.dataset.path,
            getContextMenuItems: (context) => {
                const selectedItems = context?.selectedItems || this.getSelectedItems();
                if (!selectedItems.length) return [];

                const items = [{ label: "Download", action: () => this.handleDownload(selectedItems) }];

                if (selectedItems.length === 1) {
                    items.push({ label: "Rename", action: () => this.openRenameModal(selectedItems[0]) });
                }

                items.push({ label: "Delete", action: () => this.handleDelete(selectedItems) });
                return items;
            },
            onSelectionChange: () => this.updateFileOperationsUI(),
        });

        this.currentPath = "";
        this.navigationHistory = [];
        this.currentFileList = [];
        this.filteredList = [];
        this.collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
        this.sortColumn = "name";
        this.sortDirection = "asc";
        this.buttons = {};
        this.dropZone = null;
        this.elements = {
            fileList: null,
            currentPath: null,
            searchInput: null,
            scrollContainer: null,
        };
        this.rowHeight = 21;
        this.rowHeightNeedsUpdate = true;
        this.buffer = 15;
        this.accessCache = new Map();
        this.accessQueue = new Set();
        this.accessCheckTimer = null;
        this.resizeObserver = null;
        this.lastRenderedRange = { start: -1, end: -1 };
        this.ticking = false;
        this.isLoading = false;
        this._navToken = 0;
        this.scrollToPath = null;
        this.currentUploadXhr = null;
    }

    initializeElements() {
        this.elements.fileList = document.getElementById("fileList");
        this.elements.currentPath = document.getElementById("currentPath");
        this.elements.searchInput = document.getElementById("searchInput");
        this.elements.scrollContainer = this.elements.fileList.closest(".overflow-auto");

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
                    const newHeight = this.elements.scrollContainer.clientHeight || 0;
                    if (newHeight !== this.lastContainerHeight) {
                        this.lastContainerHeight = newHeight;
                        this.rowHeightNeedsUpdate = true;
                        window.requestAnimationFrame(() => this.renderViewport(true));
                    }
                }
            });
            this.resizeObserver.observe(this.elements.scrollContainer);
        }
    }

    initializeButtons() {
        const buttonConfigs = {
            downloadFile: "Downloading...",
            deleteItem: "Deleting...",
            refresh: "",
        };

        this.buttons = Object.fromEntries(
            Object.entries(buttonConfigs)
                .map(([id, loadingText]) => {
                    const button = document.getElementById(id);
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
                .filter(Boolean),
        );
    }

    async handleFileUpload(files, isDropZone = false) {
        if (!files.length) return;

        if (!this.currentPath) {
            showNotification("Please navigate to a directory before uploading files.", "error");
            return;
        }

        const formData = new FormData();
        Array.from(files).forEach((file) => formData.append("files", file));

        if (isDropZone) this.dropZone.setLoading();

        const uploadLabel = document.querySelector('label[for="fileUpload"] span');
        const cancelBtn = document.getElementById("cancelUpload");
        if (uploadLabel) uploadLabel.textContent = "Uploading... 0%";
        if (cancelBtn) cancelBtn.classList.remove("hidden");

        try {
            const encodedPath = encodeURIComponent(this.currentPath);

            const response = await new Promise((resolve, reject) => {
                const xhr = new XMLHttpRequest();
                this.currentUploadXhr = xhr;
                xhr.open("POST", `/api/upload?path=${encodedPath}`, true);

                xhr.upload.onprogress = (e) => {
                    if (e.lengthComputable) {
                        const pct = Math.round((e.loaded / e.total) * 100);
                        if (uploadLabel) uploadLabel.textContent = `Uploading... ${pct}%`;
                    }
                };

                xhr.onload = () => {
                    if (xhr.status === 401) {
                        window.location.href = "/login";
                        return reject(new Error("Unauthorized"));
                    }
                    try {
                        const data = JSON.parse(xhr.responseText);
                        if (xhr.status >= 200 && xhr.status < 300) {
                            resolve(data);
                        } else {
                            reject(new Error(data.message || `Upload failed: ${xhr.status}`));
                        }
                    } catch {
                        reject(new Error(`HTTP error! status: ${xhr.status}`));
                    }
                };

                xhr.onerror = () => reject(new Error("Network Error"));
                xhr.onabort = () => reject(new DOMException("Upload cancelled", "AbortError"));
                xhr.send(formData);
            });

            if (response.message) showNotification(response.message, "info");

            if (response.count !== files.length) {
                showNotification(
                    `Only ${response.count} of ${files.length} files were uploaded successfully.`,
                    "warning",
                );
            }

            const lastFile = files[files.length - 1].name;
            const scrollToPath = this.joinPath(this.currentPath, lastFile);
            await this.listFiles(this.currentPath, scrollToPath);
        } catch (error) {
            if (error.name === "AbortError") {
                showNotification("Upload cancelled", "info");
                await this.listFiles(this.currentPath);
            } else {
                console.error(`Error in upload:`, error);
                showNotification(`Error: ${error.message}`, "error");
            }
        } finally {
            this.currentUploadXhr = null;
            if (isDropZone) this.dropZone.reset();
            if (uploadLabel) uploadLabel.textContent = "Upload";
            if (cancelBtn) cancelBtn.classList.add("hidden");

            const fileInput = document.getElementById("fileUpload");
            if (fileInput) fileInput.value = "";
        }
    }

    async handleApiCall(apiEndpoint, method, data, successCallback) {
        try {
            const response = await apiCall(apiEndpoint, method, data);
            if (response.message) showNotification(response.message, "info");
            successCallback?.(response);
        } catch (error) {
            console.error(`Error in ${apiEndpoint}:`, error);
            showNotification(`Error: ${error.message}`, "error");
        }
    }

    updateFileOperationsUI() {
        const selectedCount = this.selectionManager?.selectedIds?.size || 0;
        const hasSelection = selectedCount > 0;
        const downloadBtn = document.getElementById("downloadFile");
        const deleteBtn = document.getElementById("deleteItem");
        if (downloadBtn) downloadBtn.style.display = hasSelection ? "" : "none";
        if (deleteBtn) deleteBtn.style.display = hasSelection ? "" : "none";

        const countEl = document.getElementById("fileSelectionCount");
        if (countEl) {
            countEl.classList.toggle("hidden", !hasSelection);
            countEl.textContent = `${selectedCount} selected`;
        }
    }

    updateBreadcrumbs() {
        const container = this.elements.currentPath;
        if (!container) return;
        container.innerHTML = "";

        const path = this.currentPath;
        const isWindows = path.includes("\\") || /^[A-Z]:/i.test(path);
        const separator = isWindows ? "\\" : "/";

        const createPartBtn = (text, targetPath, isActive) => {
            const btn = document.createElement("button");
            btn.className = `truncate flex-shrink-0 rounded px-1.5 py-0.5 text-sm transition-colors ${
                isActive
                    ? "text-zinc-100 font-medium max-w-[200px]"
                    : "text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 max-w-[150px] cursor-pointer"
            }`;
            btn.textContent = text;
            btn.title = text;
            if (!isActive) {
                btn.addEventListener("click", (e) => {
                    e.stopPropagation();
                    this.listFiles(targetPath);
                });
            }
            return btn;
        };

        const chevron = `<svg class="w-3.5 h-3.5 text-zinc-600 shrink-0 mx-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>`;

        if (!path || path === "/" || path === "") {
            container.appendChild(createPartBtn(path === "" ? "This PC" : "/", path === "" ? "" : "/", true));
            return;
        }

        const parts = path.split(separator).filter(Boolean);
        container.appendChild(createPartBtn(isWindows ? "This PC" : "root", isWindows ? "" : "/", false));

        let accumulated = "";
        parts.forEach((part, index) => {
            container.insertAdjacentHTML("beforeend", chevron);
            if (isWindows) {
                accumulated = accumulated ? `${accumulated.replace(/\\$/, "")}\\${part}` : part;
                if (index === 0 && part.endsWith(":")) accumulated += "\\";
            } else {
                accumulated += "/" + part;
            }
            container.appendChild(createPartBtn(part, accumulated, index === parts.length - 1));
        });

        requestAnimationFrame(() => (container.scrollLeft = container.scrollWidth));
    }

    async updateFileList(items, scrollToPath = null) {
        this.currentFileList = items.map((item) => ({
            ...item,
            _safePath: escapeHtml(item.path),
            _safeName: escapeHtml(item.name),
            _nameLower: item.name.toLowerCase(),
            _formattedSize: item.is_dir ? "-" : formatFileSize(item.size),
            _formattedDate: item.last_modified ? formatDate(item.last_modified) : "-",
        }));

        this.scrollToPath = scrollToPath;
        this.applySortAndFilter();
    }

    selectPath(path) {
        if (!this.selectionManager) return;
        this.selectionManager.clearSelection(false);
        this.selectionManager.selectedIds.add(path);
        this.selectionManager.lastSelectedId = path;
        this.selectionManager.selectionAnchorId = path;
        this.selectionManager.config.onSelectionChange(this.selectionManager.getSelectedItems());
    }

    applySortAndFilter(resetScroll = false) {
        const term = (this.elements.searchInput?.value || "").toLowerCase();
        let list = this.currentFileList.filter((item) => !term || item._nameLower.includes(term));

        const dirMul = this.sortDirection === "asc" ? 1 : -1;
        list.sort((a, b) => {
            if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;

            if (this.sortColumn === "name") {
                return dirMul * this.collator.compare(a.name, b.name);
            }

            const key = this.sortColumn === "modified" ? "last_modified" : this.sortColumn;
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

    renderViewport(force = false) {
        if (!this.elements.scrollContainer || this.isLoading) return;

        if (this.rowHeightNeedsUpdate) {
            const firstRealRow = this.elements.fileList.querySelector(`tr[data-path]`);
            if (firstRealRow) {
                const measured = firstRealRow.getBoundingClientRect().height;
                if (measured > 0) {
                    this.rowHeight = measured;
                    this.rowHeightNeedsUpdate = false;
                }
            }
        }

        const containerHeight = this.elements.scrollContainer.clientHeight || 500;
        const scrollTop = this.elements.scrollContainer.scrollTop;

        const totalItems = this.filteredList.length;
        const totalHeight = totalItems * this.rowHeight;

        let startIndex = Math.floor(scrollTop / this.rowHeight) - this.buffer;
        let endIndex = Math.floor((scrollTop + containerHeight) / this.rowHeight) + this.buffer;

        startIndex = Math.max(0, startIndex);
        endIndex = Math.min(totalItems, endIndex);

        if (!force && startIndex === this.lastRenderedRange.start && endIndex === this.lastRenderedRange.end) {
            return;
        }
        this.lastRenderedRange = { start: startIndex, end: endIndex };

        const paddingTop = startIndex * this.rowHeight;
        const paddingBottom = Math.max(0, totalHeight - endIndex * this.rowHeight);

        let html = "";
        if (paddingTop > 0) {
            html += `<tr style="height: ${paddingTop}px" class="virtual-spacer"><td colspan="3" style="padding:0; border:0; height: ${paddingTop}px"></td></tr>`;
        }

        for (let i = startIndex; i < endIndex; i++) {
            const item = this.filteredList[i];
            if (!item) continue;

            const cachedAccess = this.accessCache.get(item.path);
            const accessCls = item.is_dir && cachedAccess === false ? CLASSES.noAccess : "";

            if (item.is_dir && cachedAccess === undefined) {
                this.queueAccessCheck(item.path);
            }

            const selectedCls = this.selectionManager
                ? this.selectionManager.getItemClasses(item.path)
                : CLASSES.defaultHover;

            html += `<tr data-path="${item._safePath}" data-is-dir="${item.is_dir}" data-name="${item._safeName}" class="${CLASSES.row} ${selectedCls} ${accessCls}" style="height: ${this.rowHeight}px">
                <td class="px-4 py-1 whitespace-nowrap w-full">${this.createItemNameCell(item)}</td>
                <td class="px-4 py-1 whitespace-nowrap hidden sm:table-cell text-zinc-400">${item._formattedSize}</td>
                <td class="px-4 py-1 whitespace-nowrap hidden md:table-cell text-zinc-400">${item._formattedDate}</td>
            </tr>`;
        }

        if (totalItems === 0) {
            html += `<tr><td colspan="3" class="px-4 py-1 whitespace-nowrap"><div class="text-center text-zinc-500 text-sm py-8 font-mono">Directory is empty</div></td></tr>`;
        }

        if (paddingBottom > 0) {
            html += `<tr style="height: ${paddingBottom}px" class="virtual-spacer"><td colspan="3" style="padding:0; border:0; height: ${paddingBottom}px"></td></tr>`;
        }

        this.elements.fileList.innerHTML = html;
    }

    queueAccessCheck(path) {
        this.accessQueue.add(path);
        if (this.accessCheckTimer) clearTimeout(this.accessCheckTimer);
        this.accessCheckTimer = setTimeout(() => this.processAccessQueue(), 100);
    }

    async processAccessQueue() {
        if (this.accessQueue.size === 0) return;

        const { start, end } = this.lastRenderedRange;
        const visiblePaths = new Set(
            this.filteredList
                .slice(Math.max(0, start), end)
                .filter((i) => i.is_dir)
                .map((i) => i.path),
        );

        const batch = Array.from(this.accessQueue).filter((p) => visiblePaths.has(p));
        this.accessQueue.clear();

        if (batch.length === 0) return;

        try {
            const inaccessible = await apiCall(`/api/files/check-access`, "POST", batch);
            const inaccessibleSet = new Set(inaccessible);

            for (const path of batch) {
                const accessible = !inaccessibleSet.has(path);
                this.accessCache.set(path, accessible);

                if (!accessible) {
                    const row = this.elements.fileList.querySelector(`tr[data-path=${CSS.escape(path)}]`);
                    if (row) {
                        row.classList.add(CLASSES.noAccess);
                    }
                }
            }
        } catch (e) {
            console.warn("Failed to check directory access:", e);
        }
    }

    createItemNameCell(item) {
        const iconTemplate = item.is_dir ? SVG_TEMPLATES.folder : SVG_TEMPLATES.file;
        const icon = item.is_dir ? iconTemplate("text-blue-400") : iconTemplate();
        return `<div class="flex items-center gap-2 truncate overflow-hidden">${icon}<span class="truncate block w-full" title="${item._safeName}">${item._safeName}</span></div>`;
    }

    getSeparator() {
        return this.currentPath.includes("\\") ? "\\" : "/";
    }

    joinPath(parent, child) {
        const sep = this.getSeparator();
        return parent.endsWith(sep) ? `${parent}${child}` : `${parent}${sep}${child}`;
    }

    getParentPath() {
        const path = this.currentPath;
        if (/^[A-Z]:\\$/i.test(path) || path === "/") return "";

        const cleaned = path.replace(/[\\/]$/, "");
        const lastSep = Math.max(cleaned.lastIndexOf("/"), cleaned.lastIndexOf("\\"));
        if (lastSep <= 0) return "/";

        const parent = cleaned.substring(0, lastSep);
        return /^[A-Z]:$/i.test(parent) ? parent + "\\" : parent;
    }

    async listFiles(path, scrollToPath = null, { skipHistory = false } = {}) {
        this.clearSelection();
        this.accessCache.clear();
        this.accessQueue.clear();
        if (this.accessCheckTimer) {
            clearTimeout(this.accessCheckTimer);
            this.accessCheckTimer = null;
        }
        this.scrollToPath = null;
        this.lastRenderedRange = { start: -1, end: -1 };
        this.updateFileOperationsUI();
        const fileList = document.getElementById("fileList");

        this.isLoading = true;
        const token = ++this._navToken;

        const isSamePath = path === this.currentPath;
        const previousPath = this.currentPath;

        if (!isSamePath) {
            this.currentFileList = [];
            this.filteredList = [];
            fileList.innerHTML = `<tr><td colspan="3" class="p-4 text-center text-zinc-400">Loading...</td></tr>`;
            this.setSearchMode(false);
        }

        try {
            const response = await apiCall(`/api/files?path=${encodeURIComponent(path)}`);
            if (token !== this._navToken) return;
            this.isLoading = false;

            if (response.status === "error") {
                const errorMsg = response.no_access
                    ? `Access Denied: You do not have permission to view ${path}`
                    : response.message;

                fileList.innerHTML = `<tr><td colspan="3" class="p-4 text-center text-red-400"></td></tr>`;
                fileList.querySelector("td").textContent = errorMsg;
                return;
            }

            if (!isSamePath && !skipHistory) {
                this.navigationHistory.push(previousPath);
            }

            this.currentPath = path;
            this.updateBreadcrumbs();
            this.updateNavButtons();

            if (!isSamePath) {
                const sep = this.getSeparator();
                const parent = path.endsWith(sep) ? path : path + sep;
                if (previousPath.startsWith(parent)) {
                    scrollToPath = previousPath;
                    this.selectPath(previousPath);
                }
            }

            await this.updateFileList(response, scrollToPath);
        } catch (error) {
            if (token !== this._navToken) return;
            this.isLoading = false;
            console.error("Error listing files:", error);
            fileList.innerHTML = `<tr><td colspan="3" class="p-4 text-center text-red-400"></td></tr>`;
            fileList.querySelector("td").textContent = `Error: ${error.message}`;
        }
    }

    async goBack() {
        if (!this.navigationHistory.length) return;
        const previous = this.navigationHistory.pop();
        await this.listFiles(previous, null, { skipHistory: true });
    }

    async goUp() {
        if (this.currentPath === "") return;
        await this.listFiles(this.getParentPath());
    }

    async goHome() {
        try {
            const { path } = await apiCall("/api/files/home");
            await this.listFiles(path);
        } catch (error) {
            showNotification("Could not open home directory: " + error.message, "error");
        }
    }

    updateNavButtons() {
        const backBtn = document.getElementById("navBackBtn");
        const upBtn = document.getElementById("navUpBtn");
        if (backBtn) backBtn.disabled = this.navigationHistory.length === 0;
        if (upBtn) upBtn.disabled = this.currentPath === "";
    }

    async handleDownload(paths) {
        if (!paths || paths.length === 0) {
            showNotification("No files selected for download.", "warning");
            return;
        }

        let iframe = document.getElementById("global-download-iframe");
        if (!iframe) {
            iframe = document.createElement("iframe");
            iframe.id = "global-download-iframe";
            iframe.name = "global-download-iframe";
            iframe.style.display = "none";
            document.body.appendChild(iframe);
        }

        iframe.onload = () => {
            try {
                const text = iframe.contentDocument?.body?.textContent;
                if (text) {
                    const data = JSON.parse(text);
                    if (data.status === "error") {
                        showNotification(data.message || "Download failed.", "error");
                    }
                }
            } catch {}
        };

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
            form.appendChild(input);
        });

        document.body.appendChild(form);
        form.submit();
        document.body.removeChild(form);
    }

    async handleDelete(paths) {
        if (!paths || paths.length === 0) return;
        const itemName = paths[0].split(/[/\\]/).pop();
        const confirmMessage =
            paths.length === 1
                ? `Are you sure you want to delete "${itemName}"?`
                : `Are you sure you want to delete ${paths.length} items?`;

        const confirmed = await showConfirmModal({
            title: "Delete",
            message: confirmMessage,
            confirmLabel: "Delete",
            danger: true,
        });
        if (!confirmed) return;

        await this.handleApiCall("/api/delete", "POST", { paths }, async (_response) => {
            await this.listFiles(this.currentPath);
            this.clearSelection();
        });
    }

    initializeEventListeners() {
        this.elements.fileList.addEventListener("dblclick", (e) => {
            const row = e.target.closest("tr");
            if (row && row.dataset.isDir === "true") this.listFiles(row.dataset.path);
        });

        const handleButtonClick = async (buttonId, action) => {
            const button = this.buttons[buttonId];
            if (button) {
                await button.withLoading(action);
            } else {
                await action();
            }
        };

        document
            .getElementById("refresh")
            ?.addEventListener("click", () => handleButtonClick("refresh", () => this.listFiles(this.currentPath)));

        document.getElementById("downloadFile")?.addEventListener("click", () =>
            handleButtonClick("downloadFile", async () => {
                await this.handleDownload(this.getSelectedItems());
            }),
        );

        document.getElementById("fileUpload")?.addEventListener("change", async (e) => {
            if (!e.target.files.length) return;
            await this.handleFileUpload(e.target.files);
        });

        document.getElementById("cancelUpload")?.addEventListener("click", () => {
            this.currentUploadXhr?.abort();
        });

        document.getElementById("deleteItem")?.addEventListener("click", () =>
            handleButtonClick("deleteItem", async () => {
                await this.handleDelete(this.getSelectedItems());
            }),
        );

        document.getElementById("createFolder")?.addEventListener("click", async () => {
            const folderName = await showPromptModal({
                title: "Create folder",
                label: "Please enter the folder name",
                confirmLabel: "Create",
                sanitize: (value) => value.replace(/[/\\]/g, ""),
            });
            if (!folderName) return;

            await this.handleApiCall(
                "/api/create_folder",
                "POST",
                { parentPath: this.currentPath, folderName },
                async () => {
                    await this.listFiles(this.currentPath, this.joinPath(this.currentPath, folderName));
                },
            );
        });

        // --- Navigation: Back / Up / Home ---
        document.getElementById("navBackBtn")?.addEventListener("click", () => this.goBack());
        document.getElementById("navUpBtn")?.addEventListener("click", () => this.goUp());
        document.getElementById("homeButton")?.addEventListener("click", () => this.goHome());

        // --- Search mode helpers ---
        const searchToggleBtn = document.getElementById("searchToggleBtn");
        searchToggleBtn?.addEventListener("click", () => {
            const searchWrapper = document.getElementById("searchWrapper");
            if (searchWrapper?.classList.contains("hidden")) {
                this.setSearchMode(true);
            } else {
                this.setSearchMode(false, true);
            }
        });

        // Class-based toggles for directory/edit transitions
        const pathContainer = document.getElementById("pathContainer");
        const pathInput = document.getElementById("pathInput");

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
                        this.listFiles(newPath);
                    }
                } else if (e.key === "Escape") {
                    pathInput.blur();
                }
            });
        }

        const searchInput = document.getElementById("searchInput");
        if (searchInput) {
            let searchTimeout;
            searchInput.addEventListener("input", () => {
                clearTimeout(searchTimeout);
                searchTimeout = setTimeout(() => {
                    this.applySortAndFilter(true);
                }, 50);
            });
            searchInput.addEventListener("click", (e) => {
                e.stopPropagation();
            });
            searchInput.addEventListener("keydown", (e) => {
                if (e.key === "Escape") this.setSearchMode(false, true);
            });
        }
    }

    setSearchMode(active, refilter = false) {
        document.getElementById("pathContainer")?.classList.toggle("hidden", active);
        document.getElementById("searchWrapper")?.classList.toggle("hidden", !active);
        document.getElementById("searchIcon")?.classList.toggle("hidden", active);
        document.getElementById("searchCloseIcon")?.classList.toggle("hidden", !active);

        if (active) {
            this.elements.searchInput?.focus();
        } else {
            if (this.elements.searchInput) this.elements.searchInput.value = "";
            if (refilter) this.applySortAndFilter(true);
        }
    }

    async openRenameModal(oldPath) {
        const fileItem = this.currentFileList.find((f) => f.path === oldPath);
        const currentName = fileItem ? fileItem.name : oldPath.split(/[/\\]/).pop();

        const newName = await showPromptModal({
            title: `Rename "${currentName}"`,
            label: "Please enter the new name",
            initialValue: currentName,
            confirmLabel: "Rename",
            sanitize: (value) => value.replace(/[/\\]/g, ""),
        });
        if (!newName || newName === currentName) return;

        await this.handleApiCall("/api/rename", "POST", { oldPath, newName }, async () => {
            await this.listFiles(this.currentPath, this.joinPath(this.currentPath, newName));
        });
    }

    initializeSortListeners() {
        document.querySelectorAll("#fileTable th[data-sort]").forEach((th) => {
            th.classList.add("whitespace-nowrap");
            th.addEventListener("mousedown", (e) => e.stopPropagation());

            th.addEventListener("click", () => {
                const sortField = th.dataset.sort;
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

    updateSortIndicators() {
        document.querySelectorAll("#fileTable th[data-sort]").forEach((th) => {
            const indicator = th.querySelector(".sort-indicator");
            if (!indicator) return;
            if (th.dataset.sort === this.sortColumn) {
                indicator.textContent = this.sortDirection === "asc" ? " ▲" : " ▼";
            } else {
                indicator.textContent = "";
            }
        });
    }

    initialize() {
        this.initializeElements();
        this.initializeButtons();
        this.dropZone = new DropZone("dropZone", this.handleFileUpload.bind(this));
        this.initializeEventListeners();
        this.initializeSortListeners();
        super.initialize();

        if (this.selectionManager) {
            this.selectionManager.config.getAllIds = () => this.filteredList.map((i) => i.path);
        }

        this.listFiles(this.currentPath);
    }
}

class DropZone {
    constructor(elementId, onUpload) {
        this.element = document.getElementById(elementId);
        this.overlay = document.getElementById("dropOverlay");
        this.promptEl = document.getElementById("dropPrompt");
        this.spinnerEl = document.getElementById("dropSpinner");
        this.onUpload = onUpload;
        this.dragCounter = 0;
        this.setupEventListeners();
    }

    setupEventListeners() {
        if (!this.element) return;
        const preventDefault = (e) => {
            e.preventDefault();
            e.stopPropagation();
        };

        ["dragenter", "dragover", "dragleave", "drop"].forEach((event) =>
            this.element.addEventListener(event, preventDefault),
        );

        this.element.addEventListener("dragenter", () => {
            this.dragCounter++;
            if (this.dragCounter === 1) this.highlight();
        });

        this.element.addEventListener("dragleave", () => {
            this.dragCounter--;
            if (this.dragCounter === 0) this.unhighlight();
        });

        this.element.addEventListener("drop", (e) => {
            this.dragCounter = 0;
            this.unhighlight();
            this.onUpload(e.dataTransfer.files, true);
        });
    }

    highlight() {
        if (this.overlay) {
            this.overlay.classList.remove("hidden");
            requestAnimationFrame(() => this.overlay.classList.remove("opacity-0"));
        }
        this.element.classList.add("border-zinc-500", "ring-2", "ring-zinc-800/50");
    }

    unhighlight() {
        if (this.overlay) {
            this.overlay.classList.add("opacity-0");
            setTimeout(() => this.overlay.classList.add("hidden"), 200);
        }
        this.element.classList.remove("border-zinc-500", "ring-2", "ring-zinc-800/50");
    }

    setLoading() {
        if (this.promptEl) this.promptEl.classList.add("hidden");
        if (this.spinnerEl) this.spinnerEl.classList.remove("hidden");
        if (this.overlay) this.overlay.classList.remove("hidden", "opacity-0");
    }

    reset() {
        if (this.promptEl) this.promptEl.classList.remove("hidden");
        if (this.spinnerEl) this.spinnerEl.classList.add("hidden");
        this.unhighlight();
    }
}

function initializeFileManagement() {
    const fileManager = new FileManager();
    fileManager.initialize();
}

export { initializeFileManagement };
