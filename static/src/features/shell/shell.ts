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

export class InteractiveShell {
    container: HTMLElement | null;
    sessionId: string | null;
    socket: AppSocket;
    isStarted: boolean;
    terminal: Terminal;
    fitAddon: FitAddon;
    shellTypeSelect!: HTMLSelectElement | null;
    startButton!: HTMLElement;
    restartButton!: HTMLElement;
    stopButton!: HTMLElement;

    constructor(containerId: string, socket: AppSocket) {
        this.container = byId(containerId);
        this.sessionId = null;
        this.socket = socket;
        this.isStarted = false;

        this.terminal = new Terminal({
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

        this.fitAddon = new FitAddon();
        this.terminal.loadAddon(this.fitAddon);
        this.terminal.loadAddon(new WebLinksAddon());

        this.initializeTerminal();
        this.setupEventHandlers();
    }

    toggleTextMode(): void {
        const overlay = byId("shellTextOverlay");
        const content = byId("shellTextContent");

        if (overlay && content) {
            overlay.classList.remove("hidden");
            content.textContent = this.getAllTerminalContent();
        }
    }

    closeTextMode(): void {
        const overlay = byId("shellTextOverlay");
        if (overlay) {
            overlay.classList.add("hidden");
        }
    }

    getAllTerminalContent(): string {
        let content = "";
        for (let i = 0; i < this.terminal.buffer.active.length; i++) {
            const line = this.terminal.buffer.active.getLine(i);
            if (line) {
                content += `${line.translateToString()}\n`;
            }
        }
        return content;
    }

    initializeTerminal(): void {
        const terminalElement = byId("terminalContainer")!;

        // Open terminal
        this.terminal.open(terminalElement);

        // Initial fit
        setTimeout(() => {
            this.fitAddon.fit();
            this.updateTerminalSize();
        }, 100);

        // Resize handling (debounced)
        let resizeTimeout: ReturnType<typeof setTimeout>;
        const handleResize = () => {
            if (this.isStarted) {
                clearTimeout(resizeTimeout);
                resizeTimeout = setTimeout(() => {
                    this.fitAddon.fit();
                    this.updateTerminalSize();
                }, 150);
            }
        };

        const resizeObserver = new ResizeObserver(handleResize);
        resizeObserver.observe(terminalElement);
        window.addEventListener("resize", handleResize);

        // Font size adjustment with Ctrl+Wheel
        terminalElement.addEventListener("wheel", (e) => {
            if (this.isStarted && e.ctrlKey) {
                e.preventDefault();
                this.adjustFontSize(e.deltaY < 0 ? 1 : -1);
            }
        });

        // Style adjustments
        const xtermElement = terminalElement.querySelector<HTMLElement>(".xterm");
        if (xtermElement) {
            xtermElement.style.padding = "12px";
            xtermElement.style.height = "100%";
        }
    }

    adjustFontSize(delta: number): void {
        if (!this.isStarted) return;

        const currentFontSize = this.terminal.options.fontSize!;
        const minFontSize = 8;
        const maxFontSize = 32;
        const newSize = Math.max(minFontSize, Math.min(maxFontSize, currentFontSize + delta));

        if (newSize !== currentFontSize) {
            this.terminal.options.fontSize = newSize;
            this.fitAddon.fit();
            this.updateTerminalSize();
        }
    }

    setupEventHandlers(): void {
        const startButton = byId("startShellBtn")!;
        const restartButton = byId("restartShellBtn")!;
        const stopButton = byId("stopShellBtn")!;
        const terminalContainer = byId("terminalContainer")!;
        const textModeBtn = byId("shellTextModeBtn");
        const closeTextBtn = byId("shellCloseTextBtn");
        this.shellTypeSelect = byId<HTMLSelectElement>("shellTypeSelect");
        this.startButton = startButton;
        this.restartButton = restartButton;
        this.stopButton = stopButton;

        if (textModeBtn) {
            textModeBtn.addEventListener("click", () => {
                this.toggleTextMode();
            });
        }

        if (closeTextBtn) {
            closeTextBtn.innerHTML = SVG_TEMPLATES.cross();
            closeTextBtn.addEventListener("click", () => {
                this.closeTextMode();
            });
        }

        // --- Start Shell ---
        startButton.addEventListener("click", () => {
            if (!this.isStarted) {
                this.createShellSession();
                // UI updates happen after we receive 'shell_created' event
                terminalContainer.style.opacity = "1";
            }
        });

        restartButton.addEventListener("click", (e) => {
            const btn = e.currentTarget as HTMLButtonElement;
            btn.disabled = true;
            btn.classList.add("opacity-50", "cursor-not-allowed");

            this.restartShell();

            setTimeout(() => {
                btn.disabled = false;
                btn.classList.remove("opacity-50", "cursor-not-allowed");
            }, 1500);
        });

        stopButton.addEventListener("click", () => {
            this.stopShell();
        });

        // --- Socket Events ---

        this.socket.on("available_shells", (data) => {
            this.populateShellOptions(data.shells || [], data.default);
        });

        // 1. Success: Shell Created
        this.socket.on("shell_created", (data) => {
            if (data.status === "success") {
                this.isStarted = true;
                this.sessionId = data.session_id;

                startButton.classList.add("hidden");
                restartButton.classList.remove("hidden");
                stopButton.classList.remove("hidden");
                if (this.shellTypeSelect) this.shellTypeSelect.disabled = true;

                this.fitAddon.fit();
                this.updateTerminalSize();
                this.terminal.focus();
            }
        });

        // 2. Error: Shell Creation Failed
        this.socket.on("shell_error", (data) => {
            this.terminal.writeln(`\r\n\u001B[31mError: ${data.message}\u001B[0m`);
            this.resetToIdle();
        });

        // 2b. Session Ended
        this.socket.on("shell_closed", (data) => {
            if (this.sessionId && data.session_id === this.sessionId) {
                this.resetToIdle();
            }
        });

        // --- Handle Network Drops ---
        this.socket.on("connect", () => {
            this.requestAvailableShells();
        });

        bindMediaSessionReconnect(this.socket, {
            isActive: () => this.isStarted,
            onDisconnect: () => {
                this.isStarted = false;
                this.sessionId = null;

                this.terminal.writeln("\r\n\u001B[33m[Connection lost]\u001B[0m\r\n");
                if (this.shellTypeSelect) this.shellTypeSelect.disabled = false;
            },
            onReconnect: () => {
                this.terminal.writeln("\r\n\u001B[32m[Reconnected]\u001B[0m\r\n");
                this.createShellSession();
            },
        });

        // 3. Data: Output from Server (Pushed instantly)
        this.socket.on("shell_output", (data) => {
            // Check if this output belongs to our current session
            if (this.sessionId && data.session_id === this.sessionId) {
                this.terminal.write(data.output);
            }
        });

        // --- Terminal Input ---
        this.terminal.onData((data) => {
            if (this.sessionId && this.isStarted) {
                this.socket.emit("shell_input", {
                    command: data,
                });
            }
        });

        this.terminal.attachCustomKeyEventHandler((event) => {
            if (event.type !== "keydown") return true;

            // Clipboard handled natively by xterm via DOM events on the hidden textarea.
            if (event.ctrlKey && ((event.key === "c" && this.terminal.hasSelection()) || event.key === "v")) {
                if (event.key === "c") {
                    setTimeout(() => {
                        this.terminal.clearSelection();
                    }, 0);
                }
                return false;
            }

            if (event.ctrlKey && (event.key === "+" || event.key === "=")) {
                event.preventDefault();
                this.adjustFontSize(1);
                return false;
            } else if (event.ctrlKey && event.key === "-") {
                event.preventDefault();
                this.adjustFontSize(-1);
                return false;
            }

            return true;
        });

        terminalContainer.addEventListener("contextmenu", (e) => {
            if (!this.isStarted) return;
            e.preventDefault();

            if (this.terminal.hasSelection()) {
                void navigator.clipboard.writeText(this.terminal.getSelection());
                this.terminal.clearSelection();
            } else {
                void navigator.clipboard.readText().then((text) => {
                    if (text && this.isStarted) {
                        this.terminal.paste(text);
                    }
                });
            }
        });
    }

    restartShell(): void {
        if (!this.isStarted) return;
        this.sessionId = null;
        this.terminal.reset();
        if (this.shellTypeSelect) this.shellTypeSelect.disabled = false;
        this.createShellSession();
    }

    stopShell(): void {
        if (!this.isStarted) return;
        this.socket.emit("shell_close");
    }

    resetToIdle(): void {
        this.isStarted = false;
        this.sessionId = null;
        this.startButton.classList.remove("hidden");
        this.restartButton.classList.add("hidden");
        this.stopButton.classList.add("hidden");
        if (this.shellTypeSelect) this.shellTypeSelect.disabled = false;
    }

    requestAvailableShells(): void {
        this.socket.emit("list_shells");
    }

    populateShellOptions(shells: string[], defaultShell?: string): void {
        if (!this.shellTypeSelect) return;

        const previous = this.shellTypeSelect.value;
        this.shellTypeSelect.replaceChildren();

        shells.forEach((shell) => {
            const option = document.createElement("option");
            option.value = shell;
            option.textContent = SHELL_LABELS[shell] ?? shell;
            this.shellTypeSelect!.append(option);
        });

        if (shells.includes(previous)) {
            this.shellTypeSelect.value = previous;
        } else if (defaultShell) {
            this.shellTypeSelect.value = defaultShell;
        }
    }

    createShellSession(): void {
        const { cols, rows } = this.terminal;
        this.sessionId = Math.random().toString(36).slice(2);
        const shell = this.shellTypeSelect && this.shellTypeSelect.value ? this.shellTypeSelect.value : undefined;
        this.socket.emit("shell_create", { cols, rows, session_id: this.sessionId, shell });
    }

    updateTerminalSize(): void {
        if (this.sessionId && this.isStarted) {
            const { cols, rows } = this.terminal;
            this.socket.emit("shell_resize", {
                cols,
                rows,
            });
        }
    }
}
