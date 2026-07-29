import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { SVG_TEMPLATES } from "@/shared/icons";
import { byId } from "@/shared/dom-helpers";
import { bindMediaSessionReconnect } from "@/shared/media-session";
import type { AppSocket } from "@/core/socket";

const SHELL_LABELS: Record<string, string> = {
    bash: "Bash",
    "bash.exe": "Git Bash",
    "cmd.exe": "Command Prompt",
    dash: "Dash",
    fish: "Fish",
    ksh: "Ksh",
    "powershell.exe": "Windows PowerShell",
    "pwsh.exe": "PowerShell",
    sh: "sh",
    zsh: "Zsh",
};

let sessionId: string | null = null;
let isStarted = false;
let terminal: Terminal;
let fitAddon: FitAddon;
let shellTypeSelect: HTMLSelectElement | null = null;
let startButton: HTMLElement;
let restartButton: HTMLElement;
let stopButton: HTMLElement;

function toggleTextMode(): void {
    const overlay = byId("shellTextOverlay");
    const content = byId("shellTextContent");

    if (overlay && content) {
        overlay.classList.remove("hidden");
        content.textContent = getAllTerminalContent();
    }
}

function closeTextMode(): void {
    const overlay = byId("shellTextOverlay");
    if (overlay) {
        overlay.classList.add("hidden");
    }
}

function getAllTerminalContent(): string {
    let content = "";
    for (let i = 0; i < terminal.buffer.active.length; i++) {
        const line = terminal.buffer.active.getLine(i);
        if (line) {
            content += `${line.translateToString()}\n`;
        }
    }
    return content;
}

function initializeTerminal(socket: AppSocket): void {
    const terminalElement = byId("terminalContainer")!;

    // Open terminal
    terminal.open(terminalElement);

    // Initial fit
    setTimeout(() => {
        fitAddon.fit();
        updateTerminalSize(socket);
    }, 100);

    // Resize handling (debounced)
    let resizeTimeout: ReturnType<typeof setTimeout>;
    const handleResize = () => {
        if (isStarted) {
            clearTimeout(resizeTimeout);
            resizeTimeout = setTimeout(() => {
                fitAddon.fit();
                updateTerminalSize(socket);
            }, 150);
        }
    };

    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(terminalElement);
    window.addEventListener("resize", handleResize);

    // Font size adjustment with Ctrl+Wheel
    terminalElement.addEventListener("wheel", (e) => {
        if (isStarted && e.ctrlKey) {
            e.preventDefault();
            adjustFontSize(socket, e.deltaY < 0 ? 1 : -1);
        }
    });

    // Style adjustments
    const xtermElement = terminalElement.querySelector<HTMLElement>(".xterm");
    if (xtermElement) {
        xtermElement.style.padding = "12px";
        xtermElement.style.height = "100%";
    }
}

function adjustFontSize(socket: AppSocket, delta: number): void {
    if (!isStarted) return;

    const currentFontSize = terminal.options.fontSize!;
    const minFontSize = 8;
    const maxFontSize = 32;
    const newSize = Math.max(minFontSize, Math.min(maxFontSize, currentFontSize + delta));

    if (newSize !== currentFontSize) {
        terminal.options.fontSize = newSize;
        fitAddon.fit();
        updateTerminalSize(socket);
    }
}

