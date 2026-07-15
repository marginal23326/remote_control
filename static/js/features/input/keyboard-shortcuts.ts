import { captureState } from "./capture-state.ts";
import type { AppSocket } from "@/core/socket.ts";
import type { KeyboardEventPayload } from "@/core/socket-events.ts";

// Mapping for abstract action names to actual keys
const SHORTCUT_MAP: Record<string, { key: string; modifiers: string[] }> = {
    copy: { key: "c", modifiers: ["ctrl"] },
    cut: { key: "x", modifiers: ["ctrl"] },
    paste: { key: "v", modifiers: ["ctrl"] },
    redo: { key: "y", modifiers: ["ctrl"] },
    save: { key: "s", modifiers: ["ctrl"] },
    selectall: { key: "a", modifiers: ["ctrl"] },
    undo: { key: "z", modifiers: ["ctrl"] },
};

const KEY_MAP: Record<string, string> = {
    " ": "space",
    Alt: "alt",
    ArrowDown: "down",
    ArrowLeft: "left",
    ArrowRight: "right",
    ArrowUp: "up",
    Backspace: "backspace",
    Control: "ctrl",
    Delete: "delete",
    End: "end",
    Enter: "enter",
    Escape: "esc",
    Home: "home",
    Insert: "insert",
    Meta: "win",
    OS: "win",
    PageDown: "pagedown",
    PageUp: "pageup",
    Shift: "shift",
    Tab: "tab",
};

function parseShortcutInput(input: string): { key: string; modifiers: string[] } {
    if (input.includes("+")) {
        const parts = input.split("+");
        return { key: parts.pop()!, modifiers: parts };
    }
    return { key: input, modifiers: [] };
}

// Helper to collect currently active modifiers if sticky mode is enabled
function getActiveModifiers(): string[] {
    const stickyToggle = document.getElementById("stickyToggle") as HTMLInputElement | null;
    if (stickyToggle && !stickyToggle.checked) {
        return [];
    }
    return [...document.querySelectorAll<HTMLElement>(".modifier-btn")]
        .filter((btn) => btn.dataset.active === "true")
        .map((btn) => btn.dataset.modifier!);
}

