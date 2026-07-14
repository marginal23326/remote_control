import "../input.css";
import "../css/styles.css";
import { initializeSocketIO } from "@/core/socket.js";
import { initializeNavigation } from "@/core/navigation.js";
import { initializeShortcuts } from "@/core/shortcuts.js";
import { AudioManager } from "@/features/audio/audio-manager.js";
import { initializeStream } from "@/features/stream/stream.js";
import { initializeCamera } from "@/features/camera/camera.js";
import { InteractiveShell } from "@/features/shell/shell.js";
import { initializeFileManagement } from "@/features/files/file-manager.js";
import { renderInputGrids } from "@/features/input/input-grid.js";
import { initializeInputHandlers } from "@/features/input/input-controller.js";
import { updateSystemInfo } from "@/features/system/system-panel.js";
import { initializeTaskManager } from "@/features/tasks/task-manager.js";

function updateUIBasedOnAuthentication(isAuthenticated) {
    const sections = [
        "streamSection",
        "audioSection",
        "shellSection",
        "fileSection",
        "systemSection",
        "processSection",
    ];

    const logoutButton = document.getElementById("logoutButton");
    logoutButton.classList.toggle("hidden", !isAuthenticated);

    if (!isAuthenticated) {
        sections.forEach((sectionId) => {
            document.getElementById(sectionId).classList.add("hidden");
        });
        if (window.location.pathname !== "/login") {
            window.location.href = "/login";
        }
    } else {
        initializeNavigation(isAuthenticated);
    }
}

// Global interceptor to prevent browser scroll-jumping on tab clicks
document.addEventListener("click", (e) => {
    const tab = e.target.closest(".nav-tab");
    if (tab) {
        e.preventDefault();
    }
});

(function () {
    const socket = initializeSocketIO(updateUIBasedOnAuthentication);

    const sessionId = Math.random().toString(36).substring(2);

    const _audioManager = new AudioManager(socket);

    const _shell = new InteractiveShell("shellSection", socket);

    // Initialize different parts of the application
    initializeStream(sessionId, socket);
    initializeCamera(socket);
    initializeFileManagement();

    renderInputGrids();
    initializeInputHandlers(socket);
    initializeTaskManager(socket);
    initializeShortcuts();

    // Update system info on load
    updateSystemInfo();

    // Handle logout
    document.getElementById("logoutButton").addEventListener("click", async (e) => {
        e.preventDefault();
        const response = await fetch("/logout");
        if (response.ok) {
            socket.disconnect();
            updateUIBasedOnAuthentication(false);
        }
    });
})();
