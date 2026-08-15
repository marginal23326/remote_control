import { apiCall } from "@/shared/api";
import { byId, escapeHtml, onAsync } from "@/shared/dom-helpers";
import { LoadingButton, runWithFeedback, showNotification } from "@/shared/feedback";
import { SVG_TEMPLATES } from "@/shared/icons";
import { showConfirmModal } from "@/shared/modal";
import type { PowerAction, SystemInfo } from "@/generated/bindings";

function formatUptime(totalSeconds: number): string {
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = Math.floor(totalSeconds % 60);
    return `${days}d : ${hours}h : ${minutes}m : ${seconds}s`;
}

function formatCpuMhz(mhz: number | null): string {
    return mhz === null ? "N/A" : `${(mhz / 1000).toFixed(2)} GHz`;
}

function formatList(items: string[]): string | null {
    return items.length > 0 ? items.join(", ") : null;
}

interface InfoCard {
    title: string;
    icon: string;
    data: [string, string | null | undefined][];
}

async function updateSystemInfo(): Promise<void> {
    const { identity, hardware, network, storage } = await apiCall<SystemInfo>("/api/system");
    const cards: InfoCard[] = [
        {
            data: [
                ["Operating System", identity.os],
                ["Architecture", identity.architecture],
                [
                    "PC / Host / Domain",
                    [identity.pc_name, identity.hostname, identity.domain].filter(Boolean).join(" / "),
                ],
                ["Username", identity.username],
                ["Time & Location", [identity.timezone, identity.country].filter(Boolean).join(" - ")],
                ["Uptime", formatUptime(identity.uptime_seconds)],
            ],
            icon: SVG_TEMPLATES.icon(
                "M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14q2 0 2-2V5q0-2-2-2H5q-2 0-2 2v10q0 2 2 2z",
                "w-4 h-4 shrink-0 text-zinc-400",
            ),
            title: "Identity & OS",
        },
        {
            data: [
                [
                    "Processor",
                    `${hardware.processor?.replace(/\s*@\s*[\d.]+\s*GHz/u, "") ?? "?"} · ${hardware.cpu_base_speed ?? "?"} / ${formatCpuMhz(hardware.cpu_max_speed_mhz)}`,
                ],
                ["Cores / Threads", `${hardware.cpu_cores} / ${hardware.cpu_threads}`],
                ["Memory", `${hardware.memory_total_mb} MB`],
                ["GPU", formatList(hardware.gpu)],
                ["Monitors", formatList(hardware.monitors)],
                ["Battery", hardware.battery],
            ],
            icon: SVG_TEMPLATES.icon(
                "M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10q2 0 2-2V7q0-2-2-2H7q-2 0-2 2v10q0 2 2 2M9 9h6v6H9z",
                "w-4 h-4 shrink-0 text-zinc-400",
            ),
            title: "Hardware",
        },
        {
            data: [
                ["LAN / WAN IP", [network.lan_ip, network.wan_ip].filter(Boolean).join(" / ")],
                ["MAC Address", network.mac_address],
                ["ISP", network.isp ? `${network.isp} ${network.asn ? `(${network.asn})` : ""}` : null],
                ["Antivirus", formatList(network.antivirus)],
                ["Firewall", network.firewall],
            ],
            icon: SVG_TEMPLATES.network(),
            title: "Network & Security",
        },
        {
            data: [
                ["Drives", formatList(storage.disks)],
                [
                    "System Drive",
                    `${storage.system_drive} (${storage.disk_used_gb} GB used of ${storage.disk_total_gb} GB, ${storage.disk_free_gb} GB free)`,
                ],
                ["Active Processes", `${storage.active_processes}`],
            ],
            icon: SVG_TEMPLATES.storage(),
            title: "Storage & Status",
        },
    ];

    byId("systemInfo")!.innerHTML = cards
        .map(
            (c) => `
        <div class="bg-zinc-900 border border-zinc-800 rounded-lg p-4 flex flex-col gap-4 shadow-sm">
            <div class="flex items-center gap-2 text-zinc-100 font-medium pb-3 border-b border-zinc-800/50">
                ${c.icon}
                ${c.title}
            </div>
            <div class="flex flex-col gap-3">
                ${c.data
                    .map(
                        ([k, v]) => `
                    <div>
                        <div class="text-[10px] uppercase tracking-wider font-semibold text-zinc-500 mb-0.5">${k}</div>
                        <div class="text-sm text-zinc-300 break-words leading-tight">${escapeHtml(v ?? "N/A")}</div>
                    </div>
                `,
                    )
                    .join("")}
            </div>
        </div>
    `,
        )
        .join("");
}

