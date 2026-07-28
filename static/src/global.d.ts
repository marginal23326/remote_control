export {};

declare global {
    interface WindowEventMap {
        sectionchange: CustomEvent<{ activeSectionId: string }>;
    }
}
