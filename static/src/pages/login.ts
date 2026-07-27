import "../../input.css";
import "../../css/styles.css";
import { parseJsonResponse } from "@/shared/api";
import { byId } from "@/shared/dom-helpers";
import { LoadingButton } from "@/shared/feedback";

document.addEventListener("DOMContentLoaded", () => {
    const loginForm = byId("loginForm")!;
    const errorBox = byId("errorBox")!;
    const errorMessage = byId("errorMessage")!;
    const submitBtn = new LoadingButton(byId<HTMLButtonElement>("submitBtn")!, "Signing in...");

    loginForm.addEventListener("submit", async (e) => {
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

            await parseJsonResponse(response);

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