const POWER_ACTION_ICON_PATH = "M12 3v9m6-6A9 9 0 1 1 6 6";

interface PowerActionConfig {
    label: string;
    icon: string;
    confirmMessage?: string;
    danger?: boolean;
}

const POWER_ACTIONS: Record<PowerAction, PowerActionConfig> = {
    lock: {
        icon: SVG_TEMPLATES.icon(
            "M12 15v2m-6 4h12a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2M7 9V7a5 5 0 0 1 10 0v2",
            "w-3.5 h-3.5",
        ),
        label: "Lock",
    },
    restart: {
        confirmMessage: "Restart the remote machine? Active sessions will be interrupted.",
        danger: true,
        icon: SVG_TEMPLATES.icon(
            "M16 9h5v0M3 20v-5m0 0h5m-5 0 3 3a8 8 0 0 0 14-4M4 10a8 8 0 0 1 14-4l3 3m0-5v5",
            "w-3.5 h-3.5",
        ),
        label: "Restart",
    },
    shutdown: {
        confirmMessage: "Shut down the remote machine? You'll need physical or Wake-on-LAN access to turn it back on.",
        danger: true,
        icon: SVG_TEMPLATES.icon(POWER_ACTION_ICON_PATH, "w-3.5 h-3.5"),
        label: "Shut Down",
    },
    sleep: {
        confirmMessage: "Put the remote machine to sleep now?",
        icon: SVG_TEMPLATES.icon("M21 13A9 9 0 1 1 11 3a7 7 0 0 0 10 10", "w-3.5 h-3.5"),
        label: "Sleep",
    },
};

function renderPowerCard(): string {
    const buttons = (Object.entries(POWER_ACTIONS) as [PowerAction, PowerActionConfig][])
        .map(([action, { label, icon, danger }]) => {
            const colorClasses = danger
                ? "bg-red-950 hover:bg-red-900 text-red-400"
                : "bg-zinc-800 hover:bg-zinc-700 text-zinc-100";
            return `
                <button type="button" data-power-action="${action}" class="px-3 py-1.5 ${colorClasses} rounded-md text-sm font-medium transition-colors flex items-center gap-1.5">
                    ${icon}
                    ${escapeHtml(label)}
                </button>`;
        })
        .join("");

    return `
        <div class="flex items-center gap-2 text-zinc-100 font-medium pb-3 border-b border-zinc-800/50">
            ${SVG_TEMPLATES.icon(POWER_ACTION_ICON_PATH, "w-4 h-4 shrink-0 text-zinc-400")}
            Power
        </div>
        <div class="flex flex-wrap gap-2">${buttons}</div>
    `;
}

async function runPowerAction(action: PowerAction, button: HTMLButtonElement): Promise<void> {
    const config = POWER_ACTIONS[action];

    if (config.confirmMessage) {
        const confirmed = await showConfirmModal({
            confirmLabel: config.label,
            danger: config.danger ?? false,
            message: config.confirmMessage,
            title: config.label,
        });
        if (!confirmed) return;
    }

    await runWithFeedback(
        new LoadingButton(button, ""),
        async () => {
            await apiCall("/api/system/power", "POST", { action });
            showNotification(`${config.label} command sent.`, "info");
        },
        `Failed to ${config.label.toLowerCase()}`,
    );
}

function initPowerControls(): void {
    const container = byId("powerControls")!;
    container.innerHTML = renderPowerCard();

    onAsync(container, "click", async (e) => {
        const button = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-power-action]");
        if (!button) return;
        await runPowerAction(button.dataset.powerAction as PowerAction, button);
    });
}

initPowerControls();

window.addEventListener("sectionchange", (event) => {
    if (event.detail.activeSectionId === "systemSection") {
        void updateSystemInfo();
    }
});

export { updateSystemInfo };
