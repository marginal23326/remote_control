import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
    plugins: [tailwindcss()],
    root: "static",
    build: {
        outDir: "dist",
        emptyOutDir: true,
        rollupOptions: {
            input: {
                main: "index.html",
                login: "login.html",
            },
        },
    },
    resolve: {
        alias: {
            "@": "/js",
        },
    },
});
