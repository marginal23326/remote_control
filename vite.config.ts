import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
    build: {
        rolldownOptions: {
            input: {
                login: "login.html",
                main: "index.html",
            },
        },
    },
    plugins: [tailwindcss()],
    resolve: {
        tsconfigPaths: true,
    },
    root: "static",
});