export function initializeKeyboardShortcuts(socket: AppSocket): void {
    function emitKeyboardEvent(payload: KeyboardEventPayload): void {
        socket.emit("keyboard_event", payload);
    }

    // 1. Handle Standard Shortcut Buttons
    document.querySelectorAll<HTMLElement>("[data-key]").forEach((button) => {
        button.addEventListener("click", (_e) => {
            button.classList.remove(
                "bg-zinc-950",
                "text-zinc-300",
                "border-zinc-800",
                "hover:bg-zinc-800",
                "hover:text-white",
            );
            button.classList.add("bg-zinc-100", "text-zinc-900", "border-zinc-100");
            button.blur();
            setTimeout(() => {
                button.classList.remove("bg-zinc-100", "text-zinc-900", "border-zinc-100");
                button.classList.add(
                    "bg-zinc-950",
                    "text-zinc-300",
                    "border-zinc-800",
                    "hover:bg-zinc-800",
                    "hover:text-white",
                );
            }, 80);

            const rawKey = button.dataset.key!;
            let key = rawKey;
            let modifiers: string[] = [];

            // Case A: Abstract command (e.g., "copy")
            const shortcutEntry = SHORTCUT_MAP[rawKey];
            if (shortcutEntry) {
                key = shortcutEntry.key;
                modifiers = [...shortcutEntry.modifiers];
            }
            // Case B: Combined keys (e.g., "alt+tab", "win+d")
            else {
                const parsed = parseShortcutInput(rawKey);
                key = parsed.key;
                modifiers = parsed.modifiers;
            }

            // Merge default key modifiers with globally active sticky modifiers
            const activeMods = getActiveModifiers();
            modifiers = [...new Set([...modifiers, ...activeMods])];

            emitKeyboardEvent({
                modifiers: modifiers,
                shortcut: key,
                type: "shortcut",
            });
        });
    });

    // 2. Text Input Handling
    const textInput = document.getElementById("textInput") as HTMLTextAreaElement | null;
    const sendTextButton = document.getElementById("sendText") as HTMLButtonElement | null;

    if (sendTextButton && textInput) {
        const sendText = () => {
            const text = textInput.value;
            if (text) {
                emitKeyboardEvent({ text: text, type: "text" });
                textInput.value = "";

                // Visual feedback on button
                const originalText = sendTextButton.textContent;
                sendTextButton.textContent = "SENT >>";
                sendTextButton.classList.remove("text-zinc-100", "border-transparent");
                sendTextButton.classList.add("text-emerald-400", "border-emerald-500");
                sendTextButton.blur();
                setTimeout(() => {
                    sendTextButton.textContent = originalText;
                    sendTextButton.classList.remove("text-emerald-400", "border-emerald-500");
                    sendTextButton.classList.add("text-zinc-100", "border-transparent");
                }, 500);
            }
        };

        sendTextButton.addEventListener("click", sendText);

        textInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && e.ctrlKey) {
                e.preventDefault();
                sendText();
            }
        });
    }

    // 3. Custom Shortcut Builder & Modifier Toggles
    const customKeyInput = document.getElementById("customKey") as HTMLInputElement | null;
    const sendCustomButton = document.getElementById("sendCustomShortcut") as HTMLButtonElement | null;
    const modifierButtons = document.querySelectorAll<HTMLElement>(".modifier-btn");
    const stickyToggle = document.getElementById("stickyToggle") as HTMLInputElement | null;

    // Toggle logic / immediate emittance logic for modifier buttons
    modifierButtons.forEach((button) => {
        button.addEventListener("click", () => {
            const isSticky = stickyToggle && stickyToggle.checked;

            if (isSticky) {
                // Sticky Mode is ON: Toggle held state
                const isActive = button.dataset.active === "true";
                button.dataset.active = String(!isActive);

                const led = button.querySelector(".mod-led");
                if (led) {
                    led.classList.toggle("bg-zinc-700/50", isActive);
                    led.classList.toggle("bg-zinc-100", !isActive);
                    led.classList.toggle("shadow-[0_0_5px_rgba(244,244,245,0.8)]", !isActive);
                }
            } else {
                // Sticky Mode is OFF: Transmit key immediately
                emitKeyboardEvent({
                    modifiers: [],
                    shortcut: button.dataset.modifier!,
                    type: "shortcut",
                });

                // Normal click animation
                button.classList.remove(
                    "bg-zinc-950",
                    "text-zinc-300",
                    "border-zinc-800",
                    "hover:bg-zinc-800",
                    "hover:text-white",
                );
                button.classList.add("bg-zinc-100", "text-zinc-900", "border-zinc-100");
                button.blur();
                setTimeout(() => {
                    button.classList.remove("bg-zinc-100", "text-zinc-900", "border-zinc-100");
                    button.classList.add(
                        "bg-zinc-950",
                        "text-zinc-300",
                        "border-zinc-800",
                        "hover:bg-zinc-800",
                        "hover:text-white",
                    );
                }, 80);
            }
        });
    });

    // Handle Sticky Toggle Switch Changes
    if (stickyToggle) {
        stickyToggle.addEventListener("change", (e) => {
            const isSticky = (e.target as HTMLInputElement).checked;

            // Show/Hide LED indicators
            document.querySelectorAll(".mod-led").forEach((led) => {
                led.classList.toggle("hidden", !isSticky);
            });

            // Reset active states if Sticky Mode is disabled
            if (!isSticky) {
                modifierButtons.forEach((btn) => {
                    delete btn.dataset.active;
                    const led = btn.querySelector(".mod-led");
                    if (led) {
                        led.className =
                            "mod-led w-1.5 h-1.5 rounded-full bg-zinc-700/50 transition-all duration-150 hidden";
                    }
                });
            }
        });
    }

    if (sendCustomButton && customKeyInput) {
        sendCustomButton.addEventListener("click", () => {
            let key = customKeyInput.value.toLowerCase().trim();
            const activeModifiers = getActiveModifiers();

            const parsed = parseShortcutInput(key);
            key = parsed.key;
            activeModifiers.push(...parsed.modifiers);

            if (key.length > 0 || activeModifiers.length > 0) {
                emitKeyboardEvent({
                    modifiers: activeModifiers,
                    shortcut: key,
                    type: "shortcut",
                });

                customKeyInput.value = "";

                // Visual feedback
                sendCustomButton.classList.remove("bg-zinc-800", "text-zinc-100", "hover:bg-zinc-700");
                sendCustomButton.classList.add("bg-zinc-100", "text-zinc-900");
                sendCustomButton.blur();
                setTimeout(() => {
                    sendCustomButton.classList.remove("bg-zinc-100", "text-zinc-900");
                    sendCustomButton.classList.add("bg-zinc-800", "text-zinc-100", "hover:bg-zinc-700");
                }, 80);
            }
        });
    }

    // 4. Global key capture forwarding
    const heldKeys = new Set<string>();

    document.addEventListener(
        "keydown",
        (event) => {
            if (captureState.keyboard) {
                const target = event.target as HTMLElement;
                if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;

                event.preventDefault();
                event.stopPropagation();

                if (event.repeat) return;

                const rawKey = event.key;
                const key = KEY_MAP[rawKey] ?? rawKey.toLowerCase();

                heldKeys.add(key);
                emitKeyboardEvent({ key, type: "keyDown" });
            }
        },
        { capture: true },
    );

    document.addEventListener(
        "keyup",
        (event) => {
            if (captureState.keyboard) {
                const target = event.target as HTMLElement;
                if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;

                event.preventDefault();
                event.stopPropagation();

                const rawKey = event.key;
                const key = KEY_MAP[rawKey] ?? rawKey.toLowerCase();

                heldKeys.delete(key);
                emitKeyboardEvent({ key, type: "keyUp" });
            }
        },
        { capture: true },
    );

    window.addEventListener("blur", () => {
        heldKeys.forEach((key) => {
            emitKeyboardEvent({ key, type: "keyUp" });
        });
        heldKeys.clear();
    });
}
