import { streamUI } from "./view";
import { streamState } from "./stream-state";

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

let cachedDimensions: StreamDimensions | null = null;

export function setNativeDimensions(width: number, height: number): void {
    streamState.nativeWidth = width;
    streamState.nativeHeight = height;
    cachedDimensions = null;
}

export function invalidateDimensionsCache(): void {
    cachedDimensions = null;
}

export function calculateStreamDimensions(): StreamDimensions {
    if (cachedDimensions) return cachedDimensions;

    const w = streamState.nativeWidth || streamUI.view.videoWidth || 1920;
    const h = streamState.nativeHeight || streamUI.view.videoHeight || 1080;
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
