import { byId } from "@/shared/dom-helpers";

let activeSectionId = "streamSection";
let isInitialized = false;

let cachedSections: NodeListOf<HTMLElement> | HTMLElement[] = [];
let cachedNavLinks: NodeListOf<HTMLAnchorElement> | HTMLAnchorElement[] = [];
let cachedNavContainer: HTMLElement | null = null;

function syncStateFromHash(): boolean {
    const hash = window.location.hash.slice(1);
    if (hash && byId(hash)?.classList.contains("section")) {
        activeSectionId = hash;
        return true;
    }
    return false;
}

function showSection(sectionId: string): void {
    cachedSections.forEach((section) => {
        if (section.id === sectionId) {
            section.classList.remove("hidden");
            section.style.animation = "none";
            void section.offsetHeight;
            section.style.animation = "";
        } else {
            section.classList.add("hidden");
        }
    });

    window.dispatchEvent(new CustomEvent("sectionchange", { detail: { activeSectionId: sectionId } }));
}

function updateActiveNavLink(activeLinkId: string): void {
    cachedNavLinks.forEach((link) => {
        const isActive = link.getAttribute("href") === `#${activeLinkId}`;
        link.classList.toggle("active", isActive);
    });
    updateOverflowIndicators();
}

function updateOverflowIndicators(): void {
    if (!cachedNavContainer) return;

    const isOverflowing = cachedNavContainer.scrollWidth > cachedNavContainer.clientWidth;
    const isAtStart = cachedNavContainer.scrollLeft === 0;
    const isAtEnd =
        Math.abs(cachedNavContainer.scrollLeft + cachedNavContainer.clientWidth - cachedNavContainer.scrollWidth) < 1;

    cachedNavContainer.parentElement!.classList.toggle("mask-start", isOverflowing && !isAtStart);
    cachedNavContainer.parentElement!.classList.toggle("mask-end", isOverflowing && !isAtEnd);
}

export function initializeNavigation(isAuthenticated = true): void {
    if (isInitialized) {
        if (isAuthenticated) {
            window.dispatchEvent(
                new CustomEvent("sectionchange", {
                    detail: { activeSectionId },
                }),
            );
        }
    } else {
        cachedSections = document.querySelectorAll<HTMLElement>(".section");
        cachedNavLinks = document.querySelectorAll<HTMLAnchorElement>(".nav-link");
        cachedNavContainer = document.querySelector<HTMLElement>("nav .overflow-x-auto");

        syncStateFromHash();

        cachedNavLinks.forEach((link) => {
            link.addEventListener("click", (event) => {
                event.preventDefault();
                activeSectionId = link.getAttribute("href")!.slice(1);
                window.location.hash = activeSectionId;
            });
        });

        window.addEventListener("hashchange", () => {
            if (syncStateFromHash()) {
                showSection(activeSectionId);
                updateActiveNavLink(activeSectionId);
            }
        });

        if (cachedNavContainer) {
            cachedNavContainer.addEventListener("scroll", updateOverflowIndicators);
            window.addEventListener("resize", updateOverflowIndicators);
            setTimeout(updateOverflowIndicators, 100);
        }

        isInitialized = true;

        if (isAuthenticated) {
            showSection(activeSectionId);
            updateActiveNavLink(activeSectionId);
        }
    }
}
