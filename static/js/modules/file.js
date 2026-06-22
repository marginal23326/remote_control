// static/js/modules/file.js
import { apiCall, SVG_TEMPLATES, CLASSES, formatFileSize, formatDate, BaseFileManager } from "./utils.js";
import { LoadingButton } from "./dom.js";

class FileManager extends BaseFileManager {
    constructor() {
        super();
        this.currentPath = "";
        this.currentFileList = [];
        this.buttons = {};
        this.dropZone = null;
        this.filteredRows = new Map();
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
            uploadFile: "Uploading...",
            refresh: "Refreshing...",
        };

        this.buttons = Object.fromEntries(
            Object.entries(buttonConfigs)
                .map(([id, loadingText]) => {
                    const button = document.getElementById(id);
                    if (id === "deleteItem" && button) {
                        const label = button.textContent.trim();
                        button.innerHTML = `
                            <span class="inline-flex items-center gap-2">
                                ${SVG_TEMPLATES.cross("w-4 h-4")}
                                <span>${label}</span>
                            </span>
                        `;
                    }
                    return button ? [id, new LoadingButton(button, loadingText)] : null;
                })
                .filter(Boolean),
        );
    }

    async handleFileUpload(files, isDropZone = false) {
        if (!files.length) return;

        const formData = new FormData();
        formData.append("path", this.currentPath);
        Array.from(files).forEach((file) => formData.append("files", file));

        if (isDropZone) this.dropZone.setLoading();

        try {
            await this.handleApiCall("/api/upload", "POST", formData, async () => {
                const lastFile = files[files.length - 1].name;
                const sep = this.getSeparator();
                const highlightPath = `${this.currentPath}${this.currentPath.endsWith(sep) ? "" : sep}${lastFile}`;
                await this.listFiles(this.currentPath, highlightPath);

                if (!isDropZone) {
                    const fileInput = document.getElementById("fileUpload");
                    if (fileInput) fileInput.value = "";
                    const label = document.getElementById("selectedFileName");
                    if (label) label.textContent = "No file chosen";
                }
            });
        } finally {
            if (isDropZone) this.dropZone.reset();
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

        ["mouseover", "mouseout"].forEach((event) => {
            row.addEventListener(event, () => {
                row.dataset.hovered = event === "mouseover";
                this.selectionManager.updateItemHover(row);
            });
        });

        return row;
    }

    createCell(content, colSpan = 1) {
        const cell = document.createElement("td");
        cell.classList.add(...CLASSES.cell);
        cell.colSpan = colSpan;
        cell.innerHTML = content;
        return cell;
    }

    updateFileOperationsUI() {
        const selectionCount = this.selectionManager.selectedItems.size;

        const elements = {
            operations: document.getElementById("fileOperations"),
            download: document.getElementById("downloadFile"),
            delete: document.getElementById("deleteItem"),
            renameInput: document.getElementById("renameInput"),
            renameButton: document.getElementById("renameItem"),
        };

        if (elements.operations) elements.operations.classList.toggle("hidden", !selectionCount);

        if (elements.download) elements.download.disabled = !selectionCount;
        if (elements.delete) elements.delete.disabled = !selectionCount;
        if (elements.renameInput) elements.renameInput.disabled = selectionCount !== 1;
        if (elements.renameButton) elements.renameButton.disabled = selectionCount !== 1;

        if (selectionCount === 1 && elements.renameInput) {
            const selectedItem = Array.from(this.selectionManager.selectedItems)[0];
            if (selectedItem.dataset.name) elements.renameInput.value = selectedItem.dataset.name;
        } else if (elements.renameInput) {
            elements.renameInput.value = "";
        }
    }

    createUpDirectoryRow(path, onClick) {
        const upRow = this.createTableRow();
        upRow.addEventListener("click", onClick);
        upRow.appendChild(
            this.createCell(`<div class="flex items-center gap-2">${SVG_TEMPLATES.upArrow()}..</div>`, 3),
        );
        return upRow;
    }

    async updateFileList(items, highlightPath = null) {
        const fragment = document.createDocumentFragment();

        if (this.currentPath !== "") {
            const upRow = this.createUpDirectoryRow(this.currentPath, () => this.listFiles(this.getParentPath()));
            fragment.appendChild(upRow);
        }

        items.forEach((item) => {
            const row = this.createTableRow(item, item.no_access ? CLASSES.noAccess : []);

            if (item.is_dir) {
                row.addEventListener("dblclick", () => this.listFiles(item.path));
            }

            const cells = [this.createItemNameCell(item)];

            const dateStr = item.last_modified ? formatDate(item.last_modified) : "-";

            if (item.is_dir) {
                cells.push("-", dateStr);
            } else {
                cells.push(formatFileSize(item.size), dateStr);
            }

            cells.forEach((content) => row.appendChild(this.createCell(content)));

            if (highlightPath && item.path === highlightPath) {
                row.classList.add(CLASSES.highlight);
                setTimeout(() => row.classList.remove(CLASSES.highlight), 1500);
            }

            fragment.appendChild(row);
        });

        this.elements.fileList.innerHTML = "";
        this.elements.fileList.appendChild(fragment);

        this.currentFileList = items;
        this.filteredRows.clear();
        this.filterFiles("");
    }

    filterFiles(searchTerm) {
        const normalizedSearch = searchTerm.toLowerCase();
        if (!this.filteredRows.has(normalizedSearch)) {
            const visibilityMap = new Map();
            this.elements.fileList.querySelectorAll("tr[data-path]").forEach((row) => {
                if (row.dataset.name) {
                    const fileName = row.dataset.name.toLowerCase();
                    visibilityMap.set(row, fileName.includes(normalizedSearch));
                }
            });
            this.filteredRows.set(normalizedSearch, visibilityMap);
        }

        const visibilityMap = this.filteredRows.get(normalizedSearch);
        visibilityMap.forEach((isVisible, row) => {
            row.style.display = isVisible ? "" : "none";
        });
    }

    createItemNameCell(item) {
        const escapeHtml = (str) => {
            return (str || "")
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")
                .replace(/"/g, "&quot;")
                .replace(/'/g, "&#039;");
        };

        const iconTemplate = item.is_dir ? SVG_TEMPLATES.folder : SVG_TEMPLATES.file;
        const icon = item.is_dir && item.no_access ? iconTemplate("text-gray-500") : iconTemplate();
        const safeName = escapeHtml(item.name);
        return `<div class="flex items-center gap-2">${icon}${safeName}</div>`;
    }

    getSeparator() {
        return this.currentPath.includes("\\") ? "\\" : "/";
    }

    getParentPath() {
        const path = this.currentPath;

        if (path.match(/^[A-Z]:\\$/) || path === "/") return "";

        const cleaned = path.replace(/[\\/]$/, "");
        const lastSlash = cleaned.lastIndexOf("/");
        const lastBackslash = cleaned.lastIndexOf("\\");
        const lastSep = Math.max(lastSlash, lastBackslash);

        if (lastSep <= 0) return "/";

        const sep = lastSep === lastSlash ? "/" : "\\";
        return cleaned.substring(0, lastSep) + sep;
    }

    async listFiles(path, highlightPath = null) {
        this.clearSelection();
        this.updateFileOperationsUI();
        const fileList = document.getElementById("fileList");

        if (path !== this.currentPath) {
            fileList.innerHTML = `<tr><td colspan="3" class="p-4 text-center text-gray-400">Loading...</td></tr>`;
        }

        try {
            // Encode path components properly
            const response = await apiCall(`/api/files?path=${encodeURIComponent(path)}`);

            if (response.status === "error") {
                const errorMsg = response.no_access
                    ? `Access Denied: You do not have permission to view ${path}`
                    : response.message;

                fileList.innerHTML = `<tr><td colspan="3" class="p-4 text-center text-red-500"></td></tr>`;
                fileList.querySelector("td").textContent = errorMsg;

                // Allow going back up even if current view failed
                if (path !== "") {
                    const previousPath = this.currentPath;
                    const upRow = this.createUpDirectoryRow(path, () => this.listFiles(previousPath));
                    // Prepend the back button so it's always available
                    fileList.insertBefore(upRow, fileList.firstChild);
                }
                return;
            }

            this.currentPath = path;
            const currentPathEl = document.getElementById("currentPath");
            if (currentPathEl) currentPathEl.textContent = `Current Path: ${this.currentPath}`;

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
        const queryString = paths.map((path) => `paths[]=${encodeURIComponent(path)}`).join("&");
        const url = `/api/download?${queryString}`;

        const iframe = document.getElementById("global-download-iframe");
        if (!iframe) {
            const el = document.createElement("iframe");
            el.id = "global-download-iframe";
            el.style.display = "none";
            document.body.appendChild(el);
        }
        document.getElementById("global-download-iframe").src = url;
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
        this.elements.fileList.addEventListener("click", () => {
            setTimeout(() => this.updateFileOperationsUI(), 50);
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

        document.getElementById("uploadFile")?.addEventListener("click", () =>
            handleButtonClick("uploadFile", async () => {
                const fileInput = document.getElementById("fileUpload");
                if (!fileInput?.files.length) {
                    alert("Please select a file to upload");
                    return;
                }
                await this.handleFileUpload(fileInput.files);
            }),
        );

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

        document.getElementById("fileUpload")?.addEventListener("change", function () {
            const selectedFileName = document.getElementById("selectedFileName");
            if (!selectedFileName) return;

            selectedFileName.textContent =
                this.files.length > 1 ? `${this.files.length} files selected` : this.files[0]?.name || "No file chosen";
            selectedFileName.classList.toggle("text-gray-400", this.files.length === 0);
            selectedFileName.classList.toggle("text-green-400", this.files.length > 0);
        });

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

    initialize() {
        this.initializeElements();
        this.initializeButtons();
        this.dropZone = new DropZone("dropZone", this.handleFileUpload.bind(this));
        this.initializeEventListeners();
        super.initialize();
        this.listFiles(this.currentPath);
    }
}

class DropZone {
    constructor(elementId, onUpload) {
        this.element = document.getElementById(elementId);
        this.onUpload = onUpload;
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

        ["dragenter", "dragover"].forEach((event) => this.element.addEventListener(event, () => this.highlight()));

        ["dragleave", "drop"].forEach((event) => this.element.addEventListener(event, () => this.unhighlight()));

        this.element.addEventListener("drop", (e) => this.onUpload(e.dataTransfer.files, true));
    }

    highlight() {
        this.element.classList.add("bg-blue-500/20", "border-blue-700");
    }

    unhighlight() {
        this.element.classList.remove("bg-blue-500/20", "border-blue-700");
    }

    setLoading() {
        this.element.innerHTML = `
            <div class="text-center">
                ${SVG_TEMPLATES.spinner(10)}
                <p class="text-gray-400">Uploading files...</p>
            </div>
        `;
    }

    reset() {
        this.element.innerHTML = `
            <div class="text-center">
                ${SVG_TEMPLATES.upload()}
                <p class="text-gray-400">Drag and drop files here to upload</p>
            </div>
        `;
    }
}

function initializeFileManagement() {
    const fileManager = new FileManager();
    fileManager.initialize();
}

export { initializeFileManagement };
