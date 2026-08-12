import { showNotification, withErrorNotification } from "./feedback";
import type { ApiMessageResponse } from "./types";

interface ApiErrorBody {
    message?: string;
}

export function parseApiResult<T = unknown>(status: number, rawBody: string): T {
    if (status < 200 || status >= 300) {
        let message = `HTTP error! status: ${status}`;
        try {
            message = (JSON.parse(rawBody) as ApiErrorBody).message ?? message;
        } catch {}
        throw new Error(message);
    }
    return JSON.parse(rawBody) as T;
}

export async function apiCall<T = unknown>(endpoint: string, method: string = "GET", data: unknown = null): Promise<T> {
    const options: RequestInit = {
        headers: {},
        method,
    };
    if (data) {
        if (data instanceof FormData) {
            options.body = data;
        } else {
            (options.headers as Record<string, string>)["Content-Type"] = "application/json";
            options.body = JSON.stringify(data);
        }
    }

    const response = await fetch(endpoint, options);

    if (response.status === 401) {
        window.location.href = "/login";
        // no caller, or its catch, should run after this
        await new Promise<never>(() => {});
    }

    return parseApiResult<T>(response.status, await response.text());
}

export async function apiCallWithFeedback(
    endpoint: string,
    method: string,
    data: unknown,
    successCallback?: (response: ApiMessageResponse) => void | Promise<void>,
): Promise<void> {
    await withErrorNotification(async () => {
        const response = await apiCall<ApiMessageResponse>(endpoint, method, data);
        if (response.message) showNotification(response.message, "info");
        await successCallback?.(response);
    }, "Error");
}
