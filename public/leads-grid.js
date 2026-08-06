/**
 * Leads Excel-like Grid
 * - Resizable columns (drag the border handle to make bigger or super thin down to 15px)
 * - Column width persistence via localStorage
 * - Excel-style cursor & visual feedback
 */

(function () {
    const STORAGE_KEY = 'leads_col_widths';

    function initLeadsGrid() {
        const table = document.getElementById('leadsTable');
        if (!table) return;

        const headers = table.querySelectorAll('thead th');
        if (!headers.length) return;

        // Restore saved widths
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');

        headers.forEach((th, i) => {
            // Apply saved width
            if (saved[i]) {
                th.style.width = saved[i] + 'px';
                th.style.maxWidth = saved[i] + 'px';
                th.style.minWidth = '15px';
            } else {
                th.style.minWidth = '15px';
            }

            // Skip last column (Actions)
            if (i === headers.length - 1) return;

            // Use existing hardcoded handle OR create one if missing
            let handle = th.querySelector('.col-resize-handle');
            if (!handle) {
                handle = document.createElement('div');
                handle.className = 'col-resize-handle';
                th.appendChild(handle);
            }

            // Remove any stale listeners by cloning (safe approach)
            const newHandle = handle.cloneNode(true);
            handle.parentNode.replaceChild(newHandle, handle);
            handle = newHandle;

            let startX, startWidth;

            handle.addEventListener('mousedown', (e) => {
                e.preventDefault();
                e.stopPropagation();

                startX = e.clientX;
                startWidth = th.offsetWidth;

                document.body.style.cursor = 'col-resize';
                document.body.style.userSelect = 'none';
                handle.classList.add('active');
                table.classList.add('resizing');

                function onMouseMove(e) {
                    const diff = e.clientX - startX;
                    const newWidth = Math.max(15, startWidth + diff);
                    th.style.width = newWidth + 'px';
                    th.style.maxWidth = newWidth + 'px';
                    th.style.minWidth = '15px';

                    // Save to localStorage
                    const widths = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
                    widths[i] = newWidth;
                    localStorage.setItem(STORAGE_KEY, JSON.stringify(widths));
                }

                function onMouseUp() {
                    document.body.style.cursor = '';
                    document.body.style.userSelect = '';
                    handle.classList.remove('active');
                    table.classList.remove('resizing');
                    document.removeEventListener('mousemove', onMouseMove);
                    document.removeEventListener('mouseup', onMouseUp);
                }

                document.addEventListener('mousemove', onMouseMove);
                document.addEventListener('mouseup', onMouseUp);
            });
        });
    }

    // Reset all column widths
    window.resetLeadsGridWidths = function () {
        localStorage.removeItem(STORAGE_KEY);
        const table = document.getElementById('leadsTable');
        if (!table) return;
        table.querySelectorAll('thead th').forEach(th => {
            th.style.width = '';
            th.style.maxWidth = '';
            th.style.minWidth = '15px';
        });
    };

    // Re-init after leads are rendered (called from renderLeadsTable)
    window.initLeadsGrid = initLeadsGrid;

    // Init on DOMContentLoaded
    document.addEventListener('DOMContentLoaded', () => {
        setTimeout(initLeadsGrid, 600);
    });
})();
