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

export function bindDebouncedInput(input: HTMLInputElement, callback: () => void, delay = 50): void {
    let timeout: ReturnType<typeof setTimeout>;
    input.addEventListener("input", () => {
        clearTimeout(timeout);
        timeout = setTimeout(callback, delay);
    });
}

export function byId<T extends HTMLElement = HTMLElement>(id: string): T | null {
    return document.getElementById(id) as T | null;
}

export function setToggleStyle(el: HTMLElement, active: boolean): void {
    el.classList.toggle("bg-zinc-200", active);
    el.classList.toggle("text-zinc-900", active);
    el.classList.toggle("hover:bg-zinc-800", !active);
    el.classList.toggle("hover:text-zinc-100", !active);
    el.classList.toggle("text-zinc-400", !active);
}

export function updateSortIndicators(headerSelector: string, activeColumn: string, ascending: boolean): void {
    document.querySelectorAll<HTMLElement>(headerSelector).forEach((th) => {
        const indicator = th.querySelector(".sort-indicator");
        if (!indicator) return;
        indicator.textContent = th.dataset.sort === activeColumn ? (ascending ? " ▲" : " ▼") : "";
    });
}
