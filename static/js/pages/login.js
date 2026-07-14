// static/js/pages/login.js
import "../../input.css";
import "../../css/styles.css";

document.addEventListener("DOMContentLoaded", () => {
    const loginForm = document.getElementById("loginForm");
    const errorBox = document.getElementById("errorBox");
    const errorMessage = document.getElementById("errorMessage");
    const submitBtn = document.getElementById("submitBtn");
    const btnText = document.getElementById("btnText");
    const btnSpinner = document.getElementById("btnSpinner");

    loginForm.addEventListener("submit", async (e) => {
        e.preventDefault();

        errorBox.classList.add("hidden");
        setLoading(true);

        const password = document.getElementById("password").value;

        try {
            const response = await fetch("/login", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ password }),
            });

            const data = await response.json();

            if (response.ok && data.status === "success") {
                btnText.innerText = "Success";
                setTimeout(() => {
                    window.location.href = "/";
                }, 300);
            } else {
                throw new Error(data.message || "Invalid credentials");
            }
        } catch (err) {
            setLoading(false);
            errorMessage.textContent = err.message || "Connection Error";
            errorBox.classList.remove("hidden");
        }
    });

    function setLoading(isLoading) {
        if (isLoading) {
            submitBtn.disabled = true;
            submitBtn.classList.add("cursor-not-allowed", "opacity-90");
            btnText.innerText = "Signing in...";
            btnSpinner.classList.remove("hidden");
        } else {
            submitBtn.disabled = false;
            submitBtn.classList.remove("cursor-not-allowed", "opacity-90");
            btnText.innerText = "Sign in";
            btnSpinner.classList.add("hidden");
        }
    }
});
