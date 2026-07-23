import { streamUI } from "./view";

export interface StreamDimensions {
    container: DOMRect;
    streamWidth: number;
    streamHeight: number;
    offsetX: number;
    offsetY: number;
    scaleX: number;
    scaleY: number;
    nativeWidth: number;
    nativeHeight: number;
}

let nativeWidth: number | null = null;
let nativeHeight: number | null = null;
let cachedDimensions: StreamDimensions | null = null;

export function setNativeDimensions(width: number, height: number): void {
    nativeWidth = width;
    nativeHeight = height;
    cachedDimensions = null;
}

export function getNativeDimensions(): { width: number | null; height: number | null } {
    return { height: nativeHeight, width: nativeWidth };
}

export function invalidateDimensionsCache(): void {
    cachedDimensions = null;
}

export function calculateStreamDimensions(): StreamDimensions {
    if (cachedDimensions) return cachedDimensions;

    const w = nativeWidth || streamUI.view.videoWidth || 1920;
    const h = nativeHeight || streamUI.view.videoHeight || 1080;
    const container = streamUI.container.getBoundingClientRect();

    const containerAspect = container.width / container.height;
    const streamAspect = w / h;

    let streamHeight: number, streamWidth: number;

    if (containerAspect > streamAspect) {
        streamHeight = container.height;
        streamWidth = container.height * streamAspect;
    } else {
        streamWidth = container.width;
        streamHeight = container.width / streamAspect;
    }

    const offsetX = (container.width - streamWidth) / 2;
    const offsetY = (container.height - streamHeight) / 2;

    cachedDimensions = {
        container,
        nativeHeight: h,
        nativeWidth: w,
        offsetX,
        offsetY,
        scaleX: w / streamWidth,
        scaleY: h / streamHeight,
        streamHeight,
        streamWidth,
    };

    return cachedDimensions;
}
