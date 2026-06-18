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
    disableInteractiveElements();
}

function hideConnectionOverlay() {
    connectionOverlay.classList.add("hidden");
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
        this.button.innerHTML = `${SVG_TEMPLATES.spinner(4)} ${this.loadingText}`;
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

export {
    disableInteractiveElements,
    enableInteractiveElements,
    showConnectionOverlay,
    hideConnectionOverlay,
    LoadingButton,
};
