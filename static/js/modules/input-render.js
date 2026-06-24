// static/js/modules/input-render.js

const CLIPBOARD_KEYS = [
    { label: "Copy", key: "copy" },
    { label: "Paste", key: "paste" },
    { label: "Cut", key: "cut" },
    { label: "Undo", key: "undo" },
];

const SYSTEM_KEYS = [
    { label: "ESC", key: "escape" },
    { label: "TAB", key: "tab" },
    { label: "BKSP", key: "backspace" },
    { label: "DEL", key: "delete" },
    { label: "ENTER", key: "enter" },
    { label: "SPACE", key: "space" },
];

const MODIFIERS = [
    { label: "CTRL", modifier: "ctrl" },
    { label: "WIN", modifier: "win" },
    { label: "ALT", modifier: "alt" },
    { label: "SHIFT", modifier: "shift" },
];

const NAV_ROWS = [
    [{ key: "up", svgPath: "M5 10l7-7m0 0l7 7m-7-7v18" }],
    [
        { key: "left", svgPath: "M10 19l-7-7m0 0l7-7m-7 7h18" },
        { key: "down", svgPath: "M19 14l-7 7m0 0l-7-7m7 7V3" },
        { key: "right", svgPath: "M14 5l7 7m0 0l-7 7m7-7H3" },
    ],
];

const CLS = {
    tile: "bg-[#0f1115]/80 rounded-xl p-4 border border-white/5 shadow-md flex flex-col",
    label: "text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-3 flex-shrink-0",
    subLabel: "text-[9px] font-bold text-gray-500 uppercase tracking-widest mb-1.5",
};

const BTN =
    "bg-[#18191e] border border-white/10 text-gray-400 " +
    "hover:bg-[#25272e] hover:text-white hover:border-white/20 " +
    "active:shadow-none transition-all flex items-center justify-center select-none cursor-pointer";

const BTN_BASE =
    BTN +
    " action-btn h-[34px] px-1 rounded " +
    "text-[10px] font-mono font-bold " +
    "shadow-[0_2px_0_rgba(0,0,0,0.6)] active:translate-y-[2px]";

const BTN_ARROW =
    BTN + " action-btn w-[40px] h-[40px] rounded-lg " + "shadow-[0_3px_0_rgba(0,0,0,0.6)] active:translate-y-[3px]";

function el(tag, cls = "", attrs = {}) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    for (const [k, v] of Object.entries(attrs)) {
        if (k === "id") node.id = v;
        else if (k.startsWith("data-")) node.dataset[k.slice(5)] = v;
        else node.setAttribute(k, v);
    }
    return node;
}

function makeTile(labelText, flexContentCls = "flex flex-col", wrapExtraCls = "") {
    const wrap = el("div", `${CLS.tile} ${wrapExtraCls}`.trim());
    if (labelText) {
        const p = el("p", CLS.label);
        p.textContent = labelText;
        wrap.append(p);
    }
    const inner = el("div", flexContentCls);
    wrap.append(inner);
    return { wrap, inner };
}

function makeSubGroup(labelText, contentNode, extraCls = "") {
    const wrap = el("div", "flex flex-col " + extraCls);
    const lbl = el("div", CLS.subLabel);
    lbl.textContent = labelText;
    wrap.append(lbl, contentNode);
    return wrap;
}

function makeKeyGrid(keys, btnCls, colsClass = "grid-cols-4") {
    const grid = el("div", `grid ${colsClass} gap-1.5`);
    for (const { label, key } of keys) {
        const btn = el("button", btnCls, { "data-key": key });
        btn.textContent = label;
        grid.append(btn);
    }
    return grid;
}

function makeArrowSVG(pathData) {
    const d = document.createElement("div");
    d.innerHTML = `<svg class="w-4 h-4 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="${pathData}"/></svg>`;
    return d.firstElementChild;
}

