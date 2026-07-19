import { streamUI } from "@/features/stream/view";
import { streamActive } from "@/features/stream/stream-state";
import { calculateStreamDimensions } from "@/features/stream/geometry";
import { sendMouseEventOverDataChannel } from "@/features/stream/peer-connection";
import { captureState } from "./capture-state";
import type { AppSocket } from "@/core/socket";
import type { MouseEventPayload } from "@/core/socket-events";

function mouseButtonName(button: number): "left" | "right" | "middle" {
    return button === 0 ? "left" : button === 2 ? "right" : "middle";
}

export function initializePointerInput(socket: AppSocket): void {
    let touchStarted = false;
    let initialTouchY: number | null = null;
    let isScrolling = false;
    let isDragging = false;

    function sendMouseEvent(
        type: MouseEventPayload["type"],
        event: { clientX: number; clientY: number },
        options: Partial<MouseEventPayload> = {},
    ): void {
        if (!streamActive) return;
        const { clientX } = event;
        const { clientY } = event;
        const dimensions = calculateStreamDimensions();
        const relativeX = clientX - dimensions.container.left - dimensions.offsetX;
        const relativeY = clientY - dimensions.container.top - dimensions.offsetY;
        const x = Math.max(0, Math.min(dimensions.nativeWidth, relativeX * dimensions.scaleX));
        const y = Math.max(0, Math.min(dimensions.nativeHeight, relativeY * dimensions.scaleY));

        const data: MouseEventPayload = { type, x, y, ...options };
        if (!sendMouseEventOverDataChannel(data)) {
            socket.emit("mouse_event", data);
        }
    }

    window.addEventListener("blur", () => {
        isDragging = false;
    });

    if (!streamUI.view) return;

    streamUI.view.addEventListener("dragstart", (event) => {
        event.preventDefault();
    });

    streamUI.view.addEventListener("wheel", (event) => {
        event.preventDefault();
        sendMouseEvent("scroll", event, { dx: Math.sign(event.deltaX), dy: Math.sign(event.deltaY) });
    });

    streamUI.view.addEventListener("touchstart", (event) => {
        event.preventDefault();
        if (event.touches.length === 2) {
            if (touchStarted) {
                touchStarted = false;
                sendMouseEvent("click", event.touches[0]!, { button: "left", pressed: false });
            }
            isScrolling = true;
            initialTouchY = event.touches[1]!.clientY;
            return;
        }

        if (event.touches.length === 1 && !isScrolling) {
            touchStarted = true;
            sendMouseEvent("click", event.touches[0]!, { button: "left", pressed: true });
        }
    });

    streamUI.view.addEventListener("touchmove", (event) => {
        event.preventDefault();
        if (event.touches.length === 2 && isScrolling && initialTouchY !== null) {
            const currentTouchY = event.touches[1]!.clientY;
            const deltaY = initialTouchY - currentTouchY;
            if (Math.abs(deltaY) > 5) {
                sendMouseEvent("scroll", event.touches[0]!, { dx: 0, dy: Math.sign(deltaY) });
                initialTouchY = currentTouchY;
            }
            return;
        }

        if (event.touches.length === 1 && touchStarted && !isScrolling) {
            sendMouseEvent("move", event.touches[0]!);
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
            sendMouseEvent("click", event.changedTouches[0]!, { button: "left", pressed: false });
        }
    });

    streamUI.view.addEventListener("touchcancel", (event) => {
        event.preventDefault();
        isScrolling = false;
        initialTouchY = null;
        if (touchStarted) {
            touchStarted = false;
            sendMouseEvent("click", event.changedTouches[0]!, { button: "left", pressed: false });
        }
    });

    streamUI.view.addEventListener("mousemove", (event) => {
        event.preventDefault();
        if (isDragging || captureState.mouse) {
            sendMouseEvent("move", event);
        }
    });

    streamUI.view.addEventListener("mousedown", (event) => {
        event.preventDefault();
        const button = mouseButtonName(event.button);
        sendMouseEvent("click", event, { button, pressed: true });
        if (button === "left") isDragging = true;
    });

    window.addEventListener("mouseup", (event) => {
        if (isDragging || event.target === streamUI.view) {
            if (event.target === streamUI.view) {
                event.preventDefault();
            }
            const button = mouseButtonName(event.button);
            sendMouseEvent("click", event, { button, pressed: false });
            if (button === "left") isDragging = false;
        }
    });

    streamUI.view.addEventListener("contextmenu", (event) => {
        event.preventDefault();
    });
}
