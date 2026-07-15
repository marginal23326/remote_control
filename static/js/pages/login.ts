import "../../input.css";
import "../../css/styles.css";

document.addEventListener("DOMContentLoaded", () => {
    const loginForm = document.getElementById("loginForm")!;
    const errorBox = document.getElementById("errorBox")!;
    const errorMessage = document.getElementById("errorMessage")!;
    const submitBtn = document.getElementById("submitBtn") as HTMLButtonElement;
    const btnText = document.getElementById("btnText")!;
    const btnSpinner = document.getElementById("btnSpinner")!;

    loginForm.addEventListener("submit", async (e) => {
        e.preventDefault();

        errorBox.classList.add("hidden");
        setLoading(true);

        const password = (document.getElementById("password") as HTMLInputElement).value;

        try {
            const response = await fetch("/login", {
                body: JSON.stringify({ password }),
                headers: { "Content-Type": "application/json" },
                method: "POST",
            });

            const data = (await response.json()) as { status: string; message?: string };

            if (response.ok && data.status === "success") {
                btnText.textContent = "Success";
                setTimeout(() => {
                    window.location.href = "/";
                }, 300);
            } else {
                throw new Error(data.message ?? "Invalid credentials");
            }
        } catch (error) {
            setLoading(false);
            errorMessage.textContent = (error as Error).message || "Connection Error";
            errorBox.classList.remove("hidden");
        }
    });

    function setLoading(isLoading: boolean): void {
        if (isLoading) {
            submitBtn.disabled = true;
            submitBtn.classList.add("cursor-not-allowed", "opacity-90");
            btnText.textContent = "Signing in...";
            btnSpinner.classList.remove("hidden");
        } else {
            submitBtn.disabled = false;
            submitBtn.classList.remove("cursor-not-allowed", "opacity-90");
            btnText.textContent = "Sign in";
            btnSpinner.classList.add("hidden");
        }
    }
});
