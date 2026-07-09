import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { SVG_TEMPLATES } from "./utils.js";

const SHELL_LABELS = {
    bash: "Bash",
    zsh: "Zsh",
    fish: "Fish",
    sh: "sh",
    dash: "Dash",
    ksh: "Ksh",
    "cmd.exe": "Command Prompt",
    "pwsh.exe": "PowerShell",
    "powershell.exe": "Windows PowerShell",
    "bash.exe": "Git Bash",
};

export class InteractiveShell {
    constructor(containerId, socket) {
        this.container = document.getElementById(containerId);
        this.sessionId = null;
        this.socket = socket;
        this.isStarted = false;

        this.terminal = new Terminal({
            cursorStyle: "bar",
            cursorInactiveStyle: "none",
            cursorBlink: true,
            windowsPty: {
                backend: "conpty",
            },
            fontFamily: "'MesloLGM Nerd Font', Consolas, monospace",
            scrollback: 10000,
            theme: {
                background: "#09090b", // zinc-950
                foreground: "#f4f4f5", // zinc-100
                cursor: "#f4f4f5",
                selectionBackground: "#27272a", // zinc-800
                black: "#09090b",
                red: "#ef4444",
                green: "#10b981",
                yellow: "#eab308",
                blue: "#3b82f6",
                magenta: "#d946ef",
                cyan: "#06b6d4",
                white: "#f4f4f5",
            },
        });

        this.fitAddon = new FitAddon();
        this.terminal.loadAddon(this.fitAddon);
        this.terminal.loadAddon(new WebLinksAddon());

        this.initializeTerminal();
        this.setupEventHandlers();
    }

    toggleTextMode() {
        const overlay = document.getElementById("shellTextOverlay");
        const content = document.getElementById("shellTextContent");

        if (overlay && content) {
            overlay.classList.remove("hidden");
            content.textContent = this.getAllTerminalContent();
        }
    }

    closeTextMode() {
        const overlay = document.getElementById("shellTextOverlay");
        if (overlay) {
            overlay.classList.add("hidden");
        }
    }

    getAllTerminalContent() {
        let content = "";
        for (let i = 0; i < this.terminal.buffer.active.length; i++) {
            const line = this.terminal.buffer.active.getLine(i);
            if (line) {
                content += line.translateToString() + "\n";
            }
        }
        return content;
    }

    initializeTerminal() {
        const terminalElement = document.getElementById("terminalContainer");

        // Open terminal
        this.terminal.open(terminalElement);

        // Initial fit
        setTimeout(() => {
            this.fitAddon.fit();
            this.updateTerminalSize();
        }, 100);

        // Resize handling (debounced)
        let resizeTimeout;
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
        const xtermElement = terminalElement.querySelector(".xterm");
        if (xtermElement) {
            xtermElement.style.padding = "12px";
            xtermElement.style.height = "100%";
        }
    }

    adjustFontSize(delta) {
        if (!this.isStarted) return;

        const currentFontSize = this.terminal.options.fontSize;
        const minFontSize = 8;
        const maxFontSize = 32;
        const newSize = Math.max(minFontSize, Math.min(maxFontSize, currentFontSize + delta));

        if (newSize !== currentFontSize) {
            this.terminal.options.fontSize = newSize;
            this.fitAddon.fit();
            this.updateTerminalSize();
        }
    }

    setupEventHandlers() {
        const startButton = document.getElementById("startShellBtn");
        const restartButton = document.getElementById("restartShellBtn");
        const stopButton = document.getElementById("stopShellBtn");
        const terminalContainer = document.getElementById("terminalContainer");
        const textModeBtn = document.getElementById("shellTextModeBtn");
        const closeTextBtn = document.getElementById("shellCloseTextBtn");
        this.shellTypeSelect = document.getElementById("shellTypeSelect");
        this.startButton = startButton;
        this.restartButton = restartButton;
        this.stopButton = stopButton;

        if (textModeBtn) {
            textModeBtn.addEventListener("click", () => this.toggleTextMode());
        }

        if (closeTextBtn) {
            closeTextBtn.innerHTML = SVG_TEMPLATES.cross();
            closeTextBtn.addEventListener("click", () => this.closeTextMode());
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
            const btn = e.currentTarget;
            btn.disabled = true;
            btn.classList.add("opacity-50", "cursor-not-allowed");

            this.restartShell();

            setTimeout(() => {
                btn.disabled = false;
                btn.classList.remove("opacity-50", "cursor-not-allowed");
            }, 1500);
        });