const TILE_BUILDERS = {
    tileCommandCenter: () => {
        const { wrap, inner } = makeTile(
            "Command & Control",
            "flex flex-col justify-between gap-4 h-full",
            "flex-[1.2] min-w-[300px]",
        );

        const modHeader = el("div", "flex items-center justify-between mb-2");
        const modLabel = el("div", CLS.subLabel);
        modLabel.textContent = "Modifiers";

        const toggleLabel = el("label", "flex items-center gap-1.5 cursor-pointer select-none");
        const toggleInput = el("input", "hidden peer", { id: "stickyToggle", type: "checkbox" });
        toggleLabel.innerHTML = `
            <span class="text-[8px] font-extrabold text-gray-500 peer-checked:text-blue-400 font-sans uppercase tracking-widest transition-colors">Sticky</span>
            <span class="relative w-7 h-4 rounded-full bg-[#141517] border border-white/5 transition-colors peer-checked:bg-blue-600/30 peer-checked:border-blue-500/30
                after:absolute after:top-[2px] after:left-[2px] after:w-2.5 after:h-2.5 after:bg-gray-500 after:rounded-full after:transition-all
                peer-checked:after:translate-x-3.5 peer-checked:after:bg-blue-400"></span>
        `;
        toggleLabel.insertBefore(toggleInput, toggleLabel.firstChild);
        modHeader.append(modLabel, toggleLabel);

        const modGrid = el("div", "grid grid-cols-4 gap-1.5", { id: "modifierContainer" });
        for (const { label, modifier } of MODIFIERS) {
            const btn = el(
                "button",
                BTN_BASE +
                    " modifier-btn data-[active=true]:translate-y-[2px] data-[active=true]:shadow-none data-[active=true]:bg-blue-600/20 data-[active=true]:text-blue-400 data-[active=true]:border-blue-500/50",
                { "data-modifier": modifier },
            );
            btn.innerHTML = `<span class="flex items-center gap-1.5"><span class="mod-led w-1.5 h-1.5 rounded-full bg-gray-700/50 transition-all duration-150 hidden"></span>${label}</span>`;
            modGrid.append(btn);
        }

        const sysGrid = makeKeyGrid(SYSTEM_KEYS, BTN_BASE, "grid-cols-3 sm:grid-cols-6");

        const row = el("div", "flex gap-1.5 w-full");
        const input = el(
            "input",
            "flex-1 min-w-0 h-[34px] px-2.5 bg-[#0a0a0c] border border-gray-700 rounded text-gray-200 font-mono text-[11px] focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30 transition-all placeholder-gray-600 shadow-inner",
            { id: "customKey", type: "text", placeholder: "e.g. f12, del, alt+f4" },
        );
        const execBtn = el(
            "button",
            "w-[60px] h-[34px] px-2 bg-blue-600/15 hover:bg-blue-600/25 text-blue-400 border border-blue-500/30 rounded font-bold font-mono text-[10px] tracking-wider transition-all flex-shrink-0 shadow-[0_2px_0_rgba(0,0,0,0.6)] active:translate-y-[2px] active:shadow-none",
            { id: "sendCustomShortcut" },
        );
        execBtn.textContent = "EXEC";
        row.append(input, execBtn);

        const modWrapper = el("div", "flex flex-col");
        modWrapper.append(modHeader, modGrid);

        inner.append(modWrapper, makeSubGroup("System Keys", sysGrid), makeSubGroup("Custom Stroke", row));
        return wrap;
    },
    tileNavActions: () => {
        const { wrap, inner } = makeTile(
            "Actions & Navigation",
            "flex flex-col h-full gap-4",
            "flex-[0.8] min-w-[250px]",
        );

        const clipGrid = makeKeyGrid(CLIPBOARD_KEYS, BTN_BASE, "grid-cols-4");

        const crossWrap = el("div", "flex-1 flex items-center justify-center min-h-[90px]");
        const cross = el("div", "flex flex-col items-center gap-1.5");
        for (const rowKeys of NAV_ROWS) {
            const rowDiv = el("div", "flex gap-1.5");
            for (const { key, svgPath } of rowKeys) {
                const btn = el("button", BTN_ARROW, { "data-key": key });
                btn.append(makeArrowSVG(svgPath));
                rowDiv.append(btn);
            }
            cross.append(rowDiv);
        }
        crossWrap.append(cross);

        inner.append(makeSubGroup("Quick Macros", clipGrid), makeSubGroup("Directional", crossWrap, "flex-1"));
        return wrap;
    },
    tileText: () => {
        const { wrap, inner } = makeTile("Text Injection", "flex flex-col sm:flex-row gap-2 w-full", "w-full");
        const textarea = el(
            "textarea",
            "flex-1 p-2.5 min-h-[40px] h-[40px] rounded bg-[#0a0a0c] border border-gray-700 text-gray-200 font-mono text-[12px] focus:border-orange-500 focus:ring-1 focus:ring-orange-500/30 transition-all resize-y placeholder-gray-600 shadow-inner hide-scrollbar",
            { id: "textInput", placeholder: ">> Type sequence to transmit... (Ctrl+Enter)" },
        );
        const txBtn = el(
            "button",
            "sm:w-[80px] h-[40px] bg-orange-600/15 hover:bg-orange-600/25 text-orange-400 border border-orange-500/30 rounded font-bold font-mono text-[12px] tracking-widest transition-all uppercase shadow-[0_2px_0_rgba(0,0,0,0.6)] hover:shadow-[0_2px_0_rgba(0,0,0,0.6),0_0_12px_rgba(249,115,22,0.15)] active:translate-y-[2px] active:shadow-none flex items-center justify-center gap-1.5 shrink-0",
            { id: "sendText" },
        );
        txBtn.innerHTML = `TX <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"/></svg>`;
        inner.append(textarea, txBtn);
        return wrap;
    },
};

export function renderInputSection() {
    for (const [id, builder] of Object.entries(TILE_BUILDERS)) {
        const placeholder = document.getElementById(id);
        if (placeholder) {
            placeholder.replaceWith(Object.assign(builder(), { id }));
        }
    }
}
