export interface ContextMenuItem {
    label: string;
    action: () => void;
}

export interface ContextMenuConfig<TContext = unknown> {
    menuClass?: string;
    menuItemClass?: string;
    getMenuItems?: (context?: TContext) => ContextMenuItem[];
}

interface ResolvedContextMenuConfig<TContext> {
    menuClass: string;
    menuItemClass: string;
    getMenuItems: (context?: TContext) => ContextMenuItem[];
}

export class ContextMenuManager<TContext = unknown> {
    private menuElement: HTMLDivElement | null = null;
    private readonly config: ResolvedContextMenuConfig<TContext>;

    constructor(config: ContextMenuConfig<TContext>) {
        this.config = {
            getMenuItems: () => [],
            menuClass: "context-menu",
            menuItemClass:
                "px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100 rounded-md cursor-pointer select-none transition-colors",
            ...config,
        };
    }

    hide(): void {
        if (this.menuElement) {
            this.menuElement.remove();
            this.menuElement = null;
        }
    }

    show(x: number, y: number, context?: TContext): void {
        this.hide();

        const items = this.config.getMenuItems(context);
        if (items.length === 0) return;

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
            ul.append(li);
        });

        this.menuElement.append(ul);
        document.body.append(this.menuElement);
    }
}
