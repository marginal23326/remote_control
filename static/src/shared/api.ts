interface ApiErrorBody {
    message?: string;
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

    if (!response.ok) {
        const contentType = response.headers.get("content-type");
        if (contentType && contentType.includes("application/json")) {
            const errData = (await response.json()) as ApiErrorBody;
            throw new Error(errData.message ?? `API Error: ${response.status}`);
        }
        throw new Error(`HTTP error! status: ${response.status}`);
    }

    return response.json() as T;
}
