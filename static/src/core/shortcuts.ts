import { isTypingField } from "@/shared/dom-helpers";

export type ShortcutHandler = (event: KeyboardEvent) => void;
export type SectionShortcuts = Record<string, ShortcutHandler>;

const sectionShortcuts = new Map<string, SectionShortcuts>();

function isModalOpen(): boolean {
    return document.querySelector("[data-app-modal]") !== null;
}

function isDisconnected(): boolean {
    const overlay = document.getElementById("connectionOverlay");
    return !!overlay && !overlay.classList.contains("hidden");
}

function isSectionActive(sectionId: string): boolean {
    const section = document.getElementById(sectionId);
    return !!section && !section.classList.contains("hidden");
}

export function registerShortcuts(sectionId: string, shortcuts: SectionShortcuts): void {
    sectionShortcuts.set(sectionId, shortcuts);
}

export function initializeShortcuts(): void {
    document.addEventListener("keydown", (e) => {
        if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
        if (isTypingField(e.target) || isModalOpen() || isDisconnected()) return;

        const currentSectionId = activeSectionId();
        const shortcuts = currentSectionId ? sectionShortcuts.get(currentSectionId) : undefined;
        const handler = shortcuts && shortcuts[e.key.toLowerCase()];
        if (!handler) return;

        e.preventDefault();
        handler(e);
    });
}

function activeSectionId(): string | null {
    for (const sectionId of sectionShortcuts.keys()) {
        if (isSectionActive(sectionId)) return sectionId;
    }
    return null;
}
