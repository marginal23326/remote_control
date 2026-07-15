export function isTypingField(element: EventTarget | null): boolean {
    return (
        Boolean(element) &&
        element instanceof Element &&
        (element.tagName === "INPUT" ||
            element.tagName === "TEXTAREA" ||
            element.tagName === "SELECT" ||
            (element as HTMLElement).isContentEditable)
    );
}

const HTML_ESCAPES: Record<string, string> = { '"': "&quot;", "&": "&amp;", "'": "&#039;", "<": "&lt;", ">": "&gt;" };
export const escapeHtml = (str: string | null | undefined): string =>
    (str ?? "").replaceAll(/[&<>"']/gu, (m) => HTML_ESCAPES[m]!);
