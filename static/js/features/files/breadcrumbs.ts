export function renderBreadcrumbs(
    container: HTMLElement | null,
    path: string,
    onNavigate: (targetPath: string) => void,
): void {
    if (!container) return;
    container.innerHTML = "";

    const isWindows = path.includes("\\") || /^[A-Z]:/iu.test(path);
    const separator = isWindows ? "\\" : "/";

    const createPartBtn = (text: string, targetPath: string, isActive: boolean): HTMLButtonElement => {
        const btn = document.createElement("button");
        btn.className = `truncate flex-shrink-0 rounded px-1.5 py-0.5 text-sm transition-colors ${
            isActive
                ? "text-zinc-100 font-medium max-w-[200px]"
                : "text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 max-w-[150px] cursor-pointer"
        }`;
        btn.textContent = text;
        btn.title = text;
        if (!isActive) {
            btn.addEventListener("click", (e) => {
                e.stopPropagation();
                onNavigate(targetPath);
            });
        }
        return btn;
    };

    const chevron = `<svg class="w-3.5 h-3.5 text-zinc-600 shrink-0 mx-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>`;

    if (!path || path === "/" || path === "") {
        container.append(createPartBtn(path === "" ? "This PC" : "/", path === "" ? "" : "/", true));
        return;
    }

    const parts = path.split(separator).filter(Boolean);
    container.append(createPartBtn(isWindows ? "This PC" : "root", isWindows ? "" : "/", false));

    let accumulated = "";
    parts.forEach((part, index) => {
        container.insertAdjacentHTML("beforeend", chevron);
        if (isWindows) {
            accumulated = accumulated ? `${accumulated.replace(/\\$/u, "")}\\${part}` : part;
            if (index === 0 && part.endsWith(":")) accumulated += "\\";
        } else {
            accumulated += `/${part}`;
        }
        container.append(createPartBtn(part, accumulated, index === parts.length - 1));
    });

    requestAnimationFrame(() => (container.scrollLeft = container.scrollWidth));
}
