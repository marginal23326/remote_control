import { io } from "socket.io-client";
import { showConnectionOverlay, hideConnectionOverlay } from "@/shared/feedback.js";

function initializeSocketIO(authCallback) {
    const socket = io();

    socket.on("connect", () => {
        console.log("Socket connected!");
        hideConnectionOverlay();
    });

    socket.on("disconnect", (reason) => {
        console.log("Socket disconnected:", reason);
        if (reason !== "io client disconnect") {
            showConnectionOverlay("Disconnected. Reconnecting...");
        }
    });

    socket.io.on("reconnect_attempt", (attempt) => {
        showConnectionOverlay(`Reconnecting... Attempt ${attempt}`);
    });

    socket.io.on("reconnect", () => {
        hideConnectionOverlay();
    });

    socket.on("connect_error", (error) => {
        console.error("Socket connection error:", error);
    });

    socket.on("auth_status", (data) => {
        authCallback(data.authenticated);
    });

    socket.on("auth_error", () => {
        authCallback(false);
    });

    return socket;
}

export { initializeSocketIO };
