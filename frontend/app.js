// ─────────────────────────────────────────────────────────────
//  app.js
//  Main controller — mode switching, secret triggers,
//  product data, sales chart, and security hardening
// ─────────────────────────────────────────────────────────────

(() => {
    'use strict';

    // ═════════════════════════════════════════════════════════
    //  STATE
    // ═════════════════════════════════════════════════════════

    let currentMode = 'wapnation'; // 'wapnation' | 'ghost'
    let logoClickCount = 0;
    let logoClickTimer = null;
    const LOGO_CLICK_THRESHOLD = 3;
    const LOGO_CLICK_WINDOW_MS = 1500;
    const SECRET_CODE = '1315';

    // ═════════════════════════════════════════════════════════
    //  PRODUCT DATA
    // ═════════════════════════════════════════════════════════

    const products = [
        { sku: 'VAP-001', name: 'Elfbar BC5000 Ultra', cat: 'Vapes', catClass: 'cat-vapes', price: 18990, stock: 234 },
        { sku: 'VAP-002', name: 'SMOK Nord GT Pro', cat: 'Vapes', catClass: 'cat-vapes', price: 32500, stock: 89 },
        { sku: 'VAP-003', name: 'Lost Mary MO5000', cat: 'Vapes', catClass: 'cat-vapes', price: 15990, stock: 412 },
        { sku: 'VAP-004', name: 'Vaporesso XROS 4 Nano', cat: 'Vapes', catClass: 'cat-vapes', price: 27900, stock: 56 },
        { sku: 'ACC-001', name: 'Cargador USB-C Dual Fast', cat: 'Accesorios', catClass: 'cat-accesorios', price: 7990, stock: 145 },
        { sku: 'ACC-002', name: 'Funda Silicona Universal', cat: 'Accesorios', catClass: 'cat-accesorios', price: 3990, stock: 320 },
        { sku: 'ACC-003', name: 'Kit Limpieza Premium', cat: 'Accesorios', catClass: 'cat-accesorios', price: 5490, stock: 18 },
        { sku: 'GAD-001', name: 'Power Bank 20000mAh', cat: 'Gadgets', catClass: 'cat-gadgets', price: 24990, stock: 67 },
        { sku: 'GAD-002', name: 'Mini Balanza Digital 0.01g', cat: 'Gadgets', catClass: 'cat-gadgets', price: 12500, stock: 7 },
        { sku: 'GAD-003', name: 'Lámpara UV Portátil', cat: 'Gadgets', catClass: 'cat-gadgets', price: 8990, stock: 45 },
        { sku: 'LIQ-001', name: 'E-Liquid Mango Ice 60ml', cat: 'Líquidos', catClass: 'cat-liquidos', price: 9990, stock: 198 },
        { sku: 'LIQ-002', name: 'Salt Nic Berry Mix 30ml', cat: 'Líquidos', catClass: 'cat-liquidos', price: 6990, stock: 4 },
        { sku: 'VAP-005', name: 'GeekVape Aegis Legend 3', cat: 'Vapes', catClass: 'cat-vapes', price: 45900, stock: 33 },
        { sku: 'ACC-004', name: 'Drip Tips Pack x5', cat: 'Accesorios', catClass: 'cat-accesorios', price: 4990, stock: 88 },
        { sku: 'GAD-004', name: 'Speaker Bluetooth Mini', cat: 'Gadgets', catClass: 'cat-gadgets', price: 15990, stock: 12 },
    ];

    // ═════════════════════════════════════════════════════════
    //  INIT
    // ═════════════════════════════════════════════════════════

    document.addEventListener('DOMContentLoaded', () => {
        try { renderProductTable(); } catch (e) { /* table render failed */ }
        try { renderSalesChart(); } catch (e) { /* chart render failed */ }
        try { setupTriggers(); } catch (e) { /* triggers failed */ }
        try { setupSecurity(); } catch (e) { /* security failed */ }
        try { GhostChat.init(); } catch (e) { /* ghost init failed */ }

        // Re-render chart on resize/orientation change
        let resizeTimer = null;
        window.addEventListener('resize', () => {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => {
                try { renderSalesChart(); } catch (e) { /* chart resize failed */ }
            }, 300);
        });
    });

    // ═════════════════════════════════════════════════════════
    //  PRODUCT TABLE
    // ═════════════════════════════════════════════════════════

    function renderProductTable() {
        const tbody = document.getElementById('product-table-body');
        tbody.innerHTML = products.map((p) => {
            let stockClass = 'stock-good';
            let stockLabel = 'Óptimo';
            if (p.stock < 10) { stockClass = 'stock-low'; stockLabel = 'Crítico'; }
            else if (p.stock < 50) { stockClass = 'stock-med'; stockLabel = 'Bajo'; }

            return `<tr>
        <td style="font-family:var(--mono);font-size:12px;color:var(--wap-text-dim)">${p.sku}</td>
        <td class="product-name">${p.name}</td>
        <td><span class="product-cat ${p.catClass}">${p.cat}</span></td>
        <td>$${p.price.toLocaleString('es-CL')}</td>
        <td class="${stockClass}">${p.stock} uds</td>
        <td><span class="${stockClass}" style="font-size:11px">${stockLabel}</span></td>
      </tr>`;
        }).join('');
    }

    // ═════════════════════════════════════════════════════════
    //  SALES CHART (Canvas)
    // ═════════════════════════════════════════════════════════

    function renderSalesChart() {
        const canvas = document.getElementById('sales-chart');
        if (!canvas) return;
        const rect = canvas.parentElement.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) return; // hidden or 0-size (mobile)
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const dpr = window.devicePixelRatio || 1;
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
        canvas.style.width = rect.width + 'px';
        canvas.style.height = rect.height + 'px';
        ctx.scale(dpr, dpr);

        const W = rect.width;
        const H = rect.height;

        const days = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
        const current = [420, 380, 510, 470, 620, 710, 580];
        const previous = [350, 340, 400, 420, 500, 550, 480];
        const maxVal = Math.max(...current, ...previous) * 1.15;

        const padL = 40, padR = 16, padT = 20, padB = 36;
        const chartW = W - padL - padR;
        const chartH = H - padT - padB;
        const step = chartW / (days.length - 1);

        // Grid lines
        ctx.strokeStyle = 'rgba(37,42,54,.6)';
        ctx.lineWidth = 1;
        for (let i = 0; i <= 4; i++) {
            const y = padT + (chartH / 4) * i;
            ctx.beginPath();
            ctx.moveTo(padL, y);
            ctx.lineTo(W - padR, y);
            ctx.stroke();

            // Y labels
            const val = Math.round(maxVal - (maxVal / 4) * i);
            ctx.fillStyle = '#8892a4';
            ctx.font = '10px Inter';
            ctx.textAlign = 'right';
            ctx.fillText(`${val}`, padL - 8, y + 4);
        }

        // X labels
        ctx.textAlign = 'center';
        days.forEach((d, i) => {
            ctx.fillStyle = '#8892a4';
            ctx.font = '11px Inter';
            ctx.fillText(d, padL + step * i, H - 10);
        });

        // Draw line helper
        function drawLine(data, color, fill) {
            ctx.beginPath();
            data.forEach((v, i) => {
                const x = padL + step * i;
                const y = padT + chartH - (v / maxVal) * chartH;
                i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
            });
            ctx.strokeStyle = color;
            ctx.lineWidth = 2.5;
            ctx.lineJoin = 'round';
            ctx.stroke();

            if (fill) {
                // Fill area
                const last = data.length - 1;
                ctx.lineTo(padL + step * last, padT + chartH);
                ctx.lineTo(padL, padT + chartH);
                ctx.closePath();
                const grad = ctx.createLinearGradient(0, padT, 0, padT + chartH);
                grad.addColorStop(0, fill);
                grad.addColorStop(1, 'transparent');
                ctx.fillStyle = grad;
                ctx.fill();
            }

            // Dots
            data.forEach((v, i) => {
                const x = padL + step * i;
                const y = padT + chartH - (v / maxVal) * chartH;
                ctx.beginPath();
                ctx.arc(x, y, 4, 0, Math.PI * 2);
                ctx.fillStyle = color;
                ctx.fill();
                ctx.strokeStyle = '#12151c';
                ctx.lineWidth = 2;
                ctx.stroke();
            });
        }

        drawLine(previous, 'rgba(136,146,164,.4)', null);
        drawLine(current, '#6c5ce7', 'rgba(108,92,231,.12)');
    }

    // ═════════════════════════════════════════════════════════
    //  SECRET TRIGGERS
    // ═════════════════════════════════════════════════════════

    function setupTriggers() {
        // Trigger 1: Triple-click on logo
        const logo = document.getElementById('wap-logo');
        logo.addEventListener('click', () => {
            logoClickCount++;
            clearTimeout(logoClickTimer);

            if (logoClickCount >= LOGO_CLICK_THRESHOLD) {
                logoClickCount = 0;
                switchToGhost();
                return;
            }

            logoClickTimer = setTimeout(() => { logoClickCount = 0; }, LOGO_CLICK_WINDOW_MS);
        });

        // Trigger 2: Type "1315" in search bar
        const search = document.getElementById('search-input');
        search.addEventListener('input', () => {
            if (search.value.trim() === SECRET_CODE) {
                search.value = '';
                switchToGhost();
            }
        });
    }

    // ═════════════════════════════════════════════════════════
    //  MODE SWITCHING
    // ═════════════════════════════════════════════════════════

    function switchToGhost() {
        if (currentMode === 'ghost') return;
        currentMode = 'ghost';

        document.getElementById('wapnation-mode').classList.add('hidden');
        GhostChat.activate();
    }

    function switchToWapnation() {
        if (currentMode === 'wapnation') return;
        currentMode = 'wapnation';

        GhostChat.deactivate();
        document.getElementById('wapnation-mode').classList.remove('hidden');
        document.getElementById('search-input').value = '';
    }

    // ═════════════════════════════════════════════════════════
    //  SECURITY
    // ═════════════════════════════════════════════════════════

    function setupSecurity() {
        // Block right-click
        document.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            return false;
        });

        // Panic Button: Esc → instant return to Wapnation
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                switchToWapnation();
            }
        });
    }

    // Expose for possible external use
    window.__wap = { switchToGhost, switchToWapnation };

})();
