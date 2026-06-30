// static/js/modules/task.js
import { apiCall, BaseTaskManager } from "./utils.js";
import { showNotification } from "./dom.js";

function initializeTaskManager(socket) {
    let _selectedProcess = null;
    let currentSort = { column: "memory_usage", order: "desc" };
    let processes = [];

    const taskList = document.getElementById("taskList");

    async function killProcesses(items) {
        if (!items.length) return;
        const pids = items.map((pid) => parseInt(pid));
        if (!confirm(`Are you sure you want to kill ${pids.length} process(es)?`)) return;

        for (const pid of pids) {
            try {
                await apiCall("/api/tasks/kill", "POST", { pid });
            } catch (error) {
                console.error("Error killing process:", error);
                showNotification(error.message, "error");
            }
        }
        document.getElementById("endTaskContainer").classList.add("hidden");
    }

    const taskManager = new BaseTaskManager({
        onKillProcess: killProcesses,
        getContextMenuItems: (defaultItems, selectedItems) => {
            const items = [];

            if (selectedItems.length === 1) {
                items.push({
                    label: "Process Details",
                    action: async () => {
                        const pid = selectedItems[0];
                        try {
                            const res = await apiCall(`/api/tasks/${pid}`);
                            const d = res.data;
                            let msg =
                                `Process: ${d.name} (PID: ${d.pid})\n` + `Memory: ${d.rss_memory_mb.toFixed(2)} MB`;
                            if (d.rss_memory_mb !== d.exact_memory_mb) {
                                msg += `\nAccurate (PSS): ${d.exact_memory_mb.toFixed(2)} MB`;
                            }
                            showNotification(msg, "info");
                        } catch (err) {
                            showNotification("Failed to get details: " + err.message, "error");
                        }
                    },
                });
            }

            return [...items, ...defaultItems];
        },
    });

    function renderTaskList(newProcesses) {
        processes = newProcesses;
        sortProcesses(processes, currentSort.column, currentSort.order);

        const fragment = document.createDocumentFragment();
        processes.forEach((process) => {
            const row = document.createElement("tr");
            row.classList.add("cursor-pointer");
            row.dataset.pid = process.pid;

            row.innerHTML = `
                <td class="px-4 py-1 whitespace-nowrap text-sm text-zinc-100">
                    ${process.name}
                </td>
                <td class="px-4 py-1 whitespace-nowrap text-sm text-zinc-400">${process.cpu_percent.toFixed(1)}%</td>
                <td class="px-4 py-1 whitespace-nowrap text-sm text-zinc-400">${process.memory_usage.toFixed(1)} MB</td>
                <td class="px-4 py-1 whitespace-nowrap text-sm text-zinc-500">${process.pid}</td>
            `;

            fragment.appendChild(row);
        });

        taskList.innerHTML = "";
        taskList.appendChild(fragment);

        // Update sort indicators
        document.querySelectorAll("#processSection thead th").forEach((header) => {
            const column = header.dataset.column;
            const icon = header.querySelector(".sort-icon");
            if (icon) {
                if (column === currentSort.column) {
                    icon.textContent = currentSort.order === "asc" ? "▲" : "▼";
                    icon.classList.remove("opacity-0");
                    icon.classList.add("opacity-100", "text-zinc-100");
                } else {
                    icon.classList.remove("opacity-100", "text-zinc-100");
                    icon.classList.add("opacity-0");
                }
            }
        });

        taskManager.selectionManager.notifyItemsUpdate();
        taskManager.config.onSelectionChange(taskManager.getSelectedItems());

        const endTaskButton = document.getElementById("endTaskButton");
        if (!endTaskButton.hasListener) {
            endTaskButton.innerHTML = `Kill Process`;
            endTaskButton.addEventListener("click", () => {
                const selectedItems = taskManager.getSelectedItems();
                killProcesses(selectedItems);
            });
            endTaskButton.hasListener = true;
        }
    }

    function sortProcesses(processes, column, order) {
        return processes.sort((a, b) => {
            const valueA = a[column];
            const valueB = b[column];
            const modifier = order === "asc" ? 1 : -1;
            const diff = typeof valueA === "number" ? valueA - valueB : valueA.localeCompare(valueB);
            return diff !== 0 ? diff * modifier : (a.pid - b.pid) * modifier;
        });
    }

    // Handle sorting
    document.querySelectorAll("#processSection thead th").forEach((header) => {
        header.addEventListener("click", () => {
            const column = header.dataset.column;
            if (column) {
                currentSort.order = currentSort.column === column && currentSort.order === "asc" ? "desc" : "asc";
                currentSort.column = column;
                renderTaskList(processes);
            }
        });
    });

    // Socket events
    socket.on("task_list", (data) => {
        const totalCpuUsage = document.querySelector('#processSection th[data-column="cpu_percent"] .total-usage');
        const totalMemoryUsage = document.querySelector('#processSection th[data-column="memory_usage"] .total-usage');

        if (totalCpuUsage) {
            totalCpuUsage.textContent = `(${data.total_cpu_usage.toFixed(1)}%)`;
        }

        if (totalMemoryUsage) {
            totalMemoryUsage.textContent = `(${data.total_memory_percentage.toFixed(1)}%)`;
        }

        if (taskManager.selectionManager.isDragging) return;
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

    taskManager.initialize();
}

export { initializeTaskManager };
