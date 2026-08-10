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

window.addEventListener("sectionchange", (event) => {
    if (event.detail.activeSectionId === "systemSection") {
        void updateSystemInfo();
    }
});

export { updateSystemInfo };
