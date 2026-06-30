// static/js/modules/dom.js
import { SVG_TEMPLATES } from "./utils.js";

const connectionOverlay = document.getElementById("connectionOverlay");
const connectionMessage = document.getElementById("connectionMessage");

function getInteractiveElements() {
    return document.querySelectorAll("button, input, select, textarea, a[href], [onclick], [tabindex]");
}

function disableInteractiveElements() {
    getInteractiveElements().forEach((element) => {
        element.disabled = true;

        if (element.tagName === "A" || !("disabled" in element)) {
            if (!element.hasAttribute("data-orig-tabindex")) {
                element.setAttribute("data-orig-tabindex", element.getAttribute("tabindex") || "");
            }
            element.setAttribute("tabindex", "-1");
            element.classList.add("pointer-events-none", "opacity-50");
        }
    });
}

function enableInteractiveElements() {
    getInteractiveElements().forEach((element) => {
        element.disabled = false;

        if (element.tagName === "A" || !("disabled" in element)) {
            element.classList.remove("pointer-events-none", "opacity-50");
            const origTabindex = element.getAttribute("data-orig-tabindex");
            if (origTabindex) {
                element.setAttribute("tabindex", origTabindex);
            } else {
                element.removeAttribute("tabindex");
            }
            element.removeAttribute("data-orig-tabindex");
        }
    });
}

function showConnectionOverlay(message) {
    connectionMessage.textContent = message;
    connectionOverlay.classList.remove("hidden");
    void connectionOverlay.offsetWidth;
    connectionOverlay.classList.remove("opacity-0");
    disableInteractiveElements();
}

function hideConnectionOverlay() {
    connectionOverlay.classList.add("opacity-0");
    setTimeout(() => {
        connectionOverlay.classList.add("hidden");
    }, 300);
    enableInteractiveElements();
}

class LoadingButton {
    constructor(buttonElement, loadingText = "Loading...") {
        this.button = buttonElement;
        this.originalHtml = this.button.innerHTML;
        this.loadingText = loadingText;
    }

    startLoading() {
        this.button.disabled = true;
        const textHtml = this.loadingText ? `<span>${this.loadingText}</span>` : "";
        this.button.innerHTML = `<span class="flex items-center justify-center gap-2">${SVG_TEMPLATES.spinner(4)}${textHtml}</span>`;
        return this;
    }

    stopLoading() {
        this.button.disabled = false;
        this.button.innerHTML = this.originalHtml;
        return this;
    }

    async withLoading(asyncFn) {
        this.startLoading();
        try {
            await asyncFn();
        } finally {
            this.stopLoading();
        }
    }
}

function showNotification(message, type = "error") {
    let container = document.getElementById("notification-container");
    if (!container) {
        container = document.createElement("div");
        container.id = "notification-container";
        container.className = "fixed bottom-6 right-6 z-50 flex flex-col gap-2.5 items-end pointer-events-none";
        document.body.appendChild(container);
    }

    const existingWrapper = Array.from(container.children).find(
        (w) => w.dataset.message === message && w.dataset.type === type,
    );

    if (existingWrapper) {
        const count = parseInt(existingWrapper.dataset.count || "1", 10) + 1;
        existingWrapper.dataset.count = count;

        const badge = existingWrapper.querySelector(".notification-badge");
        badge.textContent = `${count}x`;
        badge.classList.remove("hidden");

        const toast = existingWrapper.lastElementChild;
        toast.classList.add("scale-[1.02]", "brightness-125");
        setTimeout(() => toast.classList.remove("scale-[1.02]", "brightness-125"), 150);

        clearTimeout(existingWrapper.timeoutId);
        existingWrapper.timeoutId = setTimeout(existingWrapper.closeFn, 5000);
        return;
    }

    const config = {
        error: {
            icon: "text-red-500",
            path: "M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z",
        },
        warning: { icon: "text-amber-500", path: "M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" },
        info: { icon: "text-zinc-400", path: "M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" },
    }[type] ?? { icon: "text-zinc-400", path: "M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" };

    const wrapper = document.createElement("div");
    wrapper.className = "flex items-center gap-2";
    wrapper.dataset.message = message;
    wrapper.dataset.type = type;
    wrapper.dataset.count = "1";

    const badge = document.createElement("span");
    badge.className =
        "notification-badge hidden px-1.5 py-0.5 text-xs font-semibold bg-zinc-800 text-zinc-300 rounded-full leading-none tabular-nums transition-all duration-300 border border-zinc-700";

    const toast = document.createElement("div");
    toast.className =
        "bg-zinc-900 border border-zinc-800 rounded-lg shadow-lg px-4 py-3 text-sm flex items-start gap-3 pointer-events-auto max-w-sm transition-all duration-300 translate-x-4 opacity-0";

    toast.innerHTML = `
        <div class="shrink-0 ${config.icon} mt-0.5">
            <svg class="w-[18px] h-[18px]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="${config.path}"/></svg>
        </div>
        <div class="flex-1 min-w-0 break-words">
            <span class="notification-text whitespace-pre-wrap text-[13px] leading-snug text-zinc-200"></span>
        </div>
        <button class="p-1 -mr-1 text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 rounded transition-colors">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M6 18L18 6M6 6l12 12"/></svg>
        </button>
    `;

    toast.querySelector(".notification-text").textContent = message;
    wrapper.appendChild(badge);
    wrapper.appendChild(toast);
    container.appendChild(wrapper);

    requestAnimationFrame(() => toast.classList.remove("translate-x-4", "opacity-0"));

    const closeBtn = toast.querySelector("button");

    wrapper.closeFn = () => {
        toast.classList.add("opacity-0", "translate-x-4");
        badge.classList.add("opacity-0");
        setTimeout(() => wrapper.remove(), 300);
    };

    closeBtn.addEventListener("click", wrapper.closeFn);
    wrapper.timeoutId = setTimeout(wrapper.closeFn, 5000);
}

export { showConnectionOverlay, hideConnectionOverlay, LoadingButton, showNotification };
