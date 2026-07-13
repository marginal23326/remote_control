// static/js/modules/system.js
import { apiCall } from "./utils.js";

const svg = (inner) =>
    `<svg class="w-4 h-4 shrink-0 text-zinc-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">${inner}</svg>`;
const path = (d) => `<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="${d}"/>`;

async function updateSystemInfo() {
    const info = await apiCall("/api/system");
    const cards = [
        {
            title: "Identity & OS",
            icon: svg(path("M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14q2 0 2-2V5q0-2-2-2H5q-2 0-2 2v10q0 2 2 2z")),
            data: [
                ["Operating System", info.os],
                ["Architecture", info.architecture],
                ["PC / Host / Domain", [info.pc_name, info.hostname, info.domain].filter(Boolean).join(" / ")],
                ["Username", info.username],
                ["Time & Location", [info.timezone, info.country].filter(Boolean).join(" - ")],
                ["Uptime", info.uptime],
            ],
        },
        {
            title: "Hardware",
            icon: svg(
                path(
                    "M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10q2 0 2-2V7q0-2-2-2H7q-2 0-2 2v10q0 2 2 2M9 9h6v6H9z",
                ),
            ),
            data: [
                [
                    "Processor",
                    `${info.processor?.replace(/\s*@\s*[\d.]+\s*GHz/, "") || "?"} · ${info.cpu_base_speed || "?"} / ${info.cpu_max_speed || "?"}`,
                ],
                ["Cores / Threads", `${info.cpu_cores || "?"} / ${info.cpu_threads || "?"}`],
                ["Memory", info.memory],
                ["GPU", info.gpu],
                ["Monitors", info.monitors],
                ["Battery", info.battery],
            ],
        },
        {
            title: "Network & Security",
            icon: svg(`<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="3" ry="9"/>` + path("M3 12h18")),
            data: [
                ["LAN / WAN IP", [info.lan_ip, info.wan_ip].filter(Boolean).join(" / ")],
                ["MAC Address", info.mac_address],
                ["ISP", info.isp ? `${info.isp} ${info.asn ? `(${info.asn})` : ""}` : null],
                ["Antivirus", info.antivirus],
                ["Firewall", info.firewall],
            ],
        },
        {
            title: "Storage & Status",
            icon: svg(
                `<ellipse cx="12" cy="6" rx="8" ry="3"/>` +
                    path("M4 6v12a8 3 0 0016 0V6M4 10a8 3 0 0016 0M4 14a8 3 0 0016 0"),
            ),
            data: [
                ["Drives", info.disks],
                [
                    "System Drive",
                    `${info.system_drive} (${info.disk_used || "?"} used of ${info.disk_total || "?"}, ${info.disk_free || "?"} free)`,
                ],
                ["Active Processes", info.active_processes],
            ],
        },
    ];

    document.getElementById("systemInfo").innerHTML = cards
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
                        <div class="text-sm text-zinc-300 break-words leading-tight">${v || "N/A"}</div>
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
        updateSystemInfo();
    }
});

export { updateSystemInfo };
