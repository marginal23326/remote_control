import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { SVG_TEMPLATES } from "./utils.js";

export class InteractiveShell {
    constructor(containerId, socket) {
        this.container = document.getElementById(containerId);
        this.sessionId = null;
        this.socket = socket; // Use the shared socket instance
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

        // Resize handling
        const resizeObserver = new ResizeObserver(() => {
            if (this.isStarted) {
                this.fitAddon.fit();
                this.updateTerminalSize();
            }
        });
        resizeObserver.observe(terminalElement);

        window.addEventListener("resize", () => {
            if (this.isStarted) {
                this.fitAddon.fit();
                this.updateTerminalSize();
            }
        });

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
            xtermElement.style.padding = "8px";
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
        const terminalContainer = document.getElementById("terminalContainer");
        const textModeBtn = document.getElementById("shellTextModeBtn");
        const closeTextBtn = document.getElementById("shellCloseTextBtn");

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

        restartButton.addEventListener("click", () => this.restartShell());

        // --- Socket Events ---

        // 1. Success: Shell Created
        this.socket.on("shell_created", (data) => {
            if (data.status === "success") {
                this.isStarted = true;
                this.sessionId = data.session_id;

                startButton.classList.add("hidden");
                restartButton.classList.remove("hidden");

                this.fitAddon.fit();
                this.updateTerminalSize();
                this.terminal.focus();
            }
        });

        // 2. Error: Shell Creation Failed
        this.socket.on("shell_error", (data) => {
            this.terminal.writeln(`\r\n\x1b[31mError: ${data.message}\x1b[0m`);
            this.isStarted = false;
        });

        // --- Handle Network Drops ---
        let wasStarted = false;

        this.socket.on("disconnect", () => {
            if (this.isStarted) {
                wasStarted = true;
                this.isStarted = false;
                this.sessionId = null;

                this.terminal.writeln("\r\n\x1b[33m[Connection lost]\x1b[0m\r\n");
            }
        });

        this.socket.on("connect", () => {
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
                    session_id: this.sessionId,
                    command: data,
                });
            }
        });

        this.terminal.attachCustomKeyEventHandler((event) => {
            if (event.type !== "keydown") return true;

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
        this.createShellSession();
    }

    createShellSession() {
        const { cols, rows } = this.terminal;
        // Emit event instead of API call
        this.socket.emit("shell_create", { cols, rows });
    }

    updateTerminalSize() {
        if (this.sessionId && this.isStarted) {
            const { cols, rows } = this.terminal;
            this.socket.emit("shell_resize", {
                session_id: this.sessionId,
                cols,
                rows,
            });
        }
    }
}
