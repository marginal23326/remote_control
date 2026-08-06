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

export const intValue = (value: string | number): number => Math.trunc(Number(value));

export function onAsync<E extends Event = Event>(
    target: EventTarget | null | undefined,
    type: string,
    handler: (event: E) => Promise<void>,
    options?: AddEventListenerOptions,
): void {
    target?.addEventListener(
        type,
        (event) => {
            handler(event as E).catch((error: unknown) => {
                console.error(`Unhandled error in "${type}" handler:`, error);
            });
        },
        options,
    );
}

export function toggleClasses(
    el: Element,
    active: boolean,
    activeClasses: readonly string[],
    inactiveClasses: readonly string[],
): void {
    for (const c of activeClasses) el.classList.toggle(c, active);
    for (const c of inactiveClasses) el.classList.toggle(c, !active);
}

export function setToggleStyle(el: HTMLElement, active: boolean): void {
    toggleClasses(
        el,
        active,
        ["bg-zinc-200", "text-zinc-900"],
        ["hover:bg-zinc-800", "hover:text-zinc-100", "text-zinc-400"],
    );
}

export function updateSortIndicators(headerSelector: string, activeColumn: string, ascending: boolean): void {
    document.querySelectorAll<HTMLElement>(headerSelector).forEach((th) => {
        const indicator = th.querySelector(".sort-indicator");
        if (!indicator) return;
        indicator.textContent = th.dataset.sort === activeColumn ? (ascending ? " ▲" : " ▼") : "";
    });
}
