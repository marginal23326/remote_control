async function apiCall(endpoint, method = "GET", data = null) {
    const options = {
        method,
        headers: {},
    };
    if (data) {
        if (data instanceof FormData) {
            options.body = data;
        } else {
            options.headers["Content-Type"] = "application/json";
            options.body = JSON.stringify(data);
        }
    }

    const response = await fetch(endpoint, options);

    if (response.status === 401) {
        window.location.href = "/login";
        await new Promise(() => {});
    }

    if (!response.ok) {
        const contentType = response.headers.get("content-type");
        if (contentType && contentType.includes("application/json")) {
            const errData = await response.json();
            throw new Error(errData.message || `API Error: ${response.status}`);
        }
        throw new Error(`HTTP error! status: ${response.status}`);
    }

    return response.json();
}

export { apiCall };
