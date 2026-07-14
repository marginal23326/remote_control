import { streamUI } from "./view.js";

let nativeWidth = null;
let nativeHeight = null;
let cachedDimensions = null;

function setNativeDimensions(width, height) {
    nativeWidth = width;
    nativeHeight = height;
    streamUI.nativeWidth = width;
    streamUI.nativeHeight = height;
    cachedDimensions = null;
}

function getNativeDimensions() {
    return { width: nativeWidth, height: nativeHeight };
}

function invalidateDimensionsCache() {
    cachedDimensions = null;
}

function calculateStreamDimensions() {
    if (cachedDimensions) return cachedDimensions;

    const w = nativeWidth || streamUI.view.videoWidth || 1920;
    const h = nativeHeight || streamUI.view.videoHeight || 1080;
    const container = streamUI.container.getBoundingClientRect();

    const containerAspect = container.width / container.height;
    const streamAspect = w / h;

    let streamWidth, streamHeight;

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
        streamWidth,
        streamHeight,
        offsetX,
        offsetY,
        scaleX: w / streamWidth,
        scaleY: h / streamHeight,
        nativeWidth: w,
        nativeHeight: h,
    };

    return cachedDimensions;
}

export { calculateStreamDimensions, setNativeDimensions, getNativeDimensions, invalidateDimensionsCache };
