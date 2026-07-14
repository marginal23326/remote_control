import { captureState } from "./capture-state.js";

// Mapping for abstract action names to actual keys
const SHORTCUT_MAP = {
    copy: { key: "c", modifiers: ["ctrl"] },
    paste: { key: "v", modifiers: ["ctrl"] },
    cut: { key: "x", modifiers: ["ctrl"] },
    undo: { key: "z", modifiers: ["ctrl"] },
    redo: { key: "y", modifiers: ["ctrl"] },
    save: { key: "s", modifiers: ["ctrl"] },
    selectall: { key: "a", modifiers: ["ctrl"] },
};

const KEY_MAP = {
    " ": "space",
    ArrowUp: "up",
    ArrowDown: "down",
    ArrowLeft: "left",
    ArrowRight: "right",
    PageUp: "pageup",
    PageDown: "pagedown",
    OS: "win",
    Control: "ctrl",
    Shift: "shift",
    Alt: "alt",
    Meta: "win",
    Enter: "enter",
    Backspace: "backspace",
    Tab: "tab",
    Escape: "esc",
    Delete: "delete",
    Insert: "insert",
    Home: "home",
    End: "end",
};

function parseShortcutInput(input) {
    if (input.includes("+")) {
        const parts = input.split("+");
        return { key: parts.pop(), modifiers: parts };
    }
    return { key: input, modifiers: [] };
}

function initializeKeyboardShortcuts(socket) {
    function emitKeyboardEvent(type, payload) {
        socket.emit("keyboard_event", {
            type: type,
            ...payload,
        });
    }

    // Helper to collect currently active modifiers if sticky mode is enabled
    function getActiveModifiers() {
        const stickyToggle = document.getElementById("stickyToggle");
        if (stickyToggle && !stickyToggle.checked) {
            return [];
        }
        return Array.from(document.querySelectorAll(".modifier-btn"))
            .filter((btn) => btn.getAttribute("data-active") === "true")
            .map((btn) => btn.dataset.modifier);
    }

    // 1. Handle Standard Shortcut Buttons
    document.querySelectorAll("[data-key]").forEach((button) => {
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

            const rawKey = button.dataset.key;
            let key = rawKey;
            let modifiers = [];

            // Case A: Abstract command (e.g., "copy")
            if (SHORTCUT_MAP[rawKey]) {
                key = SHORTCUT_MAP[rawKey].key;
                modifiers = [...SHORTCUT_MAP[rawKey].modifiers];
            }
            // Case B: Combined keys (e.g., "alt+tab", "win+d")
            else {
                const parsed = parseShortcutInput(rawKey);
                key = parsed.key;
                modifiers = parsed.modifiers;
            }

            // Merge default key modifiers with globally active sticky modifiers
            const activeMods = getActiveModifiers();
            modifiers = Array.from(new Set([...modifiers, ...activeMods]));

            emitKeyboardEvent("shortcut", {
                shortcut: key,
                modifiers: modifiers,
            });
        });
    });

    // 2. Text Input Handling
    const textInput = document.getElementById("textInput");
    const sendTextButton = document.getElementById("sendText");

    if (sendTextButton && textInput) {
        const sendText = () => {
            const text = textInput.value;
            if (text) {
                emitKeyboardEvent("text", { text: text });
                textInput.value = "";

                // Visual feedback on button
                const originalText = sendTextButton.innerText;
                sendTextButton.innerText = "SENT >>";
                sendTextButton.classList.remove("text-zinc-100", "border-transparent");
                sendTextButton.classList.add("text-emerald-400", "border-emerald-500");
                sendTextButton.blur();
                setTimeout(() => {
                    sendTextButton.innerText = originalText;
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
    const customKeyInput = document.getElementById("customKey");
    const sendCustomButton = document.getElementById("sendCustomShortcut");
    const modifierButtons = document.querySelectorAll(".modifier-btn");
    const stickyToggle = document.getElementById("stickyToggle");

    // Toggle logic / immediate emittance logic for modifier buttons
    modifierButtons.forEach((button) => {
        button.addEventListener("click", () => {
            const isSticky = stickyToggle && stickyToggle.checked;

            if (isSticky) {
                // Sticky Mode is ON: Toggle held state
                const isActive = button.getAttribute("data-active") === "true";
                button.setAttribute("data-active", !isActive);

                const led = button.querySelector(".mod-led");
                if (led) {
                    led.classList.toggle("bg-zinc-700/50", isActive);
                    led.classList.toggle("bg-zinc-100", !isActive);
                    led.classList.toggle("shadow-[0_0_5px_rgba(244,244,245,0.8)]", !isActive);
                }
            } else {
                // Sticky Mode is OFF: Transmit key immediately
                emitKeyboardEvent("shortcut", {
                    shortcut: button.dataset.modifier,
                    modifiers: [],
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
            const isSticky = e.target.checked;

            // Show/Hide LED indicators
            document.querySelectorAll(".mod-led").forEach((led) => {
                led.classList.toggle("hidden", !isSticky);
            });

            // Reset active states if Sticky Mode is disabled
            if (!isSticky) {
                modifierButtons.forEach((btn) => {
                    btn.removeAttribute("data-active");
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
                emitKeyboardEvent("shortcut", {
                    shortcut: key,
                    modifiers: activeModifiers,
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
    const heldKeys = new Set();

    document.addEventListener(
        "keydown",
        (event) => {
            if (captureState.keyboard) {
                if (event.target.tagName === "INPUT" || event.target.tagName === "TEXTAREA") return;

                event.preventDefault();
                event.stopPropagation();

                if (event.repeat) return;

                let rawKey = event.key;
                let key = KEY_MAP[rawKey] || rawKey.toLowerCase();

                heldKeys.add(key);
                emitKeyboardEvent("keyDown", { key });
            }
        },
        { capture: true },
    );

    document.addEventListener(
        "keyup",
        (event) => {
            if (captureState.keyboard) {
                if (event.target.tagName === "INPUT" || event.target.tagName === "TEXTAREA") return;

                event.preventDefault();
                event.stopPropagation();

                let rawKey = event.key;
                let key = KEY_MAP[rawKey] || rawKey.toLowerCase();

                heldKeys.delete(key);
                emitKeyboardEvent("keyUp", { key });
            }
        },
        { capture: true },
    );

    window.addEventListener("blur", () => {
        heldKeys.forEach((key) => emitKeyboardEvent("keyUp", { key }));
        heldKeys.clear();
    });
}

export { initializeKeyboardShortcuts };
