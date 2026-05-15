// static/js/modules/input.js
import {
    streamUI,
    streamActive,
    calculateStreamDimensions,
    sendMouseEventOverDataChannel,
} from './stream.js';

// Mapping for abstract action names to actual keys
const SHORTCUT_MAP = {
    'copy': { key: 'c', modifiers: ['ctrl'] },
    'paste': { key: 'v', modifiers: ['ctrl'] },
    'cut': { key: 'x', modifiers: ['ctrl'] },
    'undo': { key: 'z', modifiers: ['ctrl'] },
    'redo': { key: 'y', modifiers: ['ctrl'] },
    'save': { key: 's', modifiers: ['ctrl'] },
    'selectall': { key: 'a', modifiers: ['ctrl'] }
};

function initializeInputHandlers(socket) {
    // 1. Helper to send keyboard events
    function emitKeyboardEvent(type, payload) {
        // console.log("Emitting keyboard event:", type, payload); 
        socket.emit('keyboard_event', {
            type: type,
            ...payload
        });
    }

    // 2. Handle Standard Shortcut Buttons (Grid buttons like "Copy", "Up", "Esc")
    document.querySelectorAll('[data-key]').forEach(button => {
        button.addEventListener('click', (_e) => {
            // Add a visual click effect for the HUD aesthetic
            button.classList.add('bg-blue-600', 'text-white', 'border-blue-500');
            setTimeout(() => {
                button.classList.remove('bg-blue-600', 'text-white', 'border-blue-500');
            }, 150);

            const rawKey = button.dataset.key;
            let key = rawKey;
            let modifiers = [];

            // Case A: Abstract command (e.g., "copy")
            if (SHORTCUT_MAP[rawKey]) {
                key = SHORTCUT_MAP[rawKey].key;
                modifiers = SHORTCUT_MAP[rawKey].modifiers;
            } 
            // Case B: Combined keys (e.g., "alt+tab", "win+d")
            else if (rawKey.includes('+')) {
                const parts = rawKey.split('+');
                key = parts.pop(); // The last part is the main key
                modifiers = parts; // The rest are modifiers
            }
            // Case C: Single key (e.g., "up", "home", "win")
            // 'key' is already set to rawKey, modifiers is empty.

            emitKeyboardEvent('shortcut', {
                shortcut: key,
                modifiers: modifiers
            });
        });
    });

    // 3. Text Input Handling (Updated for new HTML structure)
    const textInput = document.getElementById('textInput');
    const sendTextButton = document.getElementById('sendText'); // Specific ID in new HTML

    if (sendTextButton && textInput) {
        const sendText = () => {
            const text = textInput.value;
            if (text) {
                emitKeyboardEvent('text', { text: text });
                textInput.value = '';
                
                // Visual feedback on button
                const originalText = sendTextButton.innerText;
                sendTextButton.innerText = "SENT >>";
                sendTextButton.classList.add('text-green-400', 'border-green-500');
                setTimeout(() => {
                    sendTextButton.innerText = originalText;
                    sendTextButton.classList.remove('text-green-400', 'border-green-500');
                }, 500);
            }
        };

        sendTextButton.addEventListener('click', sendText);

        textInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && e.ctrlKey) {
                e.preventDefault();
                sendText();
            }
        });
    }

    // 4. Custom Shortcut Builder (Updated for new UI toggles)
    const customKeyInput = document.getElementById('customKey');
    const sendCustomButton = document.getElementById('sendCustomShortcut');
    const modifierButtons = document.querySelectorAll('.modifier-btn');

    // Toggle logic for modifier buttons
    modifierButtons.forEach(button => {
        button.addEventListener('click', () => {
            // Toggle data-active attribute for CSS styling
            const isActive = button.getAttribute('data-active') === 'true';
            button.setAttribute('data-active', !isActive);
        });
    });

    if (sendCustomButton && customKeyInput) {
        sendCustomButton.addEventListener('click', () => {
            const key = customKeyInput.value.toLowerCase().trim();
            
            // Gather active modifiers
            const activeModifiers = Array.from(modifierButtons)
                .filter(btn => btn.getAttribute('data-active') === 'true')
                .map(btn => btn.dataset.modifier);

            // Only send if we have a key OR at least one modifier
            if (key.length > 0 || activeModifiers.length > 0) {
                emitKeyboardEvent('shortcut', {
                    shortcut: key, 
                    modifiers: activeModifiers
                });

                // Reset UI after send? Optional. 
                // Let's keep modifiers active for repeated commands, but clear text input.
                customKeyInput.value = '';
                
                // Visual feedback
                sendCustomButton.classList.add('bg-blue-500', 'text-white');
                setTimeout(() => sendCustomButton.classList.remove('bg-blue-500', 'text-white'), 200);
            }
        });
    }

    // 5. Mouse Event Handlers
    let touchStarted = false;
    let isCtrlPressed = false;
    let initialTouchY = null;
    let isScrolling = false;
    let isDragging = false;

    // Track Ctrl key for modifying mouse behavior
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Control') isCtrlPressed = true;
    });

    document.addEventListener('keyup', (event) => {
        if (event.key === 'Control') isCtrlPressed = false;
    });

    // Reset states when window loses focus
    window.addEventListener('blur', () => {
        isCtrlPressed = false;
        isDragging = false;
    });

    if (streamUI.view) {
        // Prevent default browser dragging of the image
        streamUI.view.addEventListener('dragstart', (event) => event.preventDefault());

        // Mouse Wheel
        streamUI.view.addEventListener('wheel', (event) => {
            event.preventDefault();
            // dy direction: negative for up (away from user), positive for down
            sendMouseEvent('scroll', event, { dx: 0, dy: -Math.sign(event.deltaY) });
        });

        // --- Touch Handling ---
        streamUI.view.addEventListener('touchstart', (event) => {
            event.preventDefault();

            // Two finger touch = Scroll
            if (event.touches.length === 2) {
                if (touchStarted) {
                    // Cancel any pending click if we switch to scroll
                    touchStarted = false;
                    sendMouseEvent('click', event.touches[0], { button: 'left', pressed: false });
                }
                isScrolling = true;
                initialTouchY = event.touches[1].clientY;
                return;
            }

            // One finger touch = Left Click Down
            if (event.touches.length === 1 && !isScrolling) {
                touchStarted = true;
                sendMouseEvent('click', event.touches[0], { button: 'left', pressed: true });
            }
        });

        streamUI.view.addEventListener('touchmove', (event) => {
            event.preventDefault();

            if (event.touches.length === 2 && isScrolling && initialTouchY !== null) {
                const currentTouchY = event.touches[1].clientY;
                const deltaY = initialTouchY - currentTouchY;

                // Threshold to prevent jitter
                if (Math.abs(deltaY) > 5) {
                    sendMouseEvent('scroll', event.touches[0], { dx: 0, dy: -Math.sign(deltaY) });
                    initialTouchY = currentTouchY;
                }
                return;
            }

            if (event.touches.length === 1 && touchStarted && !isScrolling) {
                sendMouseEvent('move', event.touches[0]);
            }
        });

        streamUI.view.addEventListener('touchend', (event) => {
            event.preventDefault();

            if (event.touches.length === 0) {
                isScrolling = false;
                initialTouchY = null;
            }

            // Lift finger = Left Click Up
            if (touchStarted && event.touches.length === 0) {
                touchStarted = false;
                // Use changedTouches to get the position where the finger left
                sendMouseEvent('click', event.changedTouches[0], { button: 'left', pressed: false });
            }
        });

        streamUI.view.addEventListener('touchcancel', (event) => {
            event.preventDefault();
            isScrolling = false;
            initialTouchY = null;

            if (touchStarted) {
                touchStarted = false;
                sendMouseEvent('click', event.changedTouches[0], { button: 'left', pressed: false });
            }
        });

        // --- Mouse Handling ---
        streamUI.view.addEventListener('mousemove', (event) => {
            event.preventDefault();
            // Only send move events if dragging or holding Ctrl (to avoid flooding socket with idle movements)
            if (isDragging || isCtrlPressed) {
                sendMouseEvent('move', event);
            }
        });

        streamUI.view.addEventListener('mousedown', (event) => {
            event.preventDefault();
            const button = event.button === 0 ? 'left' : event.button === 2 ? 'right' : 'middle';
            sendMouseEvent('click', event, { button, pressed: true });

            if (button === 'left') isDragging = true;
        });

        streamUI.view.addEventListener('mouseup', (event) => {
            event.preventDefault();
            const button = event.button === 0 ? 'left' : event.button === 2 ? 'right' : 'middle';
            sendMouseEvent('click', event, { button, pressed: false });

            if (button === 'left') isDragging = false;
        });

        streamUI.view.addEventListener('contextmenu', (event) => event.preventDefault());
    }

    function sendMouseEvent(type, event, options = {}) {
        if (!streamActive) return;
        
        // Normalize coordinates
        const clientX = event.touches ? event.clientX : event.clientX;
        const clientY = event.touches ? event.clientY : event.clientY;
        
        const dimensions = calculateStreamDimensions();
        
        // Calculate position relative to the stream container
        const relativeX = clientX - dimensions.container.left - dimensions.offsetX;
        const relativeY = clientY - dimensions.container.top - dimensions.offsetY;
        
        // Scale to native resolution
        const x = Math.max(0, Math.min(dimensions.nativeWidth, relativeX * dimensions.scaleX));
        const y = Math.max(0, Math.min(dimensions.nativeHeight, relativeY * dimensions.scaleY));
        
        const data = { type, x, y, ...options };
        if (!sendMouseEventOverDataChannel(data)) {
            socket.emit('mouse_event', data);
        }
    }
}

export { initializeInputHandlers };
