// static/js/shared/dom-helpers.js

function isTypingField(element) {
    return (
        !!element &&
        (element.tagName === "INPUT" ||
            element.tagName === "TEXTAREA" ||
            element.tagName === "SELECT" ||
            element.isContentEditable)
    );
}

const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" };
const escapeHtml = (str) => (str || "").replace(/[&<>"']/g, (m) => HTML_ESCAPES[m]);

export { isTypingField, escapeHtml };
