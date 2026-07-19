import type { AppSocket } from "@/core/socket";

export function bindMediaSessionReconnect(
    socket: AppSocket,
    hooks: {
        isActive: () => boolean;
        onDisconnect: () => void;
        onReconnect: () => void;
    },
): void {
    let wasActiveBeforeDisconnect = false;

    socket.on("disconnect", () => {
        if (!hooks.isActive()) return;
        wasActiveBeforeDisconnect = true;
        hooks.onDisconnect();
    });

    socket.on("connect", () => {
        if (!wasActiveBeforeDisconnect) return;
        wasActiveBeforeDisconnect = false;
        hooks.onReconnect();
    });
}
