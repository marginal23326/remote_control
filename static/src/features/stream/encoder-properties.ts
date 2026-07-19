import { escapeHtml } from "@/shared/dom-helpers";
import { showNotification } from "@/shared/feedback";
import { showPromptModal } from "@/shared/modal";
import type { EncoderPropertyConstraint } from "@/shared/types";

let encoderProperties: Record<string, string> = {};
let encoderPropertyConstraints: Record<string, EncoderPropertyConstraint> = {};

export function setEncoderPropertyConstraints(constraints: Record<string, EncoderPropertyConstraint>): void {
    encoderPropertyConstraints = { ...constraints };
}

export function setEncoderProperties(props: Record<string, string>): void {
    encoderProperties = { ...props };
    renderEncoderProperties();
}

function renderEncoderProperties(): void {
    const tbody = document.getElementById("encoderPropsList");
    if (!tbody) return;
    tbody.innerHTML = "";

    const inputCls = "text-xs font-mono text-zinc-200 w-full";

    const sortedEntries = Object.entries(encoderProperties).toSorted((a, b) => a[0].localeCompare(b[0]));
    for (const [key, value] of sortedEntries) {
        const row = document.createElement("tr");
        row.className = "group";
        const constraint = encoderPropertyConstraints[key];
        let valHtml: string;

        if (constraint) {
            if (constraint.value_type === "enum") {
                const options = (constraint.enum_values ?? [])
                    .map((v) => `<option value="${v}" ${v === value ? "selected" : ""}>${v}</option>`)
                    .join("");
                valHtml = `<select class="prop-val w-full bg-zinc-900 border border-zinc-800 hover:border-zinc-700 focus:border-zinc-500 rounded text-xs font-mono text-zinc-200 transition-colors">${options}</select>`;
            } else if (constraint.value_type === "int") {
                valHtml = `<input type="number" class="prop-val ${inputCls}" value="${escapeHtml(value)}"${constraint.min === undefined ? "" : ` min="${constraint.min}"`}${constraint.max === undefined ? "" : ` max="${constraint.max}"`}>`;
            } else if (constraint.value_type === "bool") {
                const checked = value === "true" ? "checked" : "";
                valHtml = `<input type="checkbox" class="prop-val w-4 h-4 accent-zinc-100 bg-zinc-950 border-zinc-800 rounded focus:ring-0 mt-1 cursor-pointer" ${checked}>`;
            } else {
                valHtml = `<input type="text" class="prop-val ${inputCls}" value="${escapeHtml(value)}">`;
            }
        } else {
            valHtml = `<input type="text" class="prop-val ${inputCls}" value="${escapeHtml(value)}">`;
        }

        row.innerHTML = `
            <td class="py-1.5 pr-2"><input type="text" class="prop-key ${inputCls}" value="${escapeHtml(key)}"></td>
            <td class="py-1.5 pr-2">${valHtml}</td>
            <td class="py-1.5"><button class="prop-remove px-1.5 py-0.5 text-sm text-zinc-500 hover:text-red-400 opacity-0 group-hover:opacity-100" title="Remove property">&times;</button></td>
        `;

        attachEncoderRowListeners(row, key);
        tbody.append(row);
    }
}

function attachEncoderRowListeners(row: HTMLTableRowElement, key: string): void {
    row.querySelector(".prop-remove")!.addEventListener("click", () => {
        delete encoderProperties[key];
        renderEncoderProperties();
    });

    row.querySelector(".prop-key")!.addEventListener("change", (e) => {
        const newKey = (e.target as HTMLInputElement).value.trim();
        if (newKey && newKey !== key) {
            delete encoderProperties[key];
            encoderProperties[newKey] = getRowValue(row);
            renderEncoderProperties();
        }
    });

    const valInput = row.querySelector<HTMLInputElement | HTMLSelectElement>(".prop-val");
    if (valInput && valInput.tagName === "INPUT") {
        valInput.addEventListener("change", () => {
            encoderProperties[key] = getValFromInput(valInput);
        });
    } else if (valInput && valInput.tagName === "SELECT") {
        valInput.addEventListener("change", () => {
            encoderProperties[key] = valInput.value;
        });
    }
}

function getValFromInput(input: HTMLInputElement | HTMLSelectElement): string {
    if (input.tagName === "SELECT") return input.value;
    if ((input as HTMLInputElement).type === "checkbox") return (input as HTMLInputElement).checked ? "true" : "false";
    if ((input as HTMLInputElement).type === "number" || (input as HTMLInputElement).type === "range")
        return input.value;
    return input.value.trim();
}

