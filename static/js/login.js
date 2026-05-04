import '../input.css';
import '../css/styles.css';

document.addEventListener('DOMContentLoaded', () => {
    const loginForm = document.getElementById('loginForm');
    const errorBox = document.getElementById('errorBox');
    const errorMessage = document.getElementById('errorMessage');
    const loginCard = document.getElementById('loginCard');
    const submitBtn = document.getElementById('submitBtn');
    const btnText = document.getElementById('btnText');
    const btnIcon = document.getElementById('btnIcon');
    const btnSpinner = document.getElementById('btnSpinner');

    // Input focus effects
    const inputs = document.querySelectorAll('input');
    inputs.forEach(input => {
        input.addEventListener('focus', () => input.closest('.login-input-group').classList.add('focused'));
        input.addEventListener('blur', () => input.closest('.login-input-group').classList.remove('focused'));
    });

    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        // UI Reset
        errorBox.classList.add('hidden');
        loginCard.classList.remove('auth-fail');
        setLoading(true);

        const username = document.getElementById('username').value;
        const password = document.getElementById('password').value;

        try {
            // Aesthetic delay (optional - makes the spinner visible for a moment)
            await new Promise(r => setTimeout(r, 400));

            const response = await fetch('/login', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ username, password })
            });

            const data = await response.json();

            if (response.ok && data.status === 'success') {
                // Success Animation
                loginCard.classList.add('auth-success');
                btnText.innerText = "ACCESS GRANTED";
                
                // Redirect
                setTimeout(() => {
                    window.location.href = '/';
                }, 500);
            } else {
                throw new Error(data.error || 'Access Denied');
            }

        } catch (err) {
            // Error Handling
            setLoading(false);
            errorMessage.textContent = err.message || 'Connection Error';
            errorBox.classList.remove('hidden');
            
            // Shake Effect
            loginCard.classList.add('auth-fail');
            setTimeout(() => {
                loginCard.classList.remove('auth-fail');
            }, 500);
            console.error(err);
        }
    });

    function setLoading(isLoading) {
        if (isLoading) {
            submitBtn.disabled = true;
            submitBtn.classList.add('cursor-not-allowed', 'opacity-80');
            btnText.innerText = "VERIFYING...";
            btnIcon.classList.add('hidden');
            btnSpinner.classList.remove('hidden');
        } else {
            submitBtn.disabled = false;
            submitBtn.classList.remove('cursor-not-allowed', 'opacity-80');
            btnText.innerText = "AUTHENTICATE";
            btnIcon.classList.remove('hidden');
            btnSpinner.classList.add('hidden');
        }
    }
});