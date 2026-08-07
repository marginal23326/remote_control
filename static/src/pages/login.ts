import "../../input.css";
import "../../css/styles.css";
import { parseApiResult } from "@/shared/api";
import { byId, onAsync } from "@/shared/dom-helpers";
import { LoadingButton } from "@/shared/feedback";

document.addEventListener("DOMContentLoaded", () => {
    const loginForm = byId("loginForm")!;
    const errorBox = byId("errorBox")!;
    const errorMessage = byId("errorMessage")!;
    const submitBtn = new LoadingButton(byId<HTMLButtonElement>("submitBtn")!, "Signing in...");

    onAsync(loginForm, "submit", async (e) => {
        e.preventDefault();

        errorBox.classList.add("hidden");
        submitBtn.startLoading();

        const password = byId<HTMLInputElement>("password")!.value;

        try {
            const response = await fetch("/login", {
                body: JSON.stringify({ password }),
                headers: { "Content-Type": "application/json" },
                method: "POST",
            });

            parseApiResult(response.status, await response.text());

            submitBtn.setLoadingText("Success");
            setTimeout(() => {
                window.location.href = "/";
            }, 300);
        } catch (error) {
            submitBtn.stopLoading();
            errorMessage.textContent = (error as Error).message || "Connection Error";
            errorBox.classList.remove("hidden");
        }
    });
});
