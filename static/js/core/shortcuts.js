// static/js/core/shortcuts.js
import { isTypingField } from "@/shared/dom-helpers.js";

const sectionShortcuts = new Map();

function isModalOpen() {
    return document.querySelector("[data-app-modal]") !== null;
}

function isDisconnected() {
    const overlay = document.getElementById("connectionOverlay");
    return !!overlay && !overlay.classList.contains("hidden");
}

function isSectionActive(sectionId) {
    const section = document.getElementById(sectionId);
    return !!section && !section.classList.contains("hidden");
}

function registerShortcuts(sectionId, shortcuts) {
    sectionShortcuts.set(sectionId, shortcuts);
}

function initializeShortcuts() {
    document.addEventListener("keydown", (e) => {
        if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
        if (isTypingField(e.target) || isModalOpen() || isDisconnected()) return;

        const shortcuts = sectionShortcuts.get(activeSectionId());
        const handler = shortcuts && shortcuts[e.key.toLowerCase()];
        if (!handler) return;

        e.preventDefault();
        handler(e);
    });
}

function activeSectionId() {
    for (const sectionId of sectionShortcuts.keys()) {
        if (isSectionActive(sectionId)) return sectionId;
    }
    return null;
}

export { registerShortcuts, initializeShortcuts };
