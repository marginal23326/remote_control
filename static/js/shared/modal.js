// static/js/shared/modal.js
import { escapeHtml } from "./dom-helpers.js";
import { showNotification } from "./feedback.js";

function _createModal(bodyHtml, { confirmLabel, cancelLabel = "Cancel", danger = false }) {
    const overlay = document.createElement("div");
    overlay.dataset.appModal = "";
    overlay.className =
        "fixed inset-0 z-30 flex items-center justify-center bg-zinc-950/80 backdrop-blur-sm p-4 animate-in fade-in duration-150";
    overlay.innerHTML = `<div class="w-full max-w-sm bg-zinc-900 border border-zinc-800 rounded-xl p-5 shadow-lg">
        ${bodyHtml}
        <div class="flex justify-end gap-2 mt-5">
            <button class="modal-cancel-btn px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-md text-sm font-medium transition-colors flex items-center gap-1.5">
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
                ${escapeHtml(cancelLabel)}
            </button>
            <button class="modal-confirm-btn px-3 py-1.5 ${
                danger ? "bg-red-950 hover:bg-red-900 text-red-400" : "bg-zinc-100 hover:bg-white text-zinc-900"
            } rounded-md text-sm font-medium transition-colors flex items-center gap-1.5">
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
                ${escapeHtml(confirmLabel)}
            </button>
        </div>
    </div>`;
    document.body.appendChild(overlay);
    return overlay;
}

function _runModal(overlay, { getResult, focusSelector }) {
    return new Promise((resolve) => {
        const finish = (value) => {
            document.removeEventListener("keydown", onKeydown);
            overlay.remove();
            resolve(value);
        };
        const attemptConfirm = () => {
            const result = getResult ? getResult() : true;
            if (result === undefined) return;
            finish(result);
        };
        const onKeydown = (e) => {
            if (e.key === "Escape") finish(null);
            if (e.key === "Enter") attemptConfirm();
        };

        overlay.querySelector(".modal-confirm-btn").addEventListener("click", attemptConfirm);
        overlay.querySelector(".modal-cancel-btn").addEventListener("click", () => finish(null));
        overlay.addEventListener("mousedown", (e) => {
            if (e.target === overlay) finish(null);
        });
        document.addEventListener("keydown", onKeydown);

        overlay.querySelector(focusSelector).focus();
    });
}

function showPromptModal({ title, label = "", initialValue = "", confirmLabel = "OK", sanitize = null }) {
    const overlay = _createModal(
        `<h3 class="text-sm font-medium text-zinc-100 mb-3">${escapeHtml(title)}</h3>
         ${label ? `<label class="block text-xs text-zinc-500 mb-1.5">${escapeHtml(label)}</label>` : ""}
         <input type="text" spellcheck="false" class="modal-input w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-md text-sm text-zinc-100 focus:border-zinc-500 focus:outline-none transition-colors" />`,
        { confirmLabel },
    );

    const input = overlay.querySelector(".modal-input");
    input.value = initialValue;
    if (sanitize) {
        input.addEventListener("input", () => {
            const cleaned = sanitize(input.value);
            if (cleaned !== input.value) input.value = cleaned;
        });
    }

    return _runModal(overlay, {
        focusSelector: ".modal-input",
        getResult: () => {
            const value = input.value.trim();
            if (!value) {
                showNotification("Please enter a value", "warning");
                return undefined;
            }
            return value;
        },
    });
}

function showConfirmModal({ title, message, confirmLabel = "Confirm", cancelLabel = "Cancel", danger = false }) {
    const overlay = _createModal(
        `<h3 class="text-sm font-medium text-zinc-100 mb-2">${escapeHtml(title)}</h3>
         <p class="text-sm text-zinc-400 break-all">${escapeHtml(message)}</p>`,
        { confirmLabel, cancelLabel, danger },
    );
    return _runModal(overlay, { focusSelector: ".modal-confirm-btn" }).then((v) => v === true);
}

export { showPromptModal, showConfirmModal };
