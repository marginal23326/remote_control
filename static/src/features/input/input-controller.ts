import { initializeCaptureToggles } from "./capture-state";
import { initializeKeyboardShortcuts } from "./keyboard-shortcuts";
import { initializePointerInput } from "./pointer-input";
import type { AppSocket } from "@/core/socket";

export function initializeInputHandlers(socket: AppSocket): void {
    initializeCaptureToggles();
    initializeKeyboardShortcuts(socket);
    initializePointerInput(socket);
}
