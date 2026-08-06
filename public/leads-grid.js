/**
 * Leads Excel-like Grid
 * - Resizable columns (drag the border handle)
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
                th.style.minWidth = saved[i] + 'px';
            }

            // Skip last column (Actions) resize to keep buttons tidy
            if (i === headers.length - 1) return;

            // Create resize handle
            const handle = document.createElement('div');
            handle.className = 'col-resize-handle';
            th.appendChild(handle);

            let startX, startWidth, nextTh, nextStartWidth;

            handle.addEventListener('mousedown', (e) => {
                e.preventDefault();
                e.stopPropagation();

                startX = e.clientX;
                startWidth = th.offsetWidth;
                nextTh = headers[i + 1] || null;
                nextStartWidth = nextTh ? nextTh.offsetWidth : null;

                document.body.style.cursor = 'col-resize';
                document.body.style.userSelect = 'none';
                handle.classList.add('active');
                table.classList.add('resizing');

                function onMouseMove(e) {
                    const diff = e.clientX - startX;
                    const newWidth = Math.max(60, startWidth + diff);
                    th.style.width = newWidth + 'px';
                    th.style.minWidth = newWidth + 'px';

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
            th.style.minWidth = '';
        });
    };

    // Re-init after leads are rendered (called from renderLeadsTable)
    window.initLeadsGrid = initLeadsGrid;

    // Init on DOMContentLoaded
    document.addEventListener('DOMContentLoaded', () => {
        // Slight delay to ensure table is in DOM
        setTimeout(initLeadsGrid, 500);
    });
})();
