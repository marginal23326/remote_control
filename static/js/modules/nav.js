// static/js/modules/nav.js
let activeSectionId = "streamSection";
let isInitialized = false;

let cachedSections = [];
let cachedNavLinks = [];
let cachedNavContainer = null;

function syncStateFromHash() {
    const hash = window.location.hash.substring(1);
    if (hash && document.getElementById(hash)?.classList.contains("section")) {
        activeSectionId = hash;
        return true;
    }
    return false;
}

function showSection(sectionId) {
    cachedSections.forEach((section) => {
        if (section.id === sectionId) {
            section.classList.remove("hidden");
            section.style.animation = "none";
            void section.offsetHeight; // triggers reflow
            section.style.animation = null;
        } else {
            section.classList.add("hidden");
        }
    });

    window.dispatchEvent(new CustomEvent("sectionchange", { detail: { activeSectionId: sectionId } }));
}

function updateActiveNavLink(activeLinkId) {
    cachedNavLinks.forEach((link) => {
        const isActive = link.getAttribute("href") === `#${activeLinkId}`;
        link.classList.toggle("active", isActive);
        link.classList.toggle("text-blue-400", isActive);
        link.classList.toggle("bg-blue-500/10", isActive);
    });
    updateOverflowIndicators();
}

function updateOverflowIndicators() {
    if (!cachedNavContainer) return;

    const isOverflowing = cachedNavContainer.scrollWidth > cachedNavContainer.clientWidth;
    const isAtStart = cachedNavContainer.scrollLeft === 0;
    const isAtEnd =
        Math.abs(cachedNavContainer.scrollLeft + cachedNavContainer.clientWidth - cachedNavContainer.scrollWidth) < 1;

    cachedNavContainer.parentElement.classList.toggle("mask-start", isOverflowing && !isAtStart);
    cachedNavContainer.parentElement.classList.toggle("mask-end", isOverflowing && !isAtEnd);
}

function initializeNavigation(isAuthenticated = true) {
    if (!isInitialized) {
        cachedSections = document.querySelectorAll(".section");
        cachedNavLinks = document.querySelectorAll(".nav-link");
        cachedNavContainer = document.querySelector("nav .overflow-x-auto");

        syncStateFromHash();

        cachedNavLinks.forEach((link) => {
            link.addEventListener("click", (event) => {
                event.preventDefault();
                activeSectionId = link.getAttribute("href").substring(1);
                window.location.hash = activeSectionId;
                updateActiveNavLink(activeSectionId);
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
    } else {
        if (isAuthenticated) {
            window.dispatchEvent(
                new CustomEvent("sectionchange", {
                    detail: { activeSectionId: activeSectionId },
                }),
            );
        }
    }
}

export { initializeNavigation };
