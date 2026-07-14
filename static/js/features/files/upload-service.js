function uploadFiles(path, files, { onProgress } = {}) {
    const formData = new FormData();
    Array.from(files).forEach((file) => formData.append("files", file));

    const xhr = new XMLHttpRequest();
    const encodedPath = encodeURIComponent(path);

    const promise = new Promise((resolve, reject) => {
        xhr.open("POST", `/api/upload?path=${encodedPath}`, true);

        xhr.upload.onprogress = (e) => {
            if (e.lengthComputable && onProgress) {
                onProgress(Math.round((e.loaded / e.total) * 100));
            }
        };

        xhr.onload = () => {
            if (xhr.status === 401) {
                window.location.href = "/login";
                return reject(new Error("Unauthorized"));
            }
            try {
                const data = JSON.parse(xhr.responseText);
                if (xhr.status >= 200 && xhr.status < 300) {
                    resolve(data);
                } else {
                    reject(new Error(data.message || `Upload failed: ${xhr.status}`));
                }
            } catch {
                reject(new Error(`HTTP error! status: ${xhr.status}`));
            }
        };

        xhr.onerror = () => reject(new Error("Network Error"));
        xhr.onabort = () => reject(new DOMException("Upload cancelled", "AbortError"));
        xhr.send(formData);
    });

    return { promise, xhr };
}

export { uploadFiles };
