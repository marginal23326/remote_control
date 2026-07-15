import { initializeCaptureToggles } from "./capture-state.ts";
import { initializeKeyboardShortcuts } from "./keyboard-shortcuts.ts";
import { initializePointerInput } from "./pointer-input.ts";
import type { AppSocket } from "@/core/socket.ts";

export function initializeInputHandlers(socket: AppSocket): void {
    initializeCaptureToggles();
    initializeKeyboardShortcuts(socket);
    initializePointerInput(socket);
}
