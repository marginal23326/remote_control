// static/js/main.js
import "../input.css";
import "../css/styles.css";
import { initializeSocketIO } from "./modules/connection.js";
import { AudioManager } from "./modules/audio.js";
import { initializeStream, updateSettingsDisplay } from "./modules/stream.js";
import { InteractiveShell } from "./modules/shell.js";
import { initializeFileManagement } from "./modules/file.js";
import { renderInputSection } from "./modules/input-render.js";
import { initializeInputHandlers } from "./modules/input.js";
import { updateSystemInfo } from "./modules/system.js";
import { apiCall } from "./modules/utils.js";
import { initializeNavigation } from "./modules/nav.js";
import { initializeTaskManager } from "./modules/task.js";

function updateUIBasedOnAuthentication(isAuthenticated) {
    const sections = [
        "streamSection",
        "audioSection",
        "shellSection",
        "keyboardSection",
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

(async function () {
    const socket = initializeSocketIO(updateUIBasedOnAuthentication);

    const sessionId = Math.random().toString(36).substring(2);

    const _audioManager = new AudioManager(socket);

    const _shell = new InteractiveShell("shellSection", socket);

    // Initialize different parts of the application
    initializeStream(sessionId, socket);
    initializeFileManagement();
    renderInputSection();
    initializeInputHandlers(socket);
    initializeTaskManager(socket);

    // Update system info on load
    updateSystemInfo();

    // Get initial stream settings
    try {
        const initialSettings = await apiCall("/api/stream/settings", "GET");
        updateSettingsDisplay(initialSettings);
    } catch {
        console.log("Stream settings not yet available");
    }

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
