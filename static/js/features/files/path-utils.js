function getSeparator(path) {
    return path.includes("\\") ? "\\" : "/";
}

function joinPath(parent, child) {
    const sep = getSeparator(parent);
    return parent.endsWith(sep) ? `${parent}${child}` : `${parent}${sep}${child}`;
}

function getParentPath(path) {
    if (/^[A-Z]:\\$/i.test(path) || path === "/") return "";

    const cleaned = path.replace(/[\\/]$/, "");
    const lastSep = Math.max(cleaned.lastIndexOf("/"), cleaned.lastIndexOf("\\"));
    if (lastSep <= 0) return "/";

    const parent = cleaned.substring(0, lastSep);
    return /^[A-Z]:$/i.test(parent) ? parent + "\\" : parent;
}

export { getSeparator, joinPath, getParentPath };
