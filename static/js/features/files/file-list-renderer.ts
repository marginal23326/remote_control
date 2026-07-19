import { SVG_TEMPLATES } from "@/shared/icons";
import { CLASSES } from "@/shared/list-manager";
import type { RenderableFileItem } from "@/shared/types";

export interface VisibleRangeParams {
    scrollTop: number;
    containerHeight: number;
    rowHeight: number;
    totalItems: number;
    buffer: number;
}

export interface VisibleRange {
    startIndex: number;
    endIndex: number;
}

export function computeVisibleRange({
    scrollTop,
    containerHeight,
    rowHeight,
    totalItems,
    buffer,
}: VisibleRangeParams): VisibleRange {
    let startIndex = Math.floor(scrollTop / rowHeight) - buffer;
    let endIndex = Math.floor((scrollTop + containerHeight) / rowHeight) + buffer;

    startIndex = Math.max(0, startIndex);
    endIndex = Math.min(totalItems, endIndex);

    return { endIndex, startIndex };
}

function renderItemNameCell(item: RenderableFileItem): string {
    const icon = item.is_dir ? SVG_TEMPLATES.folder("text-blue-400") : SVG_TEMPLATES.file();
    return `<div class="flex items-center gap-2 truncate overflow-hidden">${icon}<span class="truncate block w-full" title="${item._safeName}">${item._safeName}</span></div>`;
}

export function renderFileRow(
    item: RenderableFileItem,
    { rowHeight, selectedCls, accessCls }: { rowHeight: number; selectedCls: string; accessCls: string },
): string {
    return `<tr data-path="${item._safePath}" data-is-dir="${item.is_dir}" data-name="${item._safeName}" class="${CLASSES.row} ${selectedCls} ${accessCls}" style="height: ${rowHeight}px">
        <td class="px-4 py-1 whitespace-nowrap w-full">${renderItemNameCell(item)}</td>
        <td class="px-4 py-1 whitespace-nowrap hidden sm:table-cell text-zinc-400">${item._formattedSize}</td>
        <td class="px-4 py-1 whitespace-nowrap hidden md:table-cell text-zinc-400">${item._formattedDate}</td>
    </tr>`;
}

export function renderSpacerRow(height: number): string {
    return `<tr style="height: ${height}px" class="virtual-spacer"><td colspan="3" style="padding:0; border:0; height: ${height}px"></td></tr>`;
}

export function renderEmptyRow(): string {
    return `<tr><td colspan="3" class="px-4 py-1 whitespace-nowrap"><div class="text-center text-zinc-500 text-sm py-8 font-mono">Directory is empty</div></td></tr>`;
}
