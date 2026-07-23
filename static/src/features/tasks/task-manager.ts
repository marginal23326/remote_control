import { apiCall } from "@/shared/api";
import { type ContextMenuContext, ListManager } from "@/shared/list-manager";
import { showConfirmModal } from "@/shared/modal";
import { showNotification } from "@/shared/feedback";
import { bindDebouncedInput, byId, escapeHtml, updateSortIndicators } from "@/shared/dom-helpers";
import { registerShortcuts } from "@/core/shortcuts";
import type { AppSocket } from "@/core/socket";
import type { ProcessDetailsResponse, ProcessInfo } from "@/shared/types";

type SortColumn = "name" | "cpu_percent" | "memory_usage" | "pid";
type SortOrder = "asc" | "desc";

async function killProcesses(items: string[]): Promise<void> {
    if (items.length === 0) return;
    const pids = items.map((pid) => parseInt(pid, 10));

    const confirmed = await showConfirmModal({
        confirmLabel: "End Task",
        danger: true,
        message: `Are you sure you want to end ${pids.length} task(s)?`,
        title: "End Task",
    });
    if (!confirmed) return;

    const results = await Promise.allSettled(pids.map((pid) => apiCall("/api/tasks/kill", "POST", { pid })));

    for (const result of results) {
        if (result.status === "rejected") {
            console.error("Error killing process:", result.reason);
            const msg = result.reason instanceof Error ? result.reason.message : "Unknown error";
            showNotification(msg, "error");
        }
    }
    byId("endTaskContainer")!.classList.remove("is-visible");
}

function sortProcesses(rows: ProcessInfo[], column: SortColumn, order: SortOrder): ProcessInfo[] {
    return rows.toSorted((a, b) => {
        const valueA = a[column];
        const valueB = b[column];
        const modifier = order === "asc" ? 1 : -1;
        const diff = typeof valueA === "number" ? valueA - (valueB as number) : valueA.localeCompare(valueB as string);
        return diff === 0 ? (a.pid - b.pid) * modifier : diff * modifier;
    });
}

