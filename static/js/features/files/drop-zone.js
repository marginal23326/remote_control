class DropZone {
    constructor(elementId, onUpload) {
        this.element = document.getElementById(elementId);
        this.overlay = document.getElementById("dropOverlay");
        this.promptEl = document.getElementById("dropPrompt");
        this.spinnerEl = document.getElementById("dropSpinner");
        this.onUpload = onUpload;
        this.dragCounter = 0;
        this.setupEventListeners();
    }

    setupEventListeners() {
        if (!this.element) return;
        const preventDefault = (e) => {
            e.preventDefault();
            e.stopPropagation();
        };

        ["dragenter", "dragover", "dragleave", "drop"].forEach((event) =>
            this.element.addEventListener(event, preventDefault),
        );

        this.element.addEventListener("dragenter", () => {
            this.dragCounter++;
            if (this.dragCounter === 1) this.highlight();
        });

        this.element.addEventListener("dragleave", () => {
            this.dragCounter--;
            if (this.dragCounter === 0) this.unhighlight();
        });

        this.element.addEventListener("drop", (e) => {
            this.dragCounter = 0;
            this.unhighlight();
            this.onUpload(e.dataTransfer.files, true);
        });
    }

    highlight() {
        if (this.overlay) {
            this.overlay.classList.remove("hidden");
            requestAnimationFrame(() => this.overlay.classList.remove("opacity-0"));
        }
        this.element.classList.add("border-zinc-500", "ring-2", "ring-zinc-800/50");
    }

    unhighlight() {
        if (this.overlay) {
            this.overlay.classList.add("opacity-0");
            setTimeout(() => this.overlay.classList.add("hidden"), 200);
        }
        this.element.classList.remove("border-zinc-500", "ring-2", "ring-zinc-800/50");
    }

    setLoading() {
        if (this.promptEl) this.promptEl.classList.add("hidden");
        if (this.spinnerEl) this.spinnerEl.classList.remove("hidden");
        if (this.overlay) this.overlay.classList.remove("hidden", "opacity-0");
    }

    reset() {
        if (this.promptEl) this.promptEl.classList.remove("hidden");
        if (this.spinnerEl) this.spinnerEl.classList.add("hidden");
        this.unhighlight();
    }
}

export { DropZone };