function getRowValue(row: HTMLElement): string {
    const input = row.querySelector<HTMLInputElement | HTMLSelectElement>(".prop-val");
    return input ? getValFromInput(input) : "";
}

export function readEncoderPropsFromDOM(): Record<string, string> | null {
    const props: Record<string, string> = {};
    const warnings: string[] = [];
    document.querySelectorAll<HTMLElement>("#encoderPropsList tr").forEach((row) => {
        const key = row.querySelector<HTMLInputElement>(".prop-key")?.value?.trim();
        if (!key) return;
        const valInput = row.querySelector<HTMLInputElement | HTMLSelectElement>(".prop-val");
        if (!valInput) return;
        let val = getValFromInput(valInput);
        if (!val && (valInput as HTMLInputElement).type !== "checkbox") return;
        const constraint = encoderPropertyConstraints[key];
        if (constraint) {
            if (constraint.value_type === "int") {
                const num = parseInt(val, 10);
                if (isNaN(num)) {
                    warnings.push(`"${key}": not a valid integer`);
                    return;
                }
                if (constraint.min !== undefined && num < constraint.min) {
                    warnings.push(`"${key}": ${num} is below minimum ${constraint.min}`);
                    return;
                }
                if (constraint.max !== undefined && num > constraint.max) {
                    warnings.push(`"${key}": ${num} exceeds maximum ${constraint.max}`);
                    return;
                }
                val = String(num);
            } else if (constraint.value_type === "enum") {
                if (!constraint.enum_values || !constraint.enum_values.includes(val)) {
                    warnings.push(`"${key}": "${val}" is not a valid option`);
                    return;
                }
            } else if (constraint.value_type === "bool") {
                val = val === "true" ? "true" : "false";
            }
        }
        props[key] = val;
    });
    encoderProperties = props;
    if (warnings.length > 0) {
        showNotification(warnings.join("\n"), "error");
        return null;
    }
    return props;
}

document.addEventListener("DOMContentLoaded", () => {
    const toggle = document.getElementById("advancedToggle");
    const panel = document.getElementById("advancedSettingsPanel");
    const icon = document.getElementById("advancedToggleIcon");
    if (toggle && panel) {
        toggle.addEventListener("click", () => {
            panel.classList.toggle("expanded");
            icon!.classList.toggle("-rotate-180");
        });
    }

    const addBtn = document.getElementById("addEncoderProp");
    if (addBtn) {
        addBtn.addEventListener("click", async () => {
            const knownKeys = Object.keys(encoderPropertyConstraints);
            const addedKeys = Object.keys(encoderProperties);
            const available = knownKeys.filter((k) => !addedKeys.includes(k));
            if (available.length === 0) {
                const key = await showPromptModal({ title: "Enter property name" });
                if (key) {
                    encoderProperties[key] = "";
                    renderEncoderProperties();
                }
                return;
            }
            const container = addBtn.parentElement!;
            const existing = document.getElementById("addPropRow");
            if (existing) existing.remove();
            const row = document.createElement("div");
            row.id = "addPropRow";
            row.className = "flex gap-2 items-center mt-2 pt-2 border-t border-zinc-800/50";
            row.innerHTML = `
                <select id="addPropSelect" class="flex-1 px-2 py-1 bg-zinc-950 border border-zinc-800 rounded text-xs font-mono text-zinc-200">
                    ${available.map((k) => `<option value="${k}">${k}</option>`).join("")}
                </select>
                <button id="confirmAddProp" class="px-2 py-1 text-xs rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-100 border border-zinc-700 transition-colors font-medium">Add</button>
                <button id="cancelAddProp" class="px-2 py-1 text-xs rounded text-zinc-500 hover:text-zinc-200 transition-colors">Cancel</button>
            `;
            container.append(row);
            document.getElementById("confirmAddProp")!.addEventListener("click", () => {
                const k = (document.getElementById("addPropSelect") as HTMLSelectElement).value;
                encoderProperties[k] = encoderPropertyConstraints[k]?.value_type === "bool" ? "false" : "";
                renderEncoderProperties();
                row.remove();
            });
            document.getElementById("cancelAddProp")!.addEventListener("click", () => {
                row.remove();
            });
        });
    }
});
