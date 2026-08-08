import { streamUI } from "@/features/stream/view";
import { streamState } from "@/features/stream/stream-state";
import { calculateStreamDimensions } from "@/features/stream/geometry";
import { sendMouseEventOverDataChannel } from "@/features/stream/peer-connection";
import { captureState } from "./capture-state";
import type { AppSocket } from "@/core/socket";
import type { MouseEventPayload } from "@/core/socket-events";

function mouseButtonName(button: number): "left" | "right" | "middle" {
    return button === 0 ? "left" : button === 2 ? "right" : "middle";
}

function mouseCoords(event: { clientX: number; clientY: number }): { x: number; y: number } {
    const dimensions = calculateStreamDimensions();
    const relativeX = event.clientX - dimensions.container.left - dimensions.offsetX;
    const relativeY = event.clientY - dimensions.container.top - dimensions.offsetY;
    return {
        x: Math.max(0, Math.min(dimensions.nativeWidth, relativeX * dimensions.scaleX)),
        y: Math.max(0, Math.min(dimensions.nativeHeight, relativeY * dimensions.scaleY)),
    };
}

export function initializePointerInput(socket: AppSocket): void {
    let touchStarted = false;
    let initialTouchY: number | null = null;
    let isScrolling = false;
    let isDragging = false;

    function sendPayload(payload: MouseEventPayload): void {
        if (!streamState.active) return;
        if (!sendMouseEventOverDataChannel(payload)) {
            socket.emit("mouse_event", payload);
        }
    }

    function releaseTouch(event: TouchEvent): void {
        if (touchStarted) {
            touchStarted = false;
            sendPayload({ type: "click", ...mouseCoords(event.changedTouches[0]!), button: "left", pressed: false });
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
        sendPayload({ type: "scroll", dx: Math.sign(event.deltaX), dy: Math.sign(event.deltaY) });
    });

    streamUI.view.addEventListener("touchstart", (event) => {
        event.preventDefault();
        if (event.touches.length === 2) {
            if (touchStarted) {
                touchStarted = false;
                sendPayload({ type: "click", ...mouseCoords(event.touches[0]!), button: "left", pressed: false });
            }
            isScrolling = true;
            initialTouchY = event.touches[1]!.clientY;
            return;
        }

        if (event.touches.length === 1 && !isScrolling) {
            touchStarted = true;
            sendPayload({ type: "click", ...mouseCoords(event.touches[0]!), button: "left", pressed: true });
        }
    });

    streamUI.view.addEventListener("touchmove", (event) => {
        event.preventDefault();
        if (event.touches.length === 2 && isScrolling && initialTouchY !== null) {
            const currentTouchY = event.touches[1]!.clientY;
            const deltaY = initialTouchY - currentTouchY;
            if (Math.abs(deltaY) > 5) {
                sendPayload({ type: "scroll", dx: 0, dy: Math.sign(deltaY) });
                initialTouchY = currentTouchY;
            }
            return;
        }

        if (event.touches.length === 1 && touchStarted && !isScrolling) {
            sendPayload({ type: "move", ...mouseCoords(event.touches[0]!) });
        }
    });

    streamUI.view.addEventListener("touchend", (event) => {
        event.preventDefault();
        if (event.touches.length === 0) {
            isScrolling = false;
            initialTouchY = null;
            releaseTouch(event);
        }
    });

    streamUI.view.addEventListener("touchcancel", (event) => {
        event.preventDefault();
        isScrolling = false;
        initialTouchY = null;
        releaseTouch(event);
    });

    streamUI.view.addEventListener("mousemove", (event) => {
        event.preventDefault();
        if (isDragging || captureState.mouse) {
            sendPayload({ type: "move", ...mouseCoords(event) });
        }
    });

    streamUI.view.addEventListener("mousedown", (event) => {
        event.preventDefault();
        const button = mouseButtonName(event.button);
        sendPayload({ type: "click", ...mouseCoords(event), button, pressed: true });
        if (button === "left") isDragging = true;
    });

    window.addEventListener("mouseup", (event) => {
        if (isDragging || event.target === streamUI.view) {
            if (event.target === streamUI.view) {
                event.preventDefault();
            }
            const button = mouseButtonName(event.button);
            sendPayload({ type: "click", ...mouseCoords(event), button, pressed: false });
            if (button === "left") isDragging = false;
        }
    });

    streamUI.view.addEventListener("contextmenu", (event) => {
        event.preventDefault();
    });
}