function setupEventHandlers(socket: AppSocket): void {
    startButton = byId("startShellBtn")!;
    restartButton = byId("restartShellBtn")!;
    stopButton = byId("stopShellBtn")!;
    const terminalContainer = byId("terminalContainer")!;
    const textModeBtn = byId("shellTextModeBtn");
    const closeTextBtn = byId("shellCloseTextBtn");
    shellTypeSelect = byId<HTMLSelectElement>("shellTypeSelect");

    if (textModeBtn) {
        textModeBtn.addEventListener("click", () => {
            toggleTextMode();
        });
    }

    if (closeTextBtn) {
        closeTextBtn.innerHTML = SVG_TEMPLATES.cross();
        closeTextBtn.addEventListener("click", () => {
            closeTextMode();
        });
    }

    // --- Start Shell ---
    startButton.addEventListener("click", () => {
        if (!isStarted) {
            createShellSession(socket);
            // UI updates happen after we receive 'shell_created' event
            terminalContainer.style.opacity = "1";
        }
    });

    restartButton.addEventListener("click", (e) => {
        const btn = e.currentTarget as HTMLButtonElement;
        btn.disabled = true;
        btn.classList.add("opacity-50", "cursor-not-allowed");

        restartShell(socket);

        setTimeout(() => {
            btn.disabled = false;
            btn.classList.remove("opacity-50", "cursor-not-allowed");
        }, 1500);
    });

    stopButton.addEventListener("click", () => {
        stopShell(socket);
    });

    // --- Socket Events ---

    socket.on("available_shells", (data) => {
        populateShellOptions(data.shells || [], data.default);
    });

    // 1. Success: Shell Created
    socket.on("shell_created", (data) => {
        if (data.status === "success") {
            isStarted = true;
            sessionId = data.session_id;

            startButton.classList.add("hidden");
            restartButton.classList.remove("hidden");
            stopButton.classList.remove("hidden");
            if (shellTypeSelect) shellTypeSelect.disabled = true;

            fitAddon.fit();
            updateTerminalSize(socket);
            terminal.focus();
        }
    });

    // 2. Error: Shell Creation Failed
    socket.on("shell_error", (data) => {
        terminal.writeln(`\r\n\u001B[31mError: ${data.message}\u001B[0m`);
        resetToIdle();
    });

    // 2b. Session Ended
    socket.on("shell_closed", (data) => {
        if (sessionId && data.session_id === sessionId) {
            resetToIdle();
        }
    });

    // --- Handle Network Drops ---
    socket.on("connect", () => {
        requestAvailableShells(socket);
    });

    bindMediaSessionReconnect(socket, {
        isActive: () => isStarted,
        onDisconnect: () => {
            isStarted = false;
            sessionId = null;

            terminal.writeln("\r\n\u001B[33m[Connection lost]\u001B[0m\r\n");
            if (shellTypeSelect) shellTypeSelect.disabled = false;
        },
        onReconnect: () => {
            terminal.writeln("\r\n\u001B[32m[Reconnected]\u001B[0m\r\n");
            createShellSession(socket);
        },
    });

    // 3. Data: Output from Server (Pushed instantly)
    socket.on("shell_output", (data) => {
        // Check if this output belongs to our current session
        if (sessionId && data.session_id === sessionId) {
            terminal.write(data.output);
        }
    });

    // --- Terminal Input ---
    terminal.onData((data) => {
        if (sessionId && isStarted) {
            socket.emit("shell_input", {
                command: data,
            });
        }
    });

    terminal.attachCustomKeyEventHandler((event) => {
        if (event.type !== "keydown") return true;

        // Clipboard handled natively by xterm via DOM events on the hidden textarea.
        if (event.ctrlKey && ((event.key === "c" && terminal.hasSelection()) || event.key === "v")) {
            if (event.key === "c") {
                setTimeout(() => {
                    terminal.clearSelection();
                }, 0);
            }
            return false;
        }

        if (event.ctrlKey && (event.key === "+" || event.key === "=")) {
            event.preventDefault();
            adjustFontSize(socket, 1);
            return false;
        } else if (event.ctrlKey && event.key === "-") {
            event.preventDefault();
            adjustFontSize(socket, -1);
            return false;
        }

        return true;
    });

    terminalContainer.addEventListener("contextmenu", (e) => {
        if (!isStarted) return;
        e.preventDefault();

        if (terminal.hasSelection()) {
            void navigator.clipboard.writeText(terminal.getSelection());
            terminal.clearSelection();
        } else {
            void navigator.clipboard.readText().then((text) => {
                if (text && isStarted) {
                    terminal.paste(text);
                }
            });
        }
    });
}

function restartShell(socket: AppSocket): void {
    if (!isStarted) return;
    sessionId = null;
    terminal.reset();
    if (shellTypeSelect) shellTypeSelect.disabled = false;
    createShellSession(socket);
}

function stopShell(socket: AppSocket): void {
    if (!isStarted) return;
    socket.emit("shell_close");
}

function resetToIdle(): void {
    isStarted = false;
    sessionId = null;
    startButton.classList.remove("hidden");
    restartButton.classList.add("hidden");
    stopButton.classList.add("hidden");
    if (shellTypeSelect) shellTypeSelect.disabled = false;
}

function requestAvailableShells(socket: AppSocket): void {
    socket.emit("list_shells");
}

function populateShellOptions(shells: string[], defaultShell?: string): void {
    if (!shellTypeSelect) return;

    const previous = shellTypeSelect.value;
    shellTypeSelect.replaceChildren();

    shells.forEach((shell) => {
        const option = document.createElement("option");
        option.value = shell;
        option.textContent = SHELL_LABELS[shell] ?? shell;
        shellTypeSelect!.append(option);
    });

    if (shells.includes(previous)) {
        shellTypeSelect.value = previous;
    } else if (defaultShell) {
        shellTypeSelect.value = defaultShell;
    }
}

function createShellSession(socket: AppSocket): void {
    const { cols, rows } = terminal;
    sessionId = Math.random().toString(36).slice(2);
    const shell = shellTypeSelect && shellTypeSelect.value ? shellTypeSelect.value : undefined;
    socket.emit("shell_create", { cols, rows, session_id: sessionId, shell });
}

function updateTerminalSize(socket: AppSocket): void {
    if (sessionId && isStarted) {
        const { cols, rows } = terminal;
        socket.emit("shell_resize", {
            cols,
            rows,
        });
    }
}

export function initializeShell(socket: AppSocket): void {
    terminal = new Terminal({
        cursorBlink: true,
        cursorInactiveStyle: "none",
        cursorStyle: "bar",
        fontFamily: "'MesloLGM Nerd Font', Consolas, monospace",
        scrollback: 10000,
        theme: {
            // zinc-950
            background: "#09090b",
            // zinc-100
            foreground: "#f4f4f5",
            cursor: "#f4f4f5",
            // zinc-800
            selectionBackground: "#27272a",
            black: "#09090b",
            red: "#ef4444",
            green: "#10b981",
            yellow: "#eab308",
            blue: "#3b82f6",
            magenta: "#d946ef",
            cyan: "#06b6d4",
            white: "#f4f4f5",
        },
        windowsPty: {
            backend: "conpty",
        },
    });

    fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(new WebLinksAddon());

    initializeTerminal(socket);
    setupEventHandlers(socket);
}