export function initializeTaskManager(socket: AppSocket): void {
    const currentSort: { column: SortColumn; order: SortOrder } = { column: "memory_usage", order: "desc" };
    let allProcesses: ProcessInfo[] = [];
    let processes: ProcessInfo[] = [];
    let searchTerm = "";

    const taskList = byId("taskList")!;
    const searchInput = byId<HTMLInputElement>("taskSearchInput");

    let taskManager: ListManager;
    taskManager = new ListManager({
        containerSelector: "#taskList",
        getContextMenuItems: (context?: ContextMenuContext) => {
            const selectedItems = context?.selectedItems ?? taskManager.getSelectedItems();
            const items = [];

            if (selectedItems.length === 1) {
                items.push({
                    label: "Process Details",
                    action: async () => {
                        const pid = selectedItems[0];
                        try {
                            const res = await apiCall<ProcessDetailsResponse>(`/api/tasks/${pid}`);
                            const d = res.data;
                            let msg = `Process: ${d.name} (PID: ${d.pid})\nMemory: ${d.rss_memory_mb.toFixed(2)} MB`;
                            if (d.rss_memory_mb !== d.exact_memory_mb) {
                                msg += `\nAccurate (PSS): ${d.exact_memory_mb.toFixed(2)} MB`;
                            }
                            showNotification(msg, "info");
                        } catch (err) {
                            showNotification("Failed to get details: " + (err as Error).message, "error");
                        }
                    },
                });
            }

            if (selectedItems.length > 0) {
                items.push({ label: "End Task (Del)", action: () => killProcesses(selectedItems) });
            }

            return items;
        },
        getItemId: (element) => element.dataset.pid,
        itemDataAttribute: "pid",
        onSelectionChange: (selectedItems) => {
            const endTaskContainer = byId("endTaskContainer")!;
            const countEl = byId("taskSelectionCount");
            endTaskContainer.classList.toggle("is-visible", selectedItems.length > 0);
            if (countEl) {
                countEl.textContent = `${selectedItems.length} selected`;
            }
        },
    });

    function renderTaskList(newProcesses?: ProcessInfo[]): void {
        if (newProcesses) {
            allProcesses = newProcesses;
        }

        const term = searchTerm.trim().toLowerCase();
        processes = term ? allProcesses.filter((process) => process.name.toLowerCase().includes(term)) : allProcesses;
        processes = sortProcesses(processes, currentSort.column, currentSort.order);

        const fragment = document.createDocumentFragment();
        processes.forEach((process) => {
            const row = document.createElement("tr");
            row.classList.add("cursor-pointer");
            row.dataset.pid = String(process.pid);

            row.innerHTML = `
                <td class="px-4 py-1 whitespace-nowrap text-sm text-zinc-100">
                    ${escapeHtml(process.name)}
                </td>
                <td class="px-4 py-1 whitespace-nowrap text-sm text-zinc-400">${process.cpu_percent.toFixed(1)}%</td>
                <td class="px-4 py-1 whitespace-nowrap text-sm text-zinc-400">${process.memory_usage.toFixed(2)} MB</td>
                <td class="px-4 py-1 whitespace-nowrap text-sm text-zinc-500">${process.pid}</td>
            `;

            fragment.append(row);
        });

        taskList.replaceChildren(fragment);

        updateSortIndicators("#processSection thead th", currentSort.column, currentSort.order === "asc");

        taskManager.selectionManager!.notifyItemsUpdate();
        taskManager.config.onSelectionChange(taskManager.getSelectedItems());

        const endTaskButton = byId<HTMLElement & { hasListener?: boolean }>("endTaskButton");
        if (endTaskButton && !endTaskButton.hasListener) {
            endTaskButton.innerHTML = `End Task`;
            endTaskButton.addEventListener("click", () => {
                const selectedItems = taskManager.getSelectedItems();
                void killProcesses(selectedItems);
            });
            endTaskButton.hasListener = true;
        }
    }

    // Handle sorting
    document.querySelectorAll<HTMLElement>("#processSection thead th").forEach((header) => {
        header.addEventListener("click", () => {
            const column = header.dataset.sort as SortColumn | undefined;
            if (column) {
                currentSort.order = currentSort.column === column && currentSort.order === "asc" ? "desc" : "asc";
                currentSort.column = column;
                renderTaskList();
            }
        });
    });

    // Handle searching
    if (searchInput) {
        bindDebouncedInput(searchInput, () => {
            searchTerm = searchInput.value;
            renderTaskList();
        });
        searchInput.addEventListener("keydown", (e) => {
            if (e.key === "Escape") {
                searchInput.value = "";
                searchTerm = "";
                renderTaskList();
                searchInput.blur();
            }
        });
    }

    // Socket events
    socket.on("task_list", (data) => {
        const totalCpuUsage = document.querySelector('#processSection th[data-sort="cpu_percent"] .total-usage');
        const totalMemoryUsage = document.querySelector('#processSection th[data-sort="memory_usage"] .total-usage');

        if (totalCpuUsage) {
            totalCpuUsage.textContent = `(${data.total_cpu_usage.toFixed(1)}%)`;
        }

        if (totalMemoryUsage) {
            totalMemoryUsage.textContent = `(${data.total_memory_percentage.toFixed(1)}%)`;
        }

        if (taskManager.selectionManager!.isDragging) return;
        renderTaskList(data.processes);
    });

    window.addEventListener("sectionchange", (event) => {
        const activeSection = event.detail.activeSectionId;
        if (activeSection === "processSection") {
            socket.emit("task_poll_start");
        } else {
            socket.emit("task_poll_stop");
        }
    });

    registerShortcuts("processSection", {
        delete: () => byId("endTaskButton")?.click(),
    });

    taskManager.initialize();
}
