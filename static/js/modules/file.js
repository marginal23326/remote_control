// static/js/modules/file.js
import { apiCall, SVG_TEMPLATES, CLASSES, formatFileSize, formatDate, BaseFileManager, escapeHtml } from "./utils.js";
import { LoadingButton } from "./dom.js";

class FileManager extends BaseFileManager {
    constructor() {
        super();
        this.currentPath = "";
        this.currentFileList = [];
        this.sortColumn = "name";
        this.sortDirection = "asc";
        this.buttons = {};
        this.dropZone = null;
        this.elements = {
            fileList: null,
            currentPath: null,
            searchInput: null,
        };
    }

    initializeElements() {
        this.elements.fileList = document.getElementById("fileList");
        this.elements.currentPath = document.getElementById("currentPath");
        this.elements.searchInput = document.getElementById("searchInput");
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
                    return button ? [id, new LoadingButton(button, loadingText)] : null;
                })
                .filter(Boolean),
        );
    }

    async handleFileUpload(files, isDropZone = false) {
        if (!files.length) return;

        if (!this.currentPath) {
            alert("Please navigate to a directory before uploading files.");
            return;
        }

        const formData = new FormData();
        formData.append("path", this.currentPath);
        Array.from(files).forEach((file) => formData.append("files", file));

        if (isDropZone) this.dropZone.setLoading();
        const uploadLabel = document.querySelector('label[for="fileUpload"] span');
        const originalText = uploadLabel?.textContent || "Upload";
        if (uploadLabel) uploadLabel.textContent = "Uploading...";

        try {
            await this.handleApiCall("/api/upload", "POST", formData, async () => {
                const lastFile = files[files.length - 1].name;
                const sep = this.getSeparator();
                const highlightPath = `${this.currentPath}${this.currentPath.endsWith(sep) ? "" : sep}${lastFile}`;
                await this.listFiles(this.currentPath, highlightPath);
            });
        } finally {
            if (isDropZone) this.dropZone.reset();
            if (uploadLabel) uploadLabel.textContent = originalText;
            const fileInput = document.getElementById("fileUpload");
            if (fileInput) fileInput.value = "";
        }
    }

    async handleApiCall(apiEndpoint, method, data, successCallback) {
        try {
            const response = await apiCall(apiEndpoint, method, data);
            if (response.message) alert(response.message);
            successCallback?.(response);
        } catch (error) {
            console.error(`Error in ${apiEndpoint}:`, error);
            alert(`Error: ${error.message}`);
        }
    }

    createTableRow(item, additionalClasses = []) {
        const row = document.createElement("tr");
        row.classList.add(...CLASSES.row, ...additionalClasses, CLASSES.defaultHover);
        if (item) {
            row.dataset.path = item.path;
            row.dataset.isDir = item.is_dir.toString();
            row.dataset.name = item.name;
        }

        return row;
    }

    updateFileOperationsUI() {
        const selectionCount = this.selectionManager.selectedItems.size;

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
            const selectedItem = Array.from(this.selectionManager.selectedItems)[0];
            if (selectedItem.dataset.name) elements.renameInput.value = selectedItem.dataset.name;
        } else if (elements.renameInput) {
            elements.renameInput.value = "";
        }
    }

    createUpDirectoryRow(path, onClick) {
        const upRow = this.createTableRow();
        upRow.onclick = onClick;
        upRow.innerHTML = `<td colspan="3" class="px-2 whitespace-nowrap"><div class="flex items-center gap-2">${SVG_TEMPLATES.upArrow()}..</div></td>`;
        return upRow;
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

        const chevron = `<svg class="w-3.5 h-3.5 text-gray-500 flex-shrink-0 mx-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>`;

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

        setTimeout(() => (container.scrollLeft = container.scrollWidth), 10);
    }

    async updateFileList(items, highlightPath = null) {
        this.currentFileList = items;

        const sortedItems = [...items].sort((a, b) => {
            if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;

            const dirMultiplier = this.sortDirection === "asc" ? 1 : -1;

            if (this.sortColumn === "name") {
                return dirMultiplier * a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
            }

            const key = this.sortColumn === "modified" ? "last_modified" : this.sortColumn;
            const valA = a[key] ?? 0;
            const valB = b[key] ?? 0;

            return dirMultiplier * (valA - valB);
        });

        const upRow =
            this.currentPath !== ""
                ? `<tr data-up-row="true" data-is-dir="true" data-path="${escapeHtml(this.getParentPath())}" class="${CLASSES.row.join(" ")} ${CLASSES.defaultHover}"><td colspan="3" class="px-2 whitespace-nowrap"><div class="flex items-center gap-2">${SVG_TEMPLATES.upArrow()}..</div></td></tr>`
                : "";

        this.elements.fileList.innerHTML =
            upRow +
            (sortedItems.length === 0
                ? `<tr><td colspan="3" class="px-2 whitespace-nowrap"><div class="text-center text-gray-500 py-8 font-mono">Directory is empty</div></td></tr>`
                : sortedItems
                      .map((item) => {
                          const dateStr = item.last_modified ? formatDate(item.last_modified) : "-";
                          const highlight = highlightPath && item.path === highlightPath ? CLASSES.highlight : "";
                          const accessCls = item.no_access ? CLASSES.noAccess : "";

                          return `<tr data-path="${escapeHtml(item.path)}" data-is-dir="${item.is_dir}" data-name="${escapeHtml(item.name)}" class="${CLASSES.row.join(" ")} ${CLASSES.defaultHover} ${accessCls} ${highlight}">
                    <td class="px-2 whitespace-nowrap w-full">${this.createItemNameCell(item)}</td>
                    <td class="px-2 whitespace-nowrap hidden sm:table-cell">${item.is_dir ? "-" : formatFileSize(item.size)}</td>
                    <td class="px-2 whitespace-nowrap hidden md:table-cell">${dateStr}</td>
                </tr>`;
                      })
                      .join(""));

        this.filterFiles(this.elements.searchInput?.value || "");
    }

    filterFiles(searchTerm) {
        const term = searchTerm.toLowerCase();
        this.elements.fileList.querySelectorAll("tr[data-path]").forEach((row) => {
            if (row.dataset.name) {
                row.style.display = row.dataset.name.toLowerCase().includes(term) ? "" : "none";
            }
        });
    }

    createItemNameCell(item) {
        const iconTemplate = item.is_dir ? SVG_TEMPLATES.folder : SVG_TEMPLATES.file;
        const icon = item.is_dir && item.no_access ? iconTemplate("text-gray-500") : iconTemplate();
        const safeName = escapeHtml(item.name);
        return `<div class="flex items-center gap-2 truncate overflow-hidden">${icon}<span class="truncate block w-full" title="${safeName}">${safeName}</span></div>`;
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

    async listFiles(path, highlightPath = null) {
        this.clearSelection();
        this.updateFileOperationsUI();
        const fileList = document.getElementById("fileList");

        if (path !== this.currentPath) {
            fileList.innerHTML = `<tr><td colspan="3" class="p-4 text-center text-gray-400">Loading...</td></tr>`;
            if (this.elements.searchInput) this.elements.searchInput.value = "";
        }

        try {
            const response = await apiCall(`/api/files?path=${encodeURIComponent(path)}`);

            if (response.status === "error") {
                const errorMsg = response.no_access
                    ? `Access Denied: You do not have permission to view ${path}`
                    : response.message;

                fileList.innerHTML = `<tr><td colspan="3" class="p-4 text-center text-red-500"></td></tr>`;
                fileList.querySelector("td").textContent = errorMsg;

                if (path !== "") {
                    const previousPath = this.currentPath;
                    const upRow = this.createUpDirectoryRow(path, () => this.listFiles(previousPath));
                    fileList.insertBefore(upRow, fileList.firstChild);
                }
                return;
            }

            this.currentPath = path;
            this.updateBreadcrumbs();

            await this.updateFileList(response, highlightPath);

            this.selectionManager.notifyItemsUpdate();
        } catch (error) {
            console.error("Error listing files:", error);
            fileList.innerHTML = `<tr><td colspan="3" class="p-4 text-center text-red-500"></td></tr>`;
            fileList.querySelector("td").textContent = `Error: ${error.message}`;
        }
    }

    async handleDownload(selectedItems) {
        if (selectedItems.length === 0) return;

        const paths = selectedItems.map((item) => item.dataset.path);

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

    async handleDelete(selectedItems) {
        const paths = selectedItems.map((item) => item.dataset.path);
        const confirmMessage =
            paths.length === 1
                ? `Are you sure you want to delete ${paths[0]}?`
                : `Are you sure you want to delete ${paths.length} items?`;

        if (!confirm(confirmMessage)) return;

        await this.handleApiCall("/api/delete", "POST", { paths }, async (_response) => {
            await this.listFiles(this.currentPath);
            this.clearSelection();
        });
    }

    initializeEventListeners() {
        this.elements.fileList.addEventListener("click", (e) => {
            setTimeout(() => this.updateFileOperationsUI(), 50);

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
                    alert("Please enter a folder name");
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
                const selectedItem = this.getSelectedItems()[0];
                const oldPath = selectedItem.dataset.path;
                const renameInput = document.getElementById("renameInput");
                const newName = renameInput?.value.trim();

                if (!newName) {
                    alert("Please enter a new name");
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
            searchInput.addEventListener("input", (e) => {
                clearTimeout(searchTimeout);
                searchTimeout = setTimeout(() => {
                    this.filterFiles(e.target.value);
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
                this.updateFileList(this.currentFileList);
                this.selectionManager.notifyItemsUpdate();
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
}

export { initializeFileManagement };
