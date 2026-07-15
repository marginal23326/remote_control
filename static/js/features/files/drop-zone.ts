export type DropZoneUploadHandler = (files: FileList, isDrop: boolean) => void;

const preventDefault = (e: Event): void => {
    e.preventDefault();
    e.stopPropagation();
};

export class DropZone {
    element: HTMLElement | null;
    overlay: HTMLElement | null;
    promptEl: HTMLElement | null;
    spinnerEl: HTMLElement | null;
    onUpload: DropZoneUploadHandler;
    dragCounter = 0;

    constructor(elementId: string, onUpload: DropZoneUploadHandler) {
        this.element = document.getElementById(elementId);
        this.overlay = document.getElementById("dropOverlay");
        this.promptEl = document.getElementById("dropPrompt");
        this.spinnerEl = document.getElementById("dropSpinner");
        this.onUpload = onUpload;
        this.setupEventListeners();
    }

    setupEventListeners(): void {
        if (!this.element) return;

        (["dragenter", "dragover", "dragleave", "drop"] as const).forEach((event) => {
            this.element!.addEventListener(event, preventDefault);
        });

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
            this.onUpload(e.dataTransfer!.files, true);
        });
    }

    highlight(): void {
        if (this.overlay) {
            this.overlay.classList.remove("hidden");
            requestAnimationFrame(() => {
                this.overlay!.classList.remove("opacity-0");
            });
        }
        this.element!.classList.add("border-zinc-500", "ring-2", "ring-zinc-800/50");
    }

    unhighlight(): void {
        if (this.overlay) {
            this.overlay.classList.add("opacity-0");
            setTimeout(() => {
                this.overlay!.classList.add("hidden");
            }, 200);
        }
        this.element!.classList.remove("border-zinc-500", "ring-2", "ring-zinc-800/50");
    }

    setLoading(): void {
        if (this.promptEl) this.promptEl.classList.add("hidden");
        if (this.spinnerEl) this.spinnerEl.classList.remove("hidden");
        if (this.overlay) this.overlay.classList.remove("hidden", "opacity-0");
    }

    reset(): void {
        if (this.promptEl) this.promptEl.classList.remove("hidden");
        if (this.spinnerEl) this.spinnerEl.classList.add("hidden");
        this.unhighlight();
    }
}
