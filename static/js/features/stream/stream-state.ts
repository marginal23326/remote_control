export let streamActive = false;
export let activeStunServer: string | null = null;

export function setStreamActive(value: boolean): void {
    streamActive = value;
}

export function setStunServer(url: string | null): void {
    activeStunServer = url;
}
