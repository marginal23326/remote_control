import { initializeCaptureToggles } from "./capture-state.js";
import { initializeKeyboardShortcuts } from "./keyboard-shortcuts.js";
import { initializePointerInput } from "./pointer-input.js";

function initializeInputHandlers(socket) {
    initializeCaptureToggles();
    initializeKeyboardShortcuts(socket);
    initializePointerInput(socket);
}

export { initializeInputHandlers };
