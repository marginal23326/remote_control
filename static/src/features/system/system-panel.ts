import { apiCall } from "@/shared/api";
import { byId, escapeHtml } from "@/shared/dom-helpers";
import { SVG_TEMPLATES } from "@/shared/icons";
import type { SystemInfo } from "@/shared/types";

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
    const info = await apiCall<SystemInfo>("/api/system");
    const cards: InfoCard[] = [
        {
            data: [
                ["Operating System", info.os],
                ["Architecture", info.architecture],
                ["PC / Host / Domain", [info.pc_name, info.hostname, info.domain].filter(Boolean).join(" / ")],
                ["Username", info.username],
                ["Time & Location", [info.timezone, info.country].filter(Boolean).join(" - ")],
                ["Uptime", formatUptime(info.uptime_seconds)],
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
                    `${info.processor?.replace(/\s*@\s*[\d.]+\s*GHz/u, "") ?? "?"} · ${info.cpu_base_speed ?? "?"} / ${formatCpuMhz(info.cpu_max_speed_mhz)}`,
                ],
                ["Cores / Threads", `${info.cpu_cores} / ${info.cpu_threads}`],
                ["Memory", `${info.memory_total_mb} MB`],
                ["GPU", formatList(info.gpu)],
                ["Monitors", formatList(info.monitors)],
                ["Battery", info.battery],
            ],
            icon: SVG_TEMPLATES.icon(
                "M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10q2 0 2-2V7q0-2-2-2H7q-2 0-2 2v10q0 2 2 2M9 9h6v6H9z",
                "w-4 h-4 shrink-0 text-zinc-400",
            ),
            title: "Hardware",
        },
        {
            data: [
                ["LAN / WAN IP", [info.lan_ip, info.wan_ip].filter(Boolean).join(" / ")],
                ["MAC Address", info.mac_address],
                ["ISP", info.isp ? `${info.isp} ${info.asn ? `(${info.asn})` : ""}` : null],
                ["Antivirus", formatList(info.antivirus)],
                ["Firewall", info.firewall],
            ],
            icon: SVG_TEMPLATES.network(),
            title: "Network & Security",
        },
        {
            data: [
                ["Drives", formatList(info.disks)],
                [
                    "System Drive",
                    `${info.system_drive} (${info.disk_used_gb} GB used of ${info.disk_total_gb} GB, ${info.disk_free_gb} GB free)`,
                ],
                ["Active Processes", `${info.active_processes}`],
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

window.addEventListener("sectionchange", (event) => {
    if (event.detail.activeSectionId === "systemSection") {
        void updateSystemInfo();
    }
});

export { updateSystemInfo };
