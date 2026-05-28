// static/js/main.js
import "../input.css";
import "../css/styles.css";
import { initializeSocketIO } from "./modules/connection.js";
import { AudioManager } from "./modules/audio.js";
import { initializeStream, updateSettingsDisplay } from "./modules/stream.js";
import { InteractiveShell } from "./modules/shell.js";
import { initializeFileManagement } from "./modules/file.js";
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
    sections.forEach((sectionId) => {
        const section = document.getElementById(sectionId);
        section.classList.toggle("hidden", !isAuthenticated);
    });

    const logoutButton = document.getElementById("logoutButton");
    logoutButton.classList.toggle("hidden", !isAuthenticated);

    if (!isAuthenticated && window.location.pathname !== "/login") {
        window.location.href = "/login";
    }

    initializeNavigation(isAuthenticated);
}

(async function () {
    const socket = initializeSocketIO(updateUIBasedOnAuthentication);

    const sessionId = Math.random().toString(36).substring(2);

    const _audioManager = new AudioManager(socket);

    const _shell = new InteractiveShell("shellSection", socket);

    // Initialize different parts of the application
    initializeStream(sessionId, socket);
    initializeFileManagement();
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
            updateUIBasedOnAuthentication(false); // Update UI for logged-out state
        }
    });
})();
