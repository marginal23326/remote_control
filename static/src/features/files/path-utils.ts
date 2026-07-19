export function getSeparator(path: string): "\\" | "/" {
    return path.includes("\\") ? "\\" : "/";
}

export function joinPath(parent: string, child: string): string {
    const sep = getSeparator(parent);
    return parent.endsWith(sep) ? `${parent}${child}` : `${parent}${sep}${child}`;
}

export function getParentPath(path: string): string {
    if (/^[A-Z]:\\$/iu.test(path) || path === "/") return "";

    const cleaned = path.replace(/[\\/]$/u, "");
    const lastSep = Math.max(cleaned.lastIndexOf("/"), cleaned.lastIndexOf("\\"));
    if (lastSep <= 0) return "/";

    const parent = cleaned.slice(0, lastSep);
    return /^[A-Z]:$/iu.test(parent) ? `${parent}\\` : parent;
}
