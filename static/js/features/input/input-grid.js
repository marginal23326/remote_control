// static/js/features/input/input-grid.js

export function renderInputGrids() {
    // Shared button style
    const btnCls =
        "bg-zinc-950 border border-zinc-800 text-zinc-300 hover:bg-zinc-800 hover:text-white rounded-md text-xs font-medium h-8 transition-colors flex items-center justify-center gap-1.5";

    // 1. Modifiers
    const modifiers = [
        { l: "Ctrl", k: "ctrl" },
        { l: "Win", k: "win" },
        { l: "Alt", k: "alt" },
        { l: "Shift", k: "shift" },
    ];
    document.getElementById("modifierGrid").innerHTML = modifiers
        .map(
            (m) =>
                `<button class="modifier-btn ${btnCls} data-[active=true]:bg-zinc-100 data-[active=true]:text-zinc-900" data-modifier="${m.k}">
            <span class="mod-led w-1.5 h-1.5 rounded-full bg-zinc-700 hidden"></span>${m.l}
        </button>`,
        )
        .join("");

    // 2. System Keys
    const sysKeys = [
        { l: "Esc", k: "escape" },
        { l: "Tab", k: "tab" },
        { l: "Bksp", k: "backspace" },
        { l: "Del", k: "delete" },
    ];
    document.getElementById("systemGrid").innerHTML = sysKeys
        .map((k) => `<button class="${btnCls}" data-key="${k.k}">${k.l}</button>`)
        .join("");

    // 3. Navigation / Arrows (D-Pad)
    const icon = (path) =>
        `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="${path}"/></svg>`;
    document.getElementById("navGrid").innerHTML = `
        <div class="flex gap-2">
            <button class="${btnCls} w-10" data-key="up">${icon("M5 10l7-7m0 0l7 7m-7-7v18")}</button>
        </div>
        <div class="flex gap-2">
            <button class="${btnCls} w-10" data-key="left">${icon("M10 19l-7-7m0 0l7-7m-7 7h18")}</button>
            <button class="${btnCls} w-10" data-key="down">${icon("M19 14l-7 7m0 0l-7-7m7 7V3")}</button>
            <button class="${btnCls} w-10" data-key="right">${icon("M14 5l7 7m0 0l-7 7m7-7H3")}</button>
        </div>
    `;
}
