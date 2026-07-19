import "../input.css";
import "../css/styles.css";
import { initializeSocketIO } from "@/core/socket";
import { initializeNavigation } from "@/core/navigation";
import { initializeShortcuts } from "@/core/shortcuts";
import { AudioManager } from "@/features/audio/audio-manager";
import { initializeStream } from "@/features/stream/stream";
import { initializeCamera } from "@/features/camera/camera";
import { InteractiveShell } from "@/features/shell/shell";
import { initializeFileManagement } from "@/features/files/file-manager";
import { renderInputGrids } from "@/features/input/input-grid";
import { initializeInputHandlers } from "@/features/input/input-controller";
import { updateSystemInfo } from "@/features/system/system-panel";
import { initializeTaskManager } from "@/features/tasks/task-manager";

function updateUIBasedOnAuthentication(isAuthenticated: boolean): void {
    const sections = [
        "streamSection",
        "audioSection",
        "shellSection",
        "fileSection",
        "systemSection",
        "processSection",
    ];

    const logoutButton = document.getElementById("logoutButton")!;
    logoutButton.classList.toggle("hidden", !isAuthenticated);

    if (isAuthenticated) {
        initializeNavigation(isAuthenticated);
    } else {
        sections.forEach((sectionId) => {
            document.getElementById(sectionId)!.classList.add("hidden");
        });
        if (window.location.pathname !== "/login") {
            window.location.href = "/login";
        }
    }
}

// Global interceptor to prevent browser scroll-jumping on tab clicks
document.addEventListener("click", (e) => {
    const tab = (e.target as HTMLElement).closest(".nav-tab");
    if (tab) {
        e.preventDefault();
    }
});

(function () {
    const socket = initializeSocketIO(updateUIBasedOnAuthentication);

    const _audioManager = new AudioManager(socket);

    const _shell = new InteractiveShell("shellSection", socket);

    // Initialize different parts of the application
    initializeStream(socket);
    initializeCamera(socket);
    initializeFileManagement();

    renderInputGrids();
    initializeInputHandlers(socket);
    initializeTaskManager(socket);
    initializeShortcuts();

    // Update system info on load
    void updateSystemInfo();

    // Handle logout
    document.getElementById("logoutButton")!.addEventListener("click", async (e) => {
        e.preventDefault();
        const response = await fetch("/logout");
        if (response.ok) {
            socket.disconnect();
            updateUIBasedOnAuthentication(false);
        }
    });
})();
