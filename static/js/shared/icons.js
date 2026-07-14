const SVG_TEMPLATES = {
    folder: (colorClass = "text-zinc-400") => `
        <svg class="w-4 h-4 ${colorClass}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-width="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/>
        </svg>`,
    file: () => `
        <svg class="w-4 h-4 text-zinc-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-width="2" d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M9 5a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2M9 5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2m-3 7h3m-3 4h3m-6-4h0m0 4h0"/>
        </svg>`,
    spinner: (size = 4) => {
        const rem = size * 0.25;
        return `
        <svg style="width:${rem}rem;height:${rem}rem" class="animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke-width="4"/>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 0 1 8-8V0C5 0 0 5 0 12zm2 5a8 8 0 0 1-2-5H0c0 3 1 6 3 8z"/>
        </svg>`;
    },
    upload: (size = 10, colorClass = "text-zinc-600") => {
        const rem = size * 0.25;
        return `
        <svg style="width:${rem}rem;height:${rem}rem" class="mx-auto mb-2 ${colorClass}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-width="2" d="M4 16v1a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-1m-4-8-4-4m0 0L8 8m4-4v12"/>
        </svg>`;
    },
    cross: () => `
        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
        </svg>`,
};

export { SVG_TEMPLATES };
