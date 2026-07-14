class ContextMenuManager {
    constructor(config) {
        this.menuElement = null;
        this.config = {
            menuClass: "context-menu",
            menuItemClass:
                "px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100 rounded-md cursor-pointer select-none transition-colors",
            getMenuItems: () => [],
            ...config,
        };
    }

    hide() {
        if (this.menuElement) {
            this.menuElement.remove();
            this.menuElement = null;
        }
    }

    show(x, y, context) {
        this.hide();

        const items = this.config.getMenuItems(context);
        if (!items.length) return;

        this.menuElement = document.createElement("div");
        this.menuElement.classList.add(this.config.menuClass);
        this.menuElement.style.position = "fixed";
        this.menuElement.style.left = `${x}px`;
        this.menuElement.style.top = `${y}px`;
        this.menuElement.style.zIndex = "20";

        const ul = document.createElement("ul");
        ul.className =
            "bg-zinc-900 border border-zinc-800 rounded-lg p-1 shadow-lg min-w-[140px] flex flex-col gap-0.5";

        items.forEach((item) => {
            const li = document.createElement("li");
            li.className = this.config.menuItemClass;
            li.textContent = item.label;
            li.addEventListener("click", () => {
                item.action();
                this.hide();
            });
            ul.appendChild(li);
        });

        this.menuElement.appendChild(ul);
        document.body.appendChild(this.menuElement);
    }
}

export { ContextMenuManager };
