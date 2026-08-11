import { Yace } from "yace";
import { code } from "yace/highlighters/code";
import { history, preserveIndent, tab } from "yace/plugins";
import { apiCall } from "@/shared/api";
import { escapeHtml } from "@/shared/dom-helpers";
import { LoadingButton, showNotification, withErrorNotification } from "@/shared/feedback";
import { SVG_TEMPLATES } from "@/shared/icons";
import { closeModalOverlay, createModalOverlay, showConfirmModal } from "@/shared/modal";

export async function openFileEditor(path: string, name: string): Promise<void> {
    const overlay = createModalOverlay();
    overlay.innerHTML = `<div class="modal-card w-full max-w-4xl h-[85vh] bg-zinc-900 border border-zinc-800 rounded-xl shadow-lg flex flex-col overflow-hidden">
        <div class="flex items-center justify-between gap-3 px-4 py-3 border-b border-zinc-800 shrink-0">
            <div class="flex items-center gap-2 min-w-0">
                <span class="editor-dirty-dot hidden w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0"></span>
                <span class="text-sm font-medium text-zinc-100 truncate" title="${escapeHtml(path)}">${escapeHtml(name)}</span>
            </div>
            <div class="flex items-center gap-2 shrink-0">
                <button
                    class="editor-save-btn inline-flex items-center gap-1.5 px-3 py-1.5 bg-zinc-100 hover:bg-white text-zinc-900 rounded-md text-sm font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none"
                    disabled
                >
                    ${SVG_TEMPLATES.icon("M5 13l4 4L19 7", "w-3.5 h-3.5")}
                    Save
                </button>
                <button class="editor-close-btn p-1.5 text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 rounded-md transition-colors">
                    ${SVG_TEMPLATES.cross("w-4 h-4")}
                </button>
            </div>
        </div>
        <div class="editor-body file-editor-tokens flex-1 min-h-0 overflow-y-auto bg-black flex items-center justify-center">
            ${SVG_TEMPLATES.spinner(6)}
        </div>
    </div>`;

    const saveBtn = overlay.querySelector<HTMLButtonElement>(".editor-save-btn")!;
    const closeBtn = overlay.querySelector<HTMLButtonElement>(".editor-close-btn")!;
    const dirtyDot = overlay.querySelector<HTMLElement>(".editor-dirty-dot")!;
    const body = overlay.querySelector<HTMLElement>(".editor-body")!;
    const saveButton = new LoadingButton(saveBtn, "Saving...");

    let editor: Yace | null = null;
    let dirty = false;
    let isClosing = false;

    const setDirty = (value: boolean) => {
        dirty = value;
        saveBtn.disabled = !value;
        dirtyDot.classList.toggle("hidden", !value);
    };

    const close = () => {
        document.removeEventListener("keydown", onKeydown);
        editor?.destroy();
        closeModalOverlay(overlay);
    };

    const requestClose = async (): Promise<void> => {
        if (isClosing) return;
        if (dirty) {
            isClosing = true;
            const discard = await showConfirmModal({
                confirmLabel: "Discard",
                danger: true,
                message: `"${name}" has unsaved changes that will be lost.`,
                title: "Discard changes?",
            });
            isClosing = false;
            if (!discard) return;
        }
        close();
    };

    const save = async (): Promise<void> => {
        if (!editor || !dirty) return;
        const content = editor.value;
        await withErrorNotification(async () => {
            await saveButton.withLoading(async () => {
                await apiCall("/api/files/content", "POST", { content, path });
            });
            setDirty(false);
            showNotification(`Saved "${name}".`, "info");
        }, "Error saving file");
    };

    const onKeydown = (e: KeyboardEvent): void => {
        if (e.key === "Escape") {
            e.preventDefault();
            void requestClose();
        } else if (!isClosing && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
            e.preventDefault();
            void save();
        }
    };

    closeBtn.addEventListener("click", () => void requestClose());
    saveBtn.addEventListener("click", () => void save());
    overlay.addEventListener("mousedown", (e) => {
        if (e.target === overlay) void requestClose();
    });
    document.addEventListener("keydown", onKeydown);

    let content: string;
    try {
        ({ content } = await apiCall<{ content: string }>(`/api/files/content?path=${encodeURIComponent(path)}`));
    } catch (error) {
        showNotification((error as Error).message, "error");
        close();
        return;
    }

    body.classList.remove("flex", "items-center", "justify-center");
    body.innerHTML = "";

    const mount = document.createElement("div");
    body.append(mount);

    editor = new Yace(mount, {
        highlighters: [code()],
        lineNumbers: true,
        plugins: [history(), tab(), preserveIndent()],
        styles: {
            color: "var(--text-main)",
            fontFamily: '"JetBrains Mono", monospace',
            fontSize: "13px",
            lineHeight: "1.6",
            minHeight: "100%",
            padding: "12px 16px",
        },
        value: content,
    });
    editor.onUpdate(() => setDirty(true));
    editor.textarea.focus();
}
