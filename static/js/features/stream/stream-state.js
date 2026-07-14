let streamActive = false;
let activeStunServer = null;

function setStreamActive(value) {
    streamActive = value;
}

function setStunServer(url) {
    activeStunServer = url;
}

export { streamActive, setStreamActive, activeStunServer, setStunServer };
