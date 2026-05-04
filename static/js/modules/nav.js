// static/js/modules/nav.js
function initializeNavigation(isAuthenticated = true) {
    const navLinks = document.querySelectorAll('.nav-link');
    const sections = document.querySelectorAll('.section');
    
    const navContainer = document.querySelector('nav .overflow-x-auto'); 

    function showSection(sectionId) {
        sections.forEach(section => {
            if (section.id === sectionId) {
                section.classList.remove('hidden');
                // Trigger animation replay if needed
                section.style.animation = 'none';
                void section.offsetHeight; /* trigger reflow */
                section.style.animation = null; 
            } else {
                section.classList.add('hidden');
            }
        });
    }

    function updateActiveNavLink(activeLinkId) {
        navLinks.forEach(link => {
            const isActive = link.getAttribute('href') === `#${activeLinkId}`;
            link.classList.toggle('active', isActive);
            
            // Update the icon/text color inside the active tab
            if(isActive) {
                link.classList.add('text-blue-400', 'bg-blue-500/10');
            } else {
                link.classList.remove('text-blue-400', 'bg-blue-500/10');
            }
        });
        if (navContainer) updateOverflowIndicators();
    }

    function updateOverflowIndicators() {
        if (!navContainer) return;

        const isOverflowing = navContainer.scrollWidth > navContainer.clientWidth;
        const isAtStart = navContainer.scrollLeft === 0;
        const isAtEnd = Math.abs(navContainer.scrollLeft + navContainer.clientWidth - navContainer.scrollWidth) < 1;

        // You can toggle classes here if you want fade masks on the sides
        navContainer.parentElement.classList.toggle('mask-start', isOverflowing && !isAtStart);
        navContainer.parentElement.classList.toggle('mask-end', isOverflowing && !isAtEnd);
    }

    if (isAuthenticated) {
        const defaultSectionId = 'streamSection';
        showSection(defaultSectionId);
        updateActiveNavLink(defaultSectionId);
    }

    navLinks.forEach(link => {
        link.addEventListener('click', (event) => {
            event.preventDefault();
            const sectionId = link.getAttribute('href').substring(1);
            showSection(sectionId);
            updateActiveNavLink(sectionId);
        });
    });

    if (navContainer) {
        navContainer.addEventListener('scroll', updateOverflowIndicators);
        window.addEventListener('resize', updateOverflowIndicators);
        // Initial check
        setTimeout(updateOverflowIndicators, 100); 
    }
}

export { initializeNavigation };