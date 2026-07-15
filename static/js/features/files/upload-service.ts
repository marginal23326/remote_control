import type { UploadResponse } from "@/shared/types.ts";

export interface UploadFilesOptions {
    onProgress?: (percent: number) => void;
}

export interface UploadHandle {
    promise: Promise<UploadResponse>;
    xhr: XMLHttpRequest;
}

export function uploadFiles(
    path: string,
    files: FileList | File[],
    { onProgress }: UploadFilesOptions = {},
): UploadHandle {
    const formData = new FormData();
    [...files].forEach((file) => {
        formData.append("files", file);
    });

    const xhr = new XMLHttpRequest();
    const encodedPath = encodeURIComponent(path);

    const promise = new Promise<UploadResponse>((resolve, reject) => {
        xhr.open("POST", `/api/upload?path=${encodedPath}`, true);

        xhr.upload.addEventListener("progress", (e) => {
            if (e.lengthComputable && onProgress) {
                onProgress(Math.round((e.loaded / e.total) * 100));
            }
        });

        xhr.addEventListener("load", () => {
            if (xhr.status === 401) {
                window.location.href = "/login";
                reject(new Error("Unauthorized"));
                return;
            }
            try {
                const data = JSON.parse(xhr.responseText) as UploadResponse;
                if (xhr.status >= 200 && xhr.status < 300) {
                    resolve(data);
                } else {
                    reject(new Error(data.message ?? `Upload failed: ${xhr.status}`));
                }
            } catch {
                reject(new Error(`HTTP error! status: ${xhr.status}`));
            }
        });

        xhr.addEventListener("error", () => {
            reject(new Error("Network Error"));
        });
        xhr.addEventListener("abort", () => {
            reject(new DOMException("Upload cancelled", "AbortError"));
        });
        xhr.send(formData);
    });

    return { promise, xhr };
}
