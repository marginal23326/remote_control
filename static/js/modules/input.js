// static/js/modules/input.js
import { streamUI, streamActive, calculateStreamDimensions, sendMouseEventOverDataChannel } from "./stream.js";

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

function initializeInputHandlers(socket) {
    // 1. Helper to send keyboard events
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

    // 2. Handle Standard Shortcut Buttons (Grid buttons like "Copy", "Up", "Esc")
    document.querySelectorAll("[data-key]").forEach((button) => {
        button.addEventListener("click", (_e) => {
            // Add a visual click effect for the HUD aesthetic
            button.classList.add("bg-blue-600", "text-white", "border-blue-500");
            setTimeout(() => {
                button.classList.remove("bg-blue-600", "text-white", "border-blue-500");
            }, 150);

            const rawKey = button.dataset.key;
            let key = rawKey;
            let modifiers = [];

            // Case A: Abstract command (e.g., "copy")
            if (SHORTCUT_MAP[rawKey]) {
                key = SHORTCUT_MAP[rawKey].key;
                modifiers = [...SHORTCUT_MAP[rawKey].modifiers];
            }
            // Case B: Combined keys (e.g., "alt+tab", "win+d")
            else if (rawKey.includes("+")) {
                const parts = rawKey.split("+");
                key = parts.pop(); // The last part is the main key
                modifiers = parts; // The rest are modifiers
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

    // 3. Text Input Handling
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
                sendTextButton.classList.add("text-green-400", "border-green-500");
                setTimeout(() => {
                    sendTextButton.innerText = originalText;
                    sendTextButton.classList.remove("text-green-400", "border-green-500");
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

    // 4. Custom Shortcut Builder & Modifier Toggles
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
                    led.classList.toggle("bg-gray-700/50", isActive);
                    led.classList.toggle("bg-blue-400", !isActive);
                    led.classList.toggle("shadow-[0_0_5px_rgba(96,165,250,0.8)]", !isActive);
                }
            } else {
                // Sticky Mode is OFF: Transmit key immediately
                emitKeyboardEvent("shortcut", {
                    shortcut: button.dataset.modifier,
                    modifiers: [],
                });

                // Normal click animation
                button.classList.add("bg-blue-600", "text-white", "border-blue-500");
                setTimeout(() => {
                    button.classList.remove("bg-blue-600", "text-white", "border-blue-500");
                }, 150);
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
                            "mod-led w-1.5 h-1.5 rounded-full bg-gray-700/50 transition-all duration-150 hidden";
                    }
                });
            }
        });
    }

    if (sendCustomButton && customKeyInput) {
        sendCustomButton.addEventListener("click", () => {
            const key = customKeyInput.value.toLowerCase().trim();
            const activeModifiers = getActiveModifiers();

            if (key.length > 0 || activeModifiers.length > 0) {
                emitKeyboardEvent("shortcut", {
                    shortcut: key,
                    modifiers: activeModifiers,
                });

                customKeyInput.value = "";

                // Visual feedback
                sendCustomButton.classList.add("bg-blue-500", "text-white");
                setTimeout(() => sendCustomButton.classList.remove("bg-blue-500", "text-white"), 200);
            }
        });
    }

    // 5. Mouse Event Handlers
    let touchStarted = false;
    let isCtrlPressed = false;
    let initialTouchY = null;
    let isScrolling = false;
    let isDragging = false;

    document.addEventListener("keydown", (event) => {
        if (event.key === "Control") isCtrlPressed = true;
    });

    document.addEventListener("keyup", (event) => {
        if (event.key === "Control") isCtrlPressed = false;
    });

    window.addEventListener("blur", () => {
        isCtrlPressed = false;
        isDragging = false;
    });

    if (streamUI.view) {
        streamUI.view.addEventListener("dragstart", (event) => event.preventDefault());

        streamUI.view.addEventListener("wheel", (event) => {
            event.preventDefault();
            sendMouseEvent("scroll", event, { dx: 0, dy: -Math.sign(event.deltaY) });
        });

        streamUI.view.addEventListener("touchstart", (event) => {
            event.preventDefault();
            if (event.touches.length === 2) {
                if (touchStarted) {
                    touchStarted = false;
                    sendMouseEvent("click", event.touches[0], { button: "left", pressed: false });
                }
                isScrolling = true;
                initialTouchY = event.touches[1].clientY;
                return;
            }

            if (event.touches.length === 1 && !isScrolling) {
                touchStarted = true;
                sendMouseEvent("click", event.touches[0], { button: "left", pressed: true });
            }
        });

        streamUI.view.addEventListener("touchmove", (event) => {
            event.preventDefault();
            if (event.touches.length === 2 && isScrolling && initialTouchY !== null) {
                const currentTouchY = event.touches[1].clientY;
                const deltaY = initialTouchY - currentTouchY;
                if (Math.abs(deltaY) > 5) {
                    sendMouseEvent("scroll", event.touches[0], { dx: 0, dy: -Math.sign(deltaY) });
                    initialTouchY = currentTouchY;
                }
                return;
            }

            if (event.touches.length === 1 && touchStarted && !isScrolling) {
                sendMouseEvent("move", event.touches[0]);
            }
        });

        streamUI.view.addEventListener("touchend", (event) => {
            event.preventDefault();
            if (event.touches.length === 0) {
                isScrolling = false;
                initialTouchY = null;
            }
            if (touchStarted && event.touches.length === 0) {
                touchStarted = false;
                sendMouseEvent("click", event.changedTouches[0], { button: "left", pressed: false });
            }
        });

        streamUI.view.addEventListener("touchcancel", (event) => {
            event.preventDefault();
            isScrolling = false;
            initialTouchY = null;
            if (touchStarted) {
                touchStarted = false;
                sendMouseEvent("click", event.changedTouches[0], { button: "left", pressed: false });
            }
        });

        streamUI.view.addEventListener("mousemove", (event) => {
            event.preventDefault();
            if (isDragging || isCtrlPressed) {
                sendMouseEvent("move", event);
            }
        });

        streamUI.view.addEventListener("mousedown", (event) => {
            event.preventDefault();
            const button = event.button === 0 ? "left" : event.button === 2 ? "right" : "middle";
            sendMouseEvent("click", event, { button, pressed: true });
            if (button === "left") isDragging = true;
        });

        window.addEventListener("mouseup", (event) => {
            if (isDragging || event.target === streamUI.view) {
                if (event.target === streamUI.view) {
                    event.preventDefault();
                }
                const button = event.button === 0 ? "left" : event.button === 2 ? "right" : "middle";
                sendMouseEvent("click", event, { button, pressed: false });
                if (button === "left") isDragging = false;
            }
        });

        streamUI.view.addEventListener("contextmenu", (event) => event.preventDefault());
    }

    function sendMouseEvent(type, event, options = {}) {
        if (!streamActive) return;
        const clientX = event.clientX;
        const clientY = event.clientY;
        const dimensions = calculateStreamDimensions();
        const relativeX = clientX - dimensions.container.left - dimensions.offsetX;
        const relativeY = clientY - dimensions.container.top - dimensions.offsetY;
        const x = Math.max(0, Math.min(dimensions.nativeWidth, relativeX * dimensions.scaleX));
        const y = Math.max(0, Math.min(dimensions.nativeHeight, relativeY * dimensions.scaleY));

        const data = { type, x, y, ...options };
        if (!sendMouseEventOverDataChannel(data)) {
            socket.emit("mouse_event", data);
        }
    }
}

export { initializeInputHandlers };