        stopButton.addEventListener("click", () => this.stopShell());

        // --- Socket Events ---

        this.socket.on("available_shells", (data) => this.populateShellOptions(data.shells || [], data.default));

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
            this.terminal.writeln(`\r\n\x1b[31mError: ${data.message}\x1b[0m`);
            this.resetToIdle();
        });

        // 2b. Session Ended
        this.socket.on("shell_closed", (data) => {
            if (this.sessionId && data.session_id === this.sessionId) {
                this.resetToIdle();
            }
        });

        // --- Handle Network Drops ---
        let wasStarted = false;

        this.socket.on("disconnect", () => {
            if (this.isStarted) {
                wasStarted = true;
                this.isStarted = false;
                this.sessionId = null;

                this.terminal.writeln("\r\n\x1b[33m[Connection lost]\x1b[0m\r\n");
                if (this.shellTypeSelect) this.shellTypeSelect.disabled = false;
            }
        });

        this.socket.on("connect", () => {
            this.requestAvailableShells();

            if (wasStarted) {
                wasStarted = false;
                this.terminal.writeln("\r\n\x1b[32m[Reconnected]\x1b[0m\r\n");
                this.createShellSession();
            }
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
                    setTimeout(() => this.terminal.clearSelection(), 0);
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
                navigator.clipboard.writeText(this.terminal.getSelection());
                this.terminal.clearSelection();
            } else {
                navigator.clipboard.readText().then((text) => {
                    if (text && this.isStarted) {
                        this.terminal.paste(text);
                    }
                });
            }
        });
    }

    restartShell() {
        if (!this.isStarted) return;
        this.sessionId = null;
        this.terminal.clear();
        if (this.shellTypeSelect) this.shellTypeSelect.disabled = false;
        this.createShellSession();
    }

    stopShell() {
        if (!this.isStarted) return;
        this.socket.emit("shell_close");
    }

    resetToIdle() {
        this.isStarted = false;
        this.sessionId = null;
        this.startButton.classList.remove("hidden");
        this.restartButton.classList.add("hidden");
        this.stopButton.classList.add("hidden");
        if (this.shellTypeSelect) this.shellTypeSelect.disabled = false;
    }

    requestAvailableShells() {
        this.socket.emit("list_shells");
    }

    populateShellOptions(shells, defaultShell) {
        if (!this.shellTypeSelect) return;

        const previous = this.shellTypeSelect.value;
        this.shellTypeSelect.replaceChildren();

        shells.forEach((shell) => {
            const option = document.createElement("option");
            option.value = shell;
            option.textContent = SHELL_LABELS[shell] || shell;
            this.shellTypeSelect.appendChild(option);
        });

        if (shells.includes(previous)) {
            this.shellTypeSelect.value = previous;
        } else if (defaultShell) {
            this.shellTypeSelect.value = defaultShell;
        }
    }

    createShellSession() {
        const { cols, rows } = this.terminal;
        this.sessionId = Math.random().toString(36).substring(2);
        const shell = this.shellTypeSelect && this.shellTypeSelect.value ? this.shellTypeSelect.value : undefined;
        this.socket.emit("shell_create", { cols, rows, session_id: this.sessionId, shell });
    }

    updateTerminalSize() {
        if (this.sessionId && this.isStarted) {
            const { cols, rows } = this.terminal;
            this.socket.emit("shell_resize", {
                cols,
                rows,
            });
        }
    }
}
