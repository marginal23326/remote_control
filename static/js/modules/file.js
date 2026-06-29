// static/js/modules/file.js
import { apiCall, SVG_TEMPLATES, CLASSES, formatFileSize, formatDate, BaseFileManager, escapeHtml } from "./utils.js";
import { LoadingButton, showNotification } from "./dom.js";

class FileManager extends BaseFileManager {
    constructor() {
        super();
        this.currentPath = "";
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
        this.scrollToPath = null;
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

            this.resizeObserver = new ResizeObserver(() => {
                if (this.filteredList.length > 0) {
                    this.rowHeightNeedsUpdate = true;
                    window.requestAnimationFrame(() => this.renderViewport(true));
                }
            });
            this.resizeObserver.observe(this.elements.scrollContainer);
        }
    }

    initializeButtons() {
        const buttonConfigs = {
            downloadFile: "Downloading...",
            deleteItem: "Deleting...",
            renameItem: "Renaming...",
            createFolder: "Creating...",
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
        if (uploadLabel) uploadLabel.textContent = "Uploading...";

        try {
            const encodedPath = encodeURIComponent(this.currentPath);
            await this.handleApiCall(`/api/upload?path=${encodedPath}`, "POST", formData, async (res) => {
                if (res.count !== files.length) {
                    showNotification(
                        `Only ${res.count} of ${files.length} files were uploaded successfully.`,
                        "warning",
                    );
                }
                const lastFile = files[files.length - 1].name;
                const sep = this.getSeparator();
                const scrollToPath = `${this.currentPath}${this.currentPath.endsWith(sep) ? "" : sep}${lastFile}`;
                await this.listFiles(this.currentPath, scrollToPath);
            });
        } finally {
            if (isDropZone) this.dropZone.reset();
            if (uploadLabel) uploadLabel.textContent = "Upload";
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
        const selectionCount = this.selectionManager?.selectedIds?.size || 0;

        const elements = {
            operations: document.getElementById("fileOperations"),
            renameGroup: document.getElementById("renameGroup"),
            download: document.getElementById("downloadFile"),
            delete: document.getElementById("deleteItem"),
            renameInput: document.getElementById("renameInput"),
        };

        if (elements.operations) elements.operations.classList.toggle("hidden", !selectionCount);
        if (elements.renameGroup) elements.renameGroup.classList.toggle("hidden", selectionCount !== 1);

        if (elements.download) elements.download.disabled = !selectionCount;
        if (elements.delete) elements.delete.disabled = !selectionCount;

        if (selectionCount === 1 && elements.renameInput) {
            const selectedId = Array.from(this.selectionManager.selectedIds)[0];
            const fileItem = this.currentFileList.find((f) => f.path === selectedId);
            if (fileItem) elements.renameInput.value = fileItem.name;
        } else if (elements.renameInput) {
            elements.renameInput.value = "";
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
                    ? "text-gray-100 font-semibold max-w-[200px]"
                    : "text-gray-300 hover:text-white hover:bg-white/10 max-w-[150px] cursor-pointer"
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

        const chevron = `<svg class="w-3.5 h-3.5 text-gray-500 shrink-0 mx-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>`;

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

        if (this.currentPath !== "") {
            const parent = this.getParentPath();
            list.unshift({
                isUpRow: true,
                path: parent,
                is_dir: true,
                name: "..",
                _safePath: escapeHtml(parent),
                _safeName: "..",
                _formattedSize: "-",
                _formattedDate: "-",
            });
        }

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

            if (item.isUpRow) {
                html += `<tr data-up-row="true" data-is-dir="true" data-path="${item._safePath}" class="${CLASSES.row} ${CLASSES.defaultHover}">
                    <td colspan="3" class="px-2 whitespace-nowrap"><div class="flex items-center gap-2">${SVG_TEMPLATES.upArrow()}..</div></td>
                </tr>`;
                continue;
            }

            const cachedAccess = this.accessCache.get(item.path);
            const accessCls = item.is_dir && cachedAccess === false ? CLASSES.noAccess : "";

            if (item.is_dir && cachedAccess === undefined) {
                this.queueAccessCheck(item.path);
            }

            const selectedCls = this.selectionManager
                ? this.selectionManager.getItemClasses(item.path)
                : CLASSES.defaultHover;

            html += `<tr data-path="${item._safePath}" data-is-dir="${item.is_dir}" data-name="${item._safeName}" class="${CLASSES.row} ${selectedCls} ${accessCls}" style="height: ${this.rowHeight}px">
                <td class="px-2 whitespace-nowrap w-full">${this.createItemNameCell(item)}</td>
                <td class="px-2 whitespace-nowrap hidden sm:table-cell">${item._formattedSize}</td>
                <td class="px-2 whitespace-nowrap hidden md:table-cell">${item._formattedDate}</td>
            </tr>`;
        }

        if (totalItems === 0 || (totalItems === 1 && this.filteredList[0].isUpRow)) {
            html += `<tr><td colspan="3" class="px-2 whitespace-nowrap"><div class="text-center text-gray-500 py-8 font-mono">Directory is empty</div></td></tr>`;
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

    getParentPath() {
        const path = this.currentPath;
        if (/^[A-Z]:\\$/i.test(path) || path === "/") return "";

        const cleaned = path.replace(/[\\/]$/, "");
        const lastSep = Math.max(cleaned.lastIndexOf("/"), cleaned.lastIndexOf("\\"));
        if (lastSep <= 0) return "/";

        const parent = cleaned.substring(0, lastSep);
        return /^[A-Z]:$/i.test(parent) ? parent + "\\" : parent;
    }

    async listFiles(path, scrollToPath = null) {
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

        const isSamePath = path === this.currentPath;

        if (!isSamePath) {
            this.currentFileList = [];
            this.filteredList = [];
            fileList.innerHTML = `<tr><td colspan="3" class="p-4 text-center text-gray-400">Loading...</td></tr>`;
            if (this.elements.searchInput) this.elements.searchInput.value = "";
        }

        try {
            const response = await apiCall(`/api/files?path=${encodeURIComponent(path)}`);
            this.isLoading = false;

            if (response.status === "error") {
                const errorMsg = response.no_access
                    ? `Access Denied: You do not have permission to view ${path}`
                    : response.message;

                fileList.innerHTML = `<tr><td colspan="3" class="p-4 text-center text-red-500"></td></tr>`;
                fileList.querySelector("td").textContent = errorMsg;

                if (path !== "") {
                    const previousPath = this.currentPath;
                    const upHtml = `<tr data-up-row="true" data-path="${escapeHtml(previousPath)}" class="${CLASSES.row} ${CLASSES.defaultHover}"><td colspan="3" class="px-2 whitespace-nowrap"><div class="flex items-center gap-2">${SVG_TEMPLATES.upArrow()}..</div></td></tr>`;
                    fileList.insertAdjacentHTML("afterbegin", upHtml);
                }
                return;
            }

            this.currentPath = path;
            this.updateBreadcrumbs();

            await this.updateFileList(response, scrollToPath);
        } catch (error) {
            this.isLoading = false;
            console.error("Error listing files:", error);
            fileList.innerHTML = `<tr><td colspan="3" class="p-4 text-center text-red-500"></td></tr>`;
            fileList.querySelector("td").textContent = `Error: ${error.message}`;
        }
    }

    async handleDownload(paths) {
        if (!paths || paths.length === 0) return;

        let iframe = document.getElementById("global-download-iframe");
        if (!iframe) {
            iframe = document.createElement("iframe");
            iframe.id = "global-download-iframe";
            iframe.name = "global-download-iframe";
            iframe.style.display = "none";
            document.body.appendChild(iframe);
        }

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

        if (!confirm(confirmMessage)) return;

        await this.handleApiCall("/api/delete", "POST", { paths }, async (_response) => {
            await this.listFiles(this.currentPath);
            this.clearSelection();
        });
    }

    initializeEventListeners() {
        this.elements.fileList.addEventListener("click", (e) => {
            const row = e.target.closest("tr");
            if (row?.dataset.upRow) {
                this.listFiles(row.dataset.path);
            }
        });

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

        document.getElementById("deleteItem")?.addEventListener("click", () =>
            handleButtonClick("deleteItem", async () => {
                await this.handleDelete(this.getSelectedItems());
            }),
        );

        document.getElementById("createFolder")?.addEventListener("click", () =>
            handleButtonClick("createFolder", async () => {
                const folderNameInput = document.getElementById("newFolderName");
                const folderName = folderNameInput?.value.trim();
                if (!folderName) {
                    showNotification("Please enter a folder name", "warning");
                    return;
                }

                await this.handleApiCall(
                    "/api/create_folder",
                    "POST",
                    { parentPath: this.currentPath, folderName },
                    async () => {
                        const sep = this.getSeparator();
                        const newFolderPath = this.currentPath.endsWith(sep)
                            ? `${this.currentPath}${folderName}`
                            : `${this.currentPath}${sep}${folderName}`;
                        await this.listFiles(this.currentPath, newFolderPath);
                        if (folderNameInput) folderNameInput.value = "";
                    },
                );
            }),
        );

        document.getElementById("renameItem")?.addEventListener("click", () =>
            handleButtonClick("renameItem", async () => {
                const oldPath = this.getSelectedItems()[0];
                const renameInput = document.getElementById("renameInput");
                const newName = renameInput?.value.trim();

                if (!newName) {
                    showNotification("Please enter a new name", "warning");
                    return;
                }

                await this.handleApiCall("/api/rename", "POST", { oldPath, newName }, async () => {
                    const sep = this.getSeparator();
                    const newPath = this.currentPath.endsWith(sep)
                        ? `${this.currentPath}${newName}`
                        : `${this.currentPath}${sep}${newName}`;
                    await this.listFiles(this.currentPath, newPath);
                    document.getElementById("fileOperations")?.classList.add("hidden");
                    this.clearSelection();
                    if (renameInput) renameInput.value = "";
                });
            }),
        );
        document.getElementById("renameInput")?.addEventListener("input", (e) => {
            if (/[/\\]/.test(e.target.value)) {
                e.target.value = e.target.value.replace(/[/\\]/g, "");
            }
        });
        document.getElementById("renameInput")?.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                document.getElementById("renameItem")?.click();
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
        }
    }

    initializeSortListeners() {
        document.querySelectorAll("#fileTable th[data-sort]").forEach((th) => {
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
            this.selectionManager.config.getAllIds = () =>
                this.filteredList.filter((i) => !i.isUpRow).map((i) => i.path);
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
        this.element.classList.add("border-pink-500", "shadow-[0_0_15px_rgba(236,72,153,0.3)]");
    }

    unhighlight() {
        if (this.overlay) {
            this.overlay.classList.add("opacity-0");
            setTimeout(() => this.overlay.classList.add("hidden"), 200);
        }
        this.element.classList.remove("border-pink-500", "shadow-[0_0_15px_rgba(236,72,153,0.3)]");
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
    window.fileManagerInstance = fileManager;
}

export { initializeFileManagement };
