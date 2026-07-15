export {};

declare global {
    interface HTMLElement {
        webkitRequestFullscreen?: () => Promise<void> | void;
    }

    interface Document {
        webkitExitFullscreen?: () => Promise<void> | void;
        webkitFullscreenElement?: Element | null;
    }

    interface WindowEventMap {
        sectionchange: CustomEvent<{ activeSectionId: string }>;
    }
}
