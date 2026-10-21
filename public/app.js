// ===================================================
// VEEMENZ Inventory & Sales Tracker — Frontend App
// ===================================================

const API_BASE = '/api';
let authToken = localStorage.getItem('authToken');
let currentUser = JSON.parse(localStorage.getItem('currentUser') || 'null');
let warehousesCache = [];
let taxRate = 0.10;
let taxEnabled = true;
let showTotalValue = true;
let forcePasswordChange = false;
let confirmCallback = null;
let saleWarehouseChangeHandler = null;
let currencySymbol = '₵';
let defaultThreshold = 10;
const CURRENCY_SYMBOLS = { GHS: '₵', USD: '$', GBP: '£', EUR: '€', NGN: '₦', ZAR: 'R' };

// ===================================================
// CORE UTILITIES
// ===================================================

function getActiveWarehouseId() {
    return document.getElementById('warehouse-filter')?.value || '';
}

function getWarehouseName(id) {
    if (!id) return 'All warehouses';
    return warehousesCache.find(w => w.id === id)?.name || 'Warehouse';
}

function updateWarehouseScopeHints() {
    const whId = getActiveWarehouseId();
    const whName = getWarehouseName(whId);
    const hint = document.getElementById('products-warehouse-hint');
    if (hint) {
        hint.textContent = whId
            ? `Showing stock for ${whName} only. Change the warehouse in the top bar.`
            : 'Showing combined stock across all warehouses — pick one warehouse in the top bar to match what you entered when adding a product.';
    }
}

function formatCurrency(amount) {
    const num = parseFloat(amount) || 0;
    return currencySymbol + num.toLocaleString('en-GH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatSaleUnitType(type) {
    const labels = { carton: 'Carton', liter20: '20L Container' };
    return labels[type] || type;
}

function escapeHtml(text) {
    if (text === null || text === undefined) return '';
    const d = document.createElement('div');
    d.textContent = String(text);
    return d.innerHTML;
}

function escapeAttr(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
    toast.innerHTML = `<span class="toast-icon">${icons[type] || 'ℹ️'}</span><span class="toast-message">${escapeHtml(message)}</span>`;
    container.appendChild(toast);
    setTimeout(() => toast.classList.add('show'), 10);
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, 3500);
}

function showModal(id) {
    const modal = document.getElementById(id);
    if (modal) { modal.classList.add('active'); document.body.style.overflow = 'hidden'; }
}

function closeModal(id) {
    const modal = id ? document.getElementById(id) : document.querySelector('.modal.active');
    if (modal) { modal.classList.remove('active'); document.body.style.overflow = ''; }
}

function showConfirm(message, callback) {
    document.getElementById('confirm-message').textContent = message;
    confirmCallback = callback;
    showModal('confirm-modal');
}

function handleConfirmAction() {
    closeModal('confirm-modal');
    if (typeof confirmCallback === 'function') confirmCallback();
    confirmCallback = null;
}

function debounce(fn, delay) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn.apply(this, args), delay); };
}

async function fetchWithAuth(url, options = {}) {
    const headers = { 'Content-Type': 'application/json', ...options.headers };
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
    const res = await fetch(url, { ...options, headers });
    if (res.status === 401) {
        logout();
        throw new Error('Session expired. Please log in again.');
    }
    return res;
}

function canSeeTotalValue() {
    return currentUser?.role === 'admin' && showTotalValue !== false;
}

function applyTotalValueVisibility() {
    document.body.classList.toggle('hide-total-value', !canSeeTotalValue());
}

const ACTIVITY_TIMEOUT_MS = 15 * 60 * 1000;
let activityTimer = null;

function resetActivityTimer() {
    if (!authToken) return;
    clearTimeout(activityTimer);
    activityTimer = setTimeout(() => {
        showToast('Logged out due to inactivity', 'warning');
        logout();
    }, ACTIVITY_TIMEOUT_MS);
}

function clearActivityTimer() {
    clearTimeout(activityTimer);
    activityTimer = null;
}

function initActivityTimeout() {
    ['mousemove', 'keydown', 'click', 'scroll', 'touchstart'].forEach(evt => {
        document.addEventListener(evt, resetActivityTimer, { passive: true });
    });
}

function enforcePasswordChange() {
    forcePasswordChange = true;
    const title = document.getElementById('password-modal-title');
    if (title) title.textContent = 'You must change your password';
    document.querySelectorAll('#password-modal .modal-close').forEach(b => b.style.display = 'none');
    document.getElementById('password-form')?.reset();
    showModal('password-modal');
}

// ===================================================
// AUTH & NAVIGATION
// ===================================================

function showLoginScreen() {
    document.getElementById('login-screen').classList.add('active');
    document.getElementById('main-screen').classList.remove('active');
}

function showMainScreen() {
    document.getElementById('login-screen').classList.remove('active');
    document.getElementById('main-screen').classList.add('active');
}

async function loadUser() {
    try {
        const res = await fetchWithAuth(`${API_BASE}/auth/me`);
        if (!res.ok) throw new Error('Not authenticated');
        const user = await res.json();
        currentUser = user;
        localStorage.setItem('currentUser', JSON.stringify(user));
        document.getElementById('user-name').textContent = user.username;
        document.getElementById('user-role').textContent = user.role;
        document.getElementById('profile-username').value = user.username;
        document.getElementById('profile-email').value = user.email || '';
        document.getElementById('profile-role').value = user.role;
        if (user.role === 'admin') {
            document.getElementById('user-management-card').style.display = '';
            const auditNav = document.getElementById('audit-nav');
            if (auditNav) auditNav.style.display = '';
            const resetCard = document.getElementById('reset-card');
            if (resetCard) resetCard.style.display = (user.username === 'admin') ? '' : 'none';
            document.querySelectorAll('.admin-only-card').forEach(c => c.style.display = '');
        }
        applyTotalValueVisibility();
        return user;
    } catch (err) {
        return null;
    }
}

function logout() {
    authToken = null;
    currentUser = null;
    localStorage.removeItem('authToken');
    localStorage.removeItem('currentUser');
    disconnectRealtime();
    clearActivityTimer();
    showLoginScreen();
}

async function init() {
    initActivityTimeout();
    if (authToken) {
        const user = await loadUser();
        if (user) {
            showMainScreen();
            await loadWarehouses();
            await loadSettings();
            resetActivityTimer();
            if (user.must_change_password) {
                enforcePasswordChange();
            } else {
                switchSection('dashboard');
            }
        } else {
            logout();
        }
    } else {
        showLoginScreen();
    }
    setupEventListeners();
    initRealtime();
}

// ===================================================
// EVENT LISTENERS
// ===================================================

function setupEventListeners() {
    // Delegated handler for action buttons rendered in dynamic tables. Values are
    // passed via data-* attributes (escaped) instead of inline onclick handlers.
    document.addEventListener('click', (e) => {
        const el = e.target.closest('[data-action]');
        if (!el) return;
        const d = el.dataset;
        switch (d.action) {
            case 'open-stock-adjust': openStockAdjustModal(d.id, d.name); break;
            case 'edit-product': editProduct(d.id); break;
            case 'delete-product': confirmDeleteProduct(d.id, d.name); break;
            case 'edit-customer': editCustomer(d.id); break;
            case 'delete-customer': confirmDeleteCustomer(d.id, d.name); break;
            case 'view-receipt': viewReceipt(d.id); break;
            case 'open-return': openReturnModal(d.id); break;
            case 'mark-paid': markSalePaid(d.id); break;
            case 'edit-sale-status': editSaleStatus(d.id, d.status); break;
            case 'delete-sale': confirmDeleteSale(d.id); break;
            case 'mark-alert-read': markAlertRead(d.id); break;
            case 'delete-alert': confirmDeleteAlert(d.id); break;
            case 'edit-user': editUser(d.id); break;
            case 'revoke-sessions': confirmRevokeSessions(d.id, d.name); break;
            case 'delete-user': confirmDeleteUser(d.id, d.name); break;
            case 'edit-warehouse': openEditWarehouseModal(d.id, d.name, d.code, d.city, d.address, d.country); break;
            case 'deactivate-warehouse': confirmDeactivateWarehouse(d.id, d.name); break;
        }
    });

    // Login form
    const loginForm = document.getElementById('login-form');
    if (loginForm) {
        loginForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const username = document.getElementById('username').value.trim();
            const password = document.getElementById('password').value;
            const btn = loginForm.querySelector('button[type="submit"]');
            btn.textContent = 'Signing in...';
            btn.disabled = true;
            try {
                const res = await fetch(`${API_BASE}/auth/login`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, password })
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Login failed');
                authToken = data.token;
                currentUser = data.user;
                localStorage.setItem('authToken', authToken);
                localStorage.setItem('currentUser', JSON.stringify(currentUser));
                showMainScreen();
                initRealtime();
                await loadUser();
                await loadWarehouses();
                await loadSettings();
                resetActivityTimer();
                if (currentUser?.must_change_password) {
                    enforcePasswordChange();
                } else {
                    switchSection('dashboard');
                }
            } catch (err) {
                showToast(err.message, 'error');
            } finally {
                btn.textContent = 'Sign In';
                btn.disabled = false;
            }
        });
    }

    // Logout
    document.getElementById('logout-btn')?.addEventListener('click', logout);

    // User menu toggle
    document.getElementById('user-menu-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        document.getElementById('user-dropdown').classList.toggle('active');
    });

    // Sidebar toggle
    document.getElementById('sidebar-toggle')?.addEventListener('click', () => {
        document.getElementById('sidebar').classList.toggle('open');
    });

    // Nav items
    document.querySelectorAll('.nav-item[data-section]').forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            switchSection(item.dataset.section);
        });
    });

    // Dropdown nav links (profile, settings)
    document.querySelectorAll('[data-section]').forEach(el => {
        if (!el.classList.contains('nav-item')) {
            el.addEventListener('click', (e) => {
                e.preventDefault();
                switchSection(el.dataset.section);
                document.getElementById('user-dropdown').classList.remove('active');
            });
        }
    });

    // Close dropdown on outside click
    document.addEventListener('click', () => {
        document.getElementById('user-dropdown')?.classList.remove('active');
    });

    // Close modals
    document.querySelectorAll('.modal-close').forEach(btn => {
        btn.addEventListener('click', () => { if (!forcePasswordChange) closeModal(); });
    });
    document.querySelectorAll('.modal').forEach(modal => {
        modal.addEventListener('click', (e) => { if (e.target === modal && !forcePasswordChange) closeModal(modal.id); });
    });

    // Confirm modal OK button
    document.getElementById('confirm-ok')?.addEventListener('click', handleConfirmAction);

    // Product form
    document.getElementById('add-product-btn')?.addEventListener('click', () => openProductModal());
    document.getElementById('product-form')?.addEventListener('submit', handleProductSubmit);
    document.getElementById('product-unit-price')?.addEventListener('input', updateCartonPrice);
    document.getElementById('product-carton-price')?.addEventListener('input', () => {
        document.getElementById('product-carton-price').dataset.autoSet = 'false';
    });

    // Customer form
    document.getElementById('add-customer-btn')?.addEventListener('click', () => openCustomerModal());
    document.getElementById('customer-form')?.addEventListener('submit', handleCustomerSubmit);

    // Sales
    document.getElementById('new-sale-btn')?.addEventListener('click', openSaleModal);
    document.getElementById('sale-form')?.addEventListener('submit', handleSaleSubmit);
    document.getElementById('status-form')?.addEventListener('submit', handleStatusSubmit);
    document.getElementById('add-sale-item')?.addEventListener('click', addSaleItemRow);
    document.getElementById('sale-discount')?.addEventListener('input', updateSaleSummary);
    document.getElementById('sale-search')?.addEventListener('input', debounce(loadSales, 400));
    document.getElementById('sale-status-filter')?.addEventListener('change', loadSales);
    document.getElementById('sale-date-from')?.addEventListener('change', loadSales);
    document.getElementById('sale-date-to')?.addEventListener('change', loadSales);

    // Alerts
    document.getElementById('mark-all-read-btn')?.addEventListener('click', markAllAlertsRead);
    document.getElementById('show-unread-only')?.addEventListener('change', loadAlerts);

    // Settings
    document.getElementById('company-settings-form')?.addEventListener('submit', handleCompanySettings);
    document.getElementById('system-settings-form')?.addEventListener('submit', handleSystemSettings);

    // Users
    document.getElementById('add-user-btn')?.addEventListener('click', () => openUserModal());
    document.getElementById('user-form')?.addEventListener('submit', handleUserSubmit);

    // Warehouses
    document.getElementById('add-warehouse-btn')?.addEventListener('click', () => openAddWarehouseModal());
    document.getElementById('warehouse-form')?.addEventListener('submit', handleWarehouseSubmit);

    // System reset
    document.getElementById('reset-system-btn')?.addEventListener('click', () => showModal('reset-confirm-modal'));
    document.getElementById('reset-continue-btn')?.addEventListener('click', () => {
        closeModal('reset-confirm-modal');
        document.getElementById('reset-password').value = '';
        showModal('reset-password-modal');
    });
    document.getElementById('reset-password-form')?.addEventListener('submit', handleSystemReset);

    // Profile
    document.getElementById('change-password-btn')?.addEventListener('click', () => showModal('password-modal'));
    document.getElementById('password-form')?.addEventListener('submit', handlePasswordChange);

    // Print receipt
    document.getElementById('print-receipt-btn')?.addEventListener('click', printReceipt);

    // Product search
    document.getElementById('product-search')?.addEventListener('input', debounce(loadProducts, 400));
    document.getElementById('show-low-stock-only')?.addEventListener('change', loadProducts);

    // Customer search
    document.getElementById('customer-search')?.addEventListener('input', debounce(loadCustomers, 400));

    // Global search
    document.getElementById('global-search')?.addEventListener('input', debounce(handleGlobalSearch, 400));

    // Warehouse filter
    document.getElementById('warehouse-filter')?.addEventListener('change', () => {
        updateWarehouseScopeHints();
        const activeSection = document.querySelector('.nav-item.active')?.dataset.section;
        if (activeSection) switchSection(activeSection);
    });

    // Stock filters
    document.getElementById('stock-warehouse-filter')?.addEventListener('change', loadStock);
    document.getElementById('stock-show-low-only')?.addEventListener('change', loadStock);
    document.getElementById('export-stock-btn')?.addEventListener('click', exportStockToExcel);

    // Stock adjustment
    document.getElementById('stock-adjust-form')?.addEventListener('submit', handleStockAdjustSubmit);
    document.getElementById('stock-adjust-unit-type')?.addEventListener('change', loadCurrentStockForAdjustment);
    document.getElementById('stock-adjust-warehouse')?.addEventListener('change', loadCurrentStockForAdjustment);

    // Transfers
    document.getElementById('new-transfer-btn')?.addEventListener('click', openTransferModal);
    document.getElementById('transfer-form')?.addEventListener('submit', handleTransferSubmit);

    // Returns
    document.getElementById('new-return-btn')?.addEventListener('click', () => openReturnModal());
    document.getElementById('return-form')?.addEventListener('submit', handleReturnSubmit);

    // Audit
    document.getElementById('audit-search')?.addEventListener('input', debounce(loadAudit, 400));

    // Sales export
    document.getElementById('export-sales-btn')?.addEventListener('click', exportSales);

    // Discount type change recalculates summary
    document.getElementById('sale-discount-type')?.addEventListener('change', updateSaleSummary);

    // Keyboard escape closes modal
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

    // Window resize
    window.addEventListener('resize', handleResize);
}

function handleResize() {
    if (window.innerWidth > 768) {
        document.getElementById('sidebar')?.classList.remove('open');
    }
}

// ===================================================
// SECTION NAVIGATION
// ===================================================

function switchSection(section) {
    if (forcePasswordChange && section !== 'profile') {
        enforcePasswordChange();
        return;
    }
    document.querySelectorAll('.content-section').forEach(s => s.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

    const sectionEl = document.getElementById(`${section}-section`);
    const navItem = document.querySelector(`.nav-item[data-section="${section}"]`);
    if (sectionEl) sectionEl.classList.add('active');
    if (navItem) navItem.classList.add('active');

    document.getElementById('sidebar')?.classList.remove('open');
    document.getElementById('user-dropdown')?.classList.remove('active');

    switch (section) {
        case 'dashboard': loadDashboard(); break;
        case 'stock': loadStock(); loadWarehouses(); break;
        case 'warehouses': loadWarehouseManagement(); break;
        case 'products': loadWarehouses(); updateWarehouseScopeHints(); loadProducts(); break;
        case 'customers': loadCustomers(); break;
        case 'sales': loadSales(); break;
        case 'transfers': loadTransfers(); loadWarehouses(); loadProductsForSelect(); break;
        case 'returns': loadReturns(); break;
        case 'audit': loadAudit(); break;
        case 'reports': loadReports(); break;
        case 'alerts': loadAlerts(); break;
        case 'settings': loadSettings(); if (currentUser?.role === 'admin') loadUsers(); break;
        case 'profile': break;
    }
}

// ===================================================
// WAREHOUSES
// ===================================================

async function loadWarehouses() {
    try {
        const res = await fetchWithAuth(`${API_BASE}/warehouses`);
        const all = await res.json();
        warehousesCache = all.filter(w => w.is_active === 1);
        const selectors = ['warehouse-filter', 'stock-warehouse-filter', 'sale-warehouse', 'stock-adjust-warehouse', 'product-initial-warehouse'];
        selectors.forEach(id => {
            const select = document.getElementById(id);
            if (!select) return;
            const current = select.value;
            const allLabel = (id === 'sale-warehouse' || id === 'stock-adjust-warehouse' || id === 'product-initial-warehouse') ? 'Select Warehouse' : 'All Warehouses';
            select.innerHTML = `<option value="">${allLabel}</option>` +
                warehousesCache.map(w => `<option value="${w.id}">${escapeHtml(w.name)} (${w.code})</option>`).join('');
            if (current) select.value = current;
        });
    } catch (err) {
        console.error('Load warehouses error:', err);
    }
}

// ===================================================
// DASHBOARD
// ===================================================

async function loadDashboard() {
    try {
        const warehouseId = document.getElementById('warehouse-filter')?.value || '';
        const whParam = warehouseId ? `?warehouse_id=${warehouseId}` : '';

        const [inventoryRes, alertsRes] = await Promise.all([
            fetchWithAuth(`${API_BASE}/reports/inventory${whParam}`),
            fetchWithAuth(`${API_BASE}/alerts/unread-count${whParam}`)
        ]);

        const inventory = await inventoryRes.json();
        const alertsData = await alertsRes.json();

        const showValue = canSeeTotalValue();
        document.getElementById('dashboard-stats').innerHTML = `
            <div class="stat-card primary">
                <div class="stat-icon">📦</div>
                <div class="stat-info"><h4>Total Products</h4><div class="stat-value">${inventory.summary?.total_products ?? 0}</div></div>
            </div>
            ${showValue ? `
            <div class="stat-card success">
                <div class="stat-icon">💰</div>
                <div class="stat-info"><h4>Inventory Value</h4><div class="stat-value">${formatCurrency(inventory.summary?.total_inventory_value ?? 0)}</div></div>
            </div>` : ''}
            <div class="stat-card warning">
                <div class="stat-icon">📊</div>
                <div class="stat-info"><h4>Cartons + 20L (total)</h4><div class="stat-value">${inventory.summary?.total_stock_items ?? 0}</div></div>
            </div>
            <div class="stat-card danger">
                <div class="stat-icon">⚠️</div>
                <div class="stat-info"><h4>Low Stock Alerts</h4><div class="stat-value">${inventory.summary?.low_stock_count ?? 0}</div></div>
            </div>`;

        const lowCount = inventory.summary?.low_stock_count ?? 0;
        const alertCount = alertsData.count ?? 0;
        document.getElementById('low-stock-badge').textContent = lowCount;
        document.getElementById('low-stock-badge').style.display = lowCount > 0 ? 'inline-flex' : 'none';
        document.getElementById('alert-badge-nav').textContent = alertCount;
        document.getElementById('alert-badge-nav').style.display = alertCount > 0 ? 'inline-flex' : 'none';
        document.getElementById('alert-count').textContent = alertCount;
        document.getElementById('alert-badge').style.display = alertCount > 0 ? 'flex' : 'none';

        const lowStockItems = inventory.low_stock_items || [];
        document.getElementById('low-stock-list').innerHTML = lowStockItems.length > 0
            ? lowStockItems.slice(0, 5).map(p => `
                <div class="alert-item alert-warning">
                    <strong>${escapeHtml(p.name)}</strong> — Cartons: ${p.carton_stock}, 20L: ${p.liter20_stock}
                    <small>(Threshold: ${p.low_stock_threshold})</small>
                </div>`).join('')
            : '<div class="empty-state"><h4>All Good</h4><p>No low stock alerts</p></div>';

        const recentRes = await fetchWithAuth(`${API_BASE}/sales?limit=5${warehouseId ? '&warehouse_id=' + warehouseId : ''}`);
        const recentSales = await recentRes.json();
        document.getElementById('recent-sales-list').innerHTML = recentSales.length > 0
            ? recentSales.map(s => `
                <div class="sale-item">
                    <div class="sale-item-info">
                        <span class="sale-item-name">${escapeHtml(s.customer_name || 'Walk-in Customer')}</span>
                        <span class="sale-item-date">${new Date(s.sale_date).toLocaleDateString()}</span>
                    </div>
                    <div class="price-tag">${formatCurrency(s.total)}</div>
                </div>`).join('')
            : '<div class="empty-state"><h4>No Sales Yet</h4><p>Recent sales will appear here</p></div>';

        const dailyRes = await fetchWithAuth(`${API_BASE}/reports/sales/daily?days=30${warehouseId ? '&warehouse_id=' + warehouseId : ''}`);
        const dailySales = await dailyRes.json();
        const chartEl = document.getElementById('dashboard-chart');
        if (chartEl) {
            if (dailySales.length) {
                const maxRevenue = Math.max(...dailySales.map(d => d.daily_revenue), 1);
                chartEl.innerHTML = dailySales.slice(-30).map(d => {
                    const pct = (d.daily_revenue / maxRevenue) * 100;
                    return `<div class="chart-bar-wrap" title="${d.sale_day}: ${formatCurrency(d.daily_revenue)}">
                        <div class="chart-bar" style="height:${Math.max(pct, 2)}%"></div>
                        <div class="chart-label">${d.sale_day?.slice(5)}</div>
                    </div>`;
                }).join('');
            } else {
                chartEl.innerHTML = '<div class="empty-state"><h4>No sales yet</h4></div>';
            }
        }
    } catch (err) {
        console.error('Dashboard error:', err);
        showToast('Failed to load dashboard', 'error');
    }
}

// ===================================================
// STOCK
// ===================================================

async function loadStock() {
    try {
        const warehouseId = document.getElementById('stock-warehouse-filter')?.value || '';
        const showLowOnly = document.getElementById('stock-show-low-only')?.checked;
        const params = new URLSearchParams();
        if (warehouseId) params.append('warehouse_id', warehouseId);
        if (showLowOnly) params.append('low_stock', 'true');

        const res = await fetchWithAuth(`${API_BASE}/products?${params}`);
        const products = await res.json();
        const tbody = document.querySelector('#stock-table tbody');

        if (!products.length) {
            tbody.innerHTML = '<tr><td colspan="10" class="empty-state"><h4>No Products</h4><p>Add products to see stock here</p></td></tr>';
            return;
        }

        const whName = warehouseId ? (warehousesCache.find(w => w.id === warehouseId)?.name || 'Selected') : 'All (combined)';

        tbody.innerHTML = products.map(p => {
            const cartonStock = p.warehouse_carton_stock ?? p.total_carton_stock ?? 0;
            const liter20Stock = p.warehouse_liter20_stock ?? p.total_liter20_stock ?? 0;
            const totalValue = (p.carton_price * cartonStock) + (p.liter20_price * liter20Stock);
            const isLow = cartonStock <= p.low_stock_threshold || liter20Stock <= p.low_stock_threshold;
            const cls = (stock) => stock <= p.low_stock_threshold ? 'stock-low' : (stock === 0 ? 'stock-warning' : 'stock-ok');
            return `<tr${isLow ? ' class="low-stock-row"' : ''}>
                <td><strong>${escapeHtml(p.name)}</strong><br><small style="color:var(--text-muted)">${escapeHtml(p.description || '—')}</small></td>
                <td>${escapeHtml(whName)}</td>
                <td>${formatCurrency(p.carton_price)}</td>
                <td>${formatCurrency(p.liter20_price)}</td>
                <td class="${cls(cartonStock)}">${cartonStock}</td>
                <td class="${cls(liter20Stock)}">${liter20Stock}</td>
                <td>${p.low_stock_threshold}</td>
                <td class="total-value-col"><strong>${formatCurrency(totalValue)}</strong></td>
                <td><span class="status-badge ${isLow ? 'status-pending' : 'status-completed'}">${isLow ? 'Low Stock' : 'OK'}</span></td>
                <td><button class="action-btn edit" data-action="open-stock-adjust" data-id="${p.id}" data-name="${escapeAttr(p.name)}">⚙️ Adjust</button></td>
            </tr>`;
        }).join('');
    } catch (err) {
        console.error('Stock error:', err);
        showToast('Failed to load stock', 'error');
    }
}

async function exportStockToExcel() {
    try {
        const warehouseId = document.getElementById('stock-warehouse-filter')?.value || '';
        const params = warehouseId ? `?warehouse_id=${warehouseId}&format=excel` : '?format=excel';
        showToast('Generating Excel file...', 'info');
        const res = await fetch(`${API_BASE}/products/stock/export${params}`, {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        if (!res.ok) { const e = await res.json(); throw new Error(e.error || 'Export failed'); }
        const blob = await res.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `stock-report-${new Date().toISOString().split('T')[0]}.xlsx`;
        document.body.appendChild(a); a.click();
        window.URL.revokeObjectURL(url); document.body.removeChild(a);
        showToast('Stock exported successfully', 'success');
    } catch (err) {
        showToast(err.message, 'error');
    }
}

function openStockAdjustModal(productId, productName) {
    document.getElementById('stock-adjust-product-id').value = productId;
    document.getElementById('stock-adjust-product-name').value = productName;
    document.getElementById('stock-adjust-quantity').value = '';
    document.getElementById('stock-adjust-notes').value = '';
    loadCurrentStockForAdjustment();
    showModal('stock-adjust-modal');
}

async function loadCurrentStockForAdjustment() {
    const productId = document.getElementById('stock-adjust-product-id').value;
    const warehouseId = document.getElementById('stock-adjust-warehouse').value;
    const unitType = document.getElementById('stock-adjust-unit-type').value;
    if (!productId || !warehouseId) { document.getElementById('stock-adjust-current').value = ''; return; }
    try {
        const res = await fetchWithAuth(`${API_BASE}/products/${productId}?warehouse_id=${warehouseId}`);
        const product = await res.json();
        const fieldMap = { carton: 'warehouse_carton_stock', liter20: 'warehouse_liter20_stock' };
        document.getElementById('stock-adjust-current').value = product[fieldMap[unitType]] ?? 0;
    } catch (err) { console.error(err); }
}

async function handleStockAdjustSubmit(e) {
    e.preventDefault();
    const productId = document.getElementById('stock-adjust-product-id').value;
    const warehouseId = document.getElementById('stock-adjust-warehouse').value;
    if (!warehouseId) { showToast('Please select a warehouse', 'error'); return; }
    const data = {
        movement_type: document.getElementById('stock-adjust-movement-type').value,
        unit_type: document.getElementById('stock-adjust-unit-type').value,
        quantity: parseInt(document.getElementById('stock-adjust-quantity').value),
        warehouse_id: warehouseId,
        notes: document.getElementById('stock-adjust-notes').value.trim(),
        reference_type: 'stock_adjustment'
    };
    try {
        const res = await fetchWithAuth(`${API_BASE}/products/${productId}/stock-movement`, { method: 'POST', body: JSON.stringify(data) });
        const result = await res.json();
        if (!res.ok) throw new Error(result.error);
        showToast('Stock adjusted successfully', 'success');
        closeModal('stock-adjust-modal');
        loadStock(); loadDashboard();
    } catch (err) { showToast(err.message, 'error'); }
}

// ===================================================
// PRODUCTS
// ===================================================

async function loadProducts() {
    try {
        const search = document.getElementById('product-search')?.value || '';
        const lowStock = document.getElementById('show-low-stock-only')?.checked;
        const params = new URLSearchParams();
        if (search) params.append('search', search);
        if (lowStock) params.append('low_stock', 'true');

        const res = await fetchWithAuth(`${API_BASE}/products?${params}`);
        const products = await res.json();
        const tbody = document.querySelector('#products-table tbody');

        if (!products.length) {
            tbody.innerHTML = '<tr><td colspan="11" class="empty-state"><h4>No Products</h4><p>Click "Add Product" to get started</p></td></tr>';
            return;
        }

        tbody.innerHTML = products.map(p => {
            const cartonStock = p.total_carton_stock ?? 0;
            const liter20Stock = p.total_liter20_stock ?? 0;
            const totalValue = (p.carton_price * cartonStock) + (p.liter20_price * liter20Stock);
            const isLow = cartonStock <= p.low_stock_threshold || liter20Stock <= p.low_stock_threshold;
            return `<tr${isLow ? ' class="low-stock-row"' : ''}>
                <td><strong>${escapeHtml(p.name)}</strong>${p.description ? `<br><small style="color:var(--text-muted)">${escapeHtml(p.description)}</small>` : ''}</td>
                <td>${escapeHtml(p.sku || '—')}</td>
                <td>${formatCurrency(p.unit_price)}</td>
                <td>${formatCurrency(p.carton_price)}</td>
                <td>${formatCurrency(p.liter20_price)}</td>
                <td class="${cartonStock <= p.low_stock_threshold ? 'stock-low' : 'stock-ok'}">${cartonStock}</td>
                <td class="${liter20Stock <= p.low_stock_threshold ? 'stock-low' : 'stock-ok'}">${liter20Stock}</td>
                <td>${p.low_stock_threshold}</td>
                <td class="total-value-col"><strong>${formatCurrency(totalValue)}</strong></td>
                <td>
                    <button class="action-btn edit" data-action="edit-product" data-id="${p.id}">✏️ Edit</button>
                    <button class="action-btn delete" data-action="delete-product" data-id="${p.id}" data-name="${escapeAttr(p.name)}">🗑️ Delete</button>
                </td>
            </tr>`;
        }).join('');
    } catch (err) {
        console.error('Products error:', err);
        showToast('Failed to load products', 'error');
    }
}

async function openProductModal(productId = null) {
    const form = document.getElementById('product-form');
    form.reset();
    document.getElementById('product-id').value = '';
    document.getElementById('product-modal-title').textContent = 'Add Product';
    document.getElementById('product-threshold').value = defaultThreshold;
    const stockSection = document.getElementById('product-initial-stock-section');
    const whSelect = document.getElementById('product-initial-warehouse');
    if (stockSection) stockSection.style.display = '';
    if (whSelect) { whSelect.required = true; }
    await loadWarehouses();
    const globalWh = document.getElementById('warehouse-filter')?.value;
    if (globalWh && whSelect) whSelect.value = globalWh;
    if (productId) {
        if (stockSection) stockSection.style.display = 'none';
        if (whSelect) { whSelect.required = false; whSelect.value = ''; }
        fetchWithAuth(`${API_BASE}/products/${productId}`)
            .then(r => r.json())
            .then(p => {
                document.getElementById('product-modal-title').textContent = 'Edit Product';
                document.getElementById('product-id').value = p.id;
                document.getElementById('product-name').value = p.name;
                document.getElementById('product-sku').value = p.sku || '';
                document.getElementById('product-description').value = p.description || '';
                document.getElementById('product-unit-price').value = p.unit_price;
                document.getElementById('product-carton-price').value = p.carton_price;
                document.getElementById('product-liter20-price').value = p.liter20_price;
                document.getElementById('product-threshold').value = p.low_stock_threshold;
                const cartonWasAuto = Math.abs(p.carton_price - (p.unit_price * 12)) < 0.01;
                document.getElementById('product-carton-price').dataset.autoSet = cartonWasAuto ? 'true' : 'false';
            }).catch(err => showToast(err.message, 'error'));
    } else {
        document.getElementById('product-carton-price').dataset.autoSet = 'true';
    }
    showModal('product-modal');
}

function editProduct(id) { openProductModal(id); }

function updateCartonPrice() {
    const unitPrice = parseFloat(document.getElementById('product-unit-price').value) || 0;
    const cartonField = document.getElementById('product-carton-price');
    if (!cartonField.value || cartonField.dataset.autoSet === 'true') {
        cartonField.value = (unitPrice * 12).toFixed(2);
        cartonField.dataset.autoSet = 'true';
    }
}

async function handleProductSubmit(e) {
    e.preventDefault();
    const id = document.getElementById('product-id').value;
    const data = {
        name: document.getElementById('product-name').value.trim(),
        sku: document.getElementById('product-sku')?.value.trim() || null,
        description: document.getElementById('product-description').value.trim(),
        unit_price: parseFloat(document.getElementById('product-unit-price').value),
        carton_price: parseFloat(document.getElementById('product-carton-price').value) || null,
        liter20_price: parseFloat(document.getElementById('product-liter20-price').value) || 0,
        low_stock_threshold: parseInt(document.getElementById('product-threshold').value) || 10
    };
    if (!id) {
        const warehouseId = document.getElementById('product-initial-warehouse')?.value;
        if (!warehouseId) {
            showToast('Please select which warehouse to add stock to', 'error');
            return;
        }
        data.warehouse_id = warehouseId;
        data.carton_stock = parseInt(document.getElementById('product-carton-stock')?.value, 10) || 0;
        data.liter20_stock = parseInt(document.getElementById('product-liter20-stock')?.value, 10) || 0;
    }
    try {
        const url = id ? `${API_BASE}/products/${id}` : `${API_BASE}/products`;
        const method = id ? 'PUT' : 'POST';
        const res = await fetchWithAuth(url, { method, body: JSON.stringify(data) });
        const result = await res.json();
        if (!res.ok) throw new Error(result.error);
        showToast(id ? 'Product updated' : 'Product added', 'success');
        closeModal('product-modal');
        loadProducts(); loadDashboard();
    } catch (err) { showToast(err.message, 'error'); }
}

function confirmDeleteProduct(id, name) {
    showConfirm(`Delete product "${name}"? This cannot be undone.`, () => deleteProduct(id));
}

async function deleteProduct(id) {
    try {
        const res = await fetchWithAuth(`${API_BASE}/products/${id}`, { method: 'DELETE' });
        const result = await res.json();
        if (!res.ok) throw new Error(result.error);
        showToast('Product deleted', 'success');
        loadProducts(); loadDashboard();
    } catch (err) { showToast(err.message, 'error'); }
}

async function loadProductsForSelect() {
    try {
        const warehouseId = document.getElementById('sale-warehouse')?.value || '';
        const params = warehouseId ? `?warehouse_id=${warehouseId}` : '';
        const res = await fetchWithAuth(`${API_BASE}/products${params}`);
        const products = await res.json();
        const options = '<option value="">Select Product</option>' +
            products.map(p => `<option value="${p.id}" data-unit="${p.unit_price}" data-carton="${p.carton_price}" data-liter20="${p.liter20_price}">${escapeHtml(p.name)}</option>`).join('');
        document.querySelectorAll('.sale-item-product').forEach(s => s.innerHTML = options);
    } catch (err) { console.error('Load products for select error:', err); }
}

// ===================================================
// CUSTOMERS
// ===================================================

async function loadCustomers() {
    try {
        const search = document.getElementById('customer-search')?.value || '';
        const params = search ? `?search=${encodeURIComponent(search)}` : '';
        const res = await fetchWithAuth(`${API_BASE}/customers${params}`);
        const customers = await res.json();
        const tbody = document.querySelector('#customers-table tbody');

        if (!customers.length) {
            tbody.innerHTML = '<tr><td colspan="8" class="empty-state"><h4>No Customers</h4><p>Click "Add Customer" to get started</p></td></tr>';
            return;
        }

        tbody.innerHTML = customers.map(c => `
            <tr>
                <td><strong>${escapeHtml(c.name)}</strong></td>
                <td>${escapeHtml(c.email || '—')}</td>
                <td>${escapeHtml(c.phone || '—')}</td>
                <td>${escapeHtml([c.city, c.state, c.country].filter(Boolean).join(', ') || '—')}</td>
                <td>${c.purchase_count ?? 0}</td>
                <td>${formatCurrency(c.total_spent ?? 0)}</td>
                <td>${c.last_purchase ? new Date(c.last_purchase).toLocaleDateString() : '—'}</td>
                <td>
                    <button class="action-btn edit" data-action="edit-customer" data-id="${c.id}">✏️ Edit</button>
                    <button class="action-btn delete" data-action="delete-customer" data-id="${c.id}" data-name="${escapeAttr(c.name)}">🗑️ Delete</button>
                </td>
            </tr>`).join('');
    } catch (err) {
        console.error('Customers error:', err);
        showToast('Failed to load customers', 'error');
    }
}

function openCustomerModal() {
    document.getElementById('customer-form').reset();
    document.getElementById('customer-id').value = '';
    document.getElementById('customer-modal-title').textContent = 'Add Customer';
    document.getElementById('customer-country').value = 'Ghana';
    showModal('customer-modal');
}

function editCustomer(id) {
    fetchWithAuth(`${API_BASE}/customers/${id}`)
        .then(r => r.json())
        .then(c => {
            document.getElementById('customer-modal-title').textContent = 'Edit Customer';
            document.getElementById('customer-id').value = c.id;
            document.getElementById('customer-name').value = c.name;
            document.getElementById('customer-email').value = c.email || '';
            document.getElementById('customer-phone').value = c.phone || '';
            document.getElementById('customer-tax-id').value = c.tax_id || '';
            document.getElementById('customer-address').value = c.address || '';
            document.getElementById('customer-city').value = c.city || '';
            document.getElementById('customer-state').value = c.state || '';
            document.getElementById('customer-postal-code').value = c.postal_code || '';
            document.getElementById('customer-country').value = c.country || 'Ghana';
            document.getElementById('customer-notes').value = c.notes || '';
            showModal('customer-modal');
        }).catch(err => showToast(err.message, 'error'));
}

async function handleCustomerSubmit(e) {
    e.preventDefault();
    const id = document.getElementById('customer-id').value;
    const data = {
        name: document.getElementById('customer-name').value.trim(),
        email: document.getElementById('customer-email').value.trim(),
        phone: document.getElementById('customer-phone').value.trim(),
        tax_id: document.getElementById('customer-tax-id').value.trim(),
        address: document.getElementById('customer-address').value.trim(),
        city: document.getElementById('customer-city').value.trim(),
        state: document.getElementById('customer-state').value.trim(),
        postal_code: document.getElementById('customer-postal-code').value.trim(),
        country: document.getElementById('customer-country').value.trim(),
        notes: document.getElementById('customer-notes').value.trim()
    };
    try {
        const url = id ? `${API_BASE}/customers/${id}` : `${API_BASE}/customers`;
        const method = id ? 'PUT' : 'POST';
        const res = await fetchWithAuth(url, { method, body: JSON.stringify(data) });
        const result = await res.json();
        if (!res.ok) throw new Error(result.error);
        showToast(id ? 'Customer updated' : 'Customer added', 'success');
        closeModal('customer-modal');
        loadCustomers();
    } catch (err) { showToast(err.message, 'error'); }
}

function confirmDeleteCustomer(id, name) {
    showConfirm(`Delete customer "${name}"? This cannot be undone.`, async () => {
        try {
            const res = await fetchWithAuth(`${API_BASE}/customers/${id}`, { method: 'DELETE' });
            const result = await res.json();
            if (!res.ok) throw new Error(result.error);
            showToast('Customer deleted', 'success');
            loadCustomers();
        } catch (err) { showToast(err.message, 'error'); }
    });
}

async function loadCustomersForSelect() {
    try {
        const res = await fetchWithAuth(`${API_BASE}/customers`);
        const customers = await res.json();
        const select = document.getElementById('sale-customer');
        if (select) {
            select.innerHTML = '<option value="">Walk-in Customer</option>' +
                customers.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
        }
    } catch (err) { console.error(err); }
}

// ===================================================
// SALES
// ===================================================

async function loadSales() {
    try {
        const search = document.getElementById('sale-search')?.value || '';
        const status = document.getElementById('sale-status-filter')?.value || '';
        const dateFrom = document.getElementById('sale-date-from')?.value || '';
        const dateTo = document.getElementById('sale-date-to')?.value || '';
        const warehouseId = document.getElementById('warehouse-filter')?.value || '';
        const params = new URLSearchParams();
        if (search) params.append('search', search);
        if (status) params.append('payment_status', status);
        if (dateFrom) params.append('start_date', dateFrom);
        if (dateTo) params.append('end_date', dateTo);
        if (warehouseId) params.append('warehouse_id', warehouseId);
        params.append('limit', '100');

        const res = await fetchWithAuth(`${API_BASE}/sales?${params}`);
        const sales = await res.json();
        const tbody = document.querySelector('#sales-table tbody');
        const isAdmin = currentUser?.role === 'admin';

        if (!sales.length) {
            tbody.innerHTML = '<tr><td colspan="10" class="empty-state"><h4>No Sales</h4><p>Click "New Sale" to record your first sale</p></td></tr>';
            return;
        }

        tbody.innerHTML = sales.map(s => `
            <tr>
                <td>${new Date(s.sale_date).toLocaleDateString()}</td>
                <td>${escapeHtml(s.customer_name || 'Walk-in')}</td>
                <td>${s.item_count ?? '—'}</td>
                <td>${formatCurrency(s.subtotal)}</td>
                <td>${formatCurrency(s.tax)}</td>
                <td>${formatCurrency(s.discount)}</td>
                <td><strong>${formatCurrency(s.total)}</strong></td>
                <td>${escapeHtml(s.payment_method)}</td>
                <td><span class="status-badge status-${s.payment_status}">${s.payment_status}</span></td>
                <td>
                    <button class="action-btn view" data-action="view-receipt" data-id="${s.id}">👁️ View</button>
                    <button class="action-btn view" data-action="open-return" data-id="${s.id}">↩️ Return</button>
                    ${s.payment_status === 'pending' ? `<button class="action-btn edit" data-action="mark-paid" data-id="${s.id}">💵 Mark Paid</button>` : ''}
                    ${isAdmin ? `
                        <button class="action-btn edit" data-action="edit-sale-status" data-id="${s.id}" data-status="${s.payment_status}">✏️ Status</button>
                        <button class="action-btn delete" data-action="delete-sale" data-id="${s.id}">🗑️ Delete</button>
                    ` : ''}
                </td>
            </tr>`).join('');
    } catch (err) {
        console.error('Sales error:', err);
        showToast('Failed to load sales', 'error');
    }
}

async function openSaleModal() {
    document.getElementById('sale-form').reset();
    document.getElementById('sale-items-container').innerHTML = buildSaleItemRow();
    await loadCustomersForSelect();
    await loadWarehouses();
    await loadProductsForSelect();
    document.getElementById('sale-warehouse')?.addEventListener('change', loadProductsForSelect);
    attachSaleItemEvents(document.querySelector('.sale-item-row'));
    updateSaleSummary();
    showModal('sale-modal');
}

function buildSaleItemRow() {
    return `<div class="sale-item-row">
        <select class="sale-item-product" required><option value="">Select Product</option></select>
        <select class="sale-item-unit" required>
            <option value="carton">Carton</option>
            <option value="liter20">20L Container</option>
        </select>
        <input type="number" class="sale-item-qty" min="1" value="1" required>
        <input type="number" class="sale-item-discount" step="0.01" min="0" value="0" title="Line discount (₵)" placeholder="Disc.">
        <span class="sale-item-price"></span>
        <span class="sale-item-total">${formatCurrency(0)}</span>
        <button type="button" class="btn btn-icon btn-danger remove-item" aria-label="Remove item">×</button>
    </div>`;
}

function attachSaleItemEvents(row) {
    row.querySelector('.sale-item-product').addEventListener('change', updateSaleItemPrice);
    row.querySelector('.sale-item-unit').addEventListener('change', updateSaleItemPrice);
    row.querySelector('.sale-item-qty').addEventListener('input', updateSaleSummary);
    row.querySelector('.sale-item-discount').addEventListener('input', updateSaleSummary);
    row.querySelector('.remove-item').addEventListener('click', () => {
        if (document.querySelectorAll('.sale-item-row').length > 1) { row.remove(); updateSaleSummary(); }
    });
}

function addSaleItemRow() {
    const container = document.getElementById('sale-items-container');
    container.insertAdjacentHTML('beforeend', buildSaleItemRow());
    const newRow = container.lastElementChild;
    const firstOptions = container.querySelector('.sale-item-product').innerHTML;
    newRow.querySelector('.sale-item-product').innerHTML = firstOptions;
    attachSaleItemEvents(newRow);
}

function priceForRow(row) {
    const option = row.querySelector('.sale-item-product').selectedOptions[0];
    const unitType = row.querySelector('.sale-item-unit').value;
    if (!option || !option.value) return 0;
    if (unitType === 'carton') return parseFloat(option.dataset.carton) || 0;
    if (unitType === 'liter20') return parseFloat(option.dataset.liter20) || 0;
    return 0;
}

function updateSaleItemPrice() {
    const row = this.closest('.sale-item-row');
    const qty = parseInt(row.querySelector('.sale-item-qty').value) || 0;
    const price = priceForRow(row);
    row.querySelector('.sale-item-price').textContent = formatCurrency(price) + ' each';
    row.querySelector('.sale-item-total').textContent = formatCurrency(price * qty);
    updateSaleSummary();
}

function updateSaleSummary() {
    let subtotal = 0;
    document.querySelectorAll('.sale-item-row').forEach(row => {
        const qty = parseInt(row.querySelector('.sale-item-qty').value) || 0;
        const price = priceForRow(row);
        const lineDiscount = parseFloat(row.querySelector('.sale-item-discount').value) || 0;
        const lineTotal = Math.max(0, (price * qty) - lineDiscount);
        row.querySelector('.sale-item-total').textContent = formatCurrency(lineTotal);
        subtotal += lineTotal;
    });
    const tax = taxEnabled ? subtotal * taxRate : 0;
    const discount = parseFloat(document.getElementById('sale-discount')?.value) || 0;
    const discountType = document.getElementById('sale-discount-type')?.value || 'amount';
    const discountAmount = discountType === 'percent' ? subtotal * (discount / 100) : discount;
    const total = Math.max(0, subtotal + tax - discountAmount);
    document.getElementById('sale-subtotal').textContent = formatCurrency(subtotal);
    document.getElementById('sale-tax').textContent = formatCurrency(tax);
    document.getElementById('sale-discount-display').textContent = formatCurrency(discountAmount);
    document.getElementById('sale-total').textContent = formatCurrency(total);
}

async function handleSaleSubmit(e) {
    e.preventDefault();
    const warehouseId = document.getElementById('sale-warehouse')?.value;
    if (!warehouseId) { showToast('Please select a warehouse', 'error'); return; }
    const items = [];
    let hasError = false;
    document.querySelectorAll('.sale-item-row').forEach(row => {
        const productId = row.querySelector('.sale-item-product').value;
        if (!productId) { hasError = true; return; }
        const unitType = row.querySelector('.sale-item-unit').value;
        const qty = parseInt(row.querySelector('.sale-item-qty').value);
        const price = priceForRow(row);
        const discount = parseFloat(row.querySelector('.sale-item-discount').value) || 0;
        items.push({ product_id: productId, unit_type: unitType, quantity: qty, unit_price: price, discount });
    });
    if (hasError || !items.length) { showToast('Please add at least one valid item', 'error'); return; }
    const data = {
        customer_id: document.getElementById('sale-customer').value || null,
        warehouse_id: warehouseId, items,
        payment_method: document.getElementById('sale-payment-method').value,
        payment_status: document.getElementById('sale-payment-status')?.value || 'completed',
        discount: parseFloat(document.getElementById('sale-discount').value) || 0,
        discount_type: document.getElementById('sale-discount-type')?.value || 'amount',
        notes: document.getElementById('sale-notes').value.trim()
    };
    try {
        const res = await fetchWithAuth(`${API_BASE}/sales`, { method: 'POST', body: JSON.stringify(data) });
        const result = await res.json();
        if (!res.ok) throw new Error(result.error);
        showToast('Sale completed!', 'success');
        closeModal('sale-modal');
        loadSales(); loadDashboard(); loadStock();
        viewReceipt(result.id);
    } catch (err) { showToast(err.message, 'error'); }
}

async function viewReceipt(saleId) {
    try {
        const res = await fetchWithAuth(`${API_BASE}/sales/${saleId}/receipt`);
        const receipt = await res.json();
        displayReceipt(receipt);
        showModal('receipt-modal');
    } catch (err) { showToast(err.message, 'error'); }
}

function displayReceipt(receipt) {
    document.getElementById('receipt-content').innerHTML = `
        <div class="receipt">
            <div class="receipt-header">
                <h2>${escapeHtml(receipt.company?.name || 'VEEMENZ')}</h2>
                ${receipt.company?.address ? `<p>${escapeHtml(receipt.company.address)}</p>` : ''}
                ${receipt.company?.phone ? `<p>${escapeHtml(receipt.company.phone)}</p>` : ''}
                ${receipt.company?.email ? `<p>${escapeHtml(receipt.company.email)}</p>` : ''}
                <div class="receipt-meta">
                    <span>Receipt #${escapeHtml(receipt.receipt_number)}</span>
                    <span>${escapeHtml(receipt.date)} ${escapeHtml(receipt.time)}</span>
                </div>
                ${receipt.warehouse?.name ? `<p>Warehouse: <strong>${escapeHtml(receipt.warehouse.name)}</strong></p>` : ''}
            </div>
            ${receipt.customer?.name !== 'Walk-in Customer' ? `
            <div class="receipt-customer">
                <strong>Customer:</strong> ${escapeHtml(receipt.customer?.name || '')}
                ${receipt.customer?.phone ? ` | ${escapeHtml(receipt.customer.phone)}` : ''}
            </div>` : ''}
            <table class="receipt-items">
                <thead><tr><th>Item</th><th>Type</th><th>Qty</th><th>Price</th><th>Total</th></tr></thead>
                <tbody>
                    ${(receipt.items || []).map(item => `
                    <tr>
                        <td>${escapeHtml(item.product_name)}</td>
                        <td>${escapeHtml(formatSaleUnitType(item.unit_type))}</td>
                        <td>${item.quantity}</td>
                        <td>${formatCurrency(item.unit_price)}</td>
                        <td>${formatCurrency(item.line_total)}</td>
                    </tr>`).join('')}
                </tbody>
            </table>
            <div class="receipt-totals">
                <div class="receipt-row"><span>Subtotal:</span><span>${formatCurrency(receipt.subtotal)}</span></div>
                <div class="receipt-row"><span>Tax:</span><span>${formatCurrency(receipt.tax)}</span></div>
                ${receipt.discount > 0 ? `<div class="receipt-row"><span>Discount:</span><span>-${formatCurrency(receipt.discount)}</span></div>` : ''}
                <div class="receipt-row total"><span>TOTAL:</span><span>${formatCurrency(receipt.total)}</span></div>
                <div class="receipt-row"><span>Payment:</span><span>${escapeHtml(receipt.payment_method)}</span></div>
            </div>
            ${receipt.notes ? `<p class="receipt-notes">Notes: ${escapeHtml(receipt.notes)}</p>` : ''}
        </div>`;
}

function printReceipt() {
    const content = document.getElementById('receipt-content').innerHTML;
    const win = window.open('', '_blank');
    win.document.write(`<html><head><title>Receipt</title><link rel="stylesheet" href="styles.css"></head><body>${content}</body></html>`);
    win.document.close();
    win.focus();
    setTimeout(() => { win.print(); win.close(); }, 500);
}

function editSaleStatus(id, currentStatus) {
    document.getElementById('status-sale-id').value = id;
    document.getElementById('status-select').value = currentStatus;
    showModal('status-modal');
}

async function handleStatusSubmit(e) {
    e.preventDefault();
    const id = document.getElementById('status-sale-id').value;
    const newStatus = document.getElementById('status-select').value;
    try {
        const res = await fetchWithAuth(`${API_BASE}/sales/${id}/payment-status`, { method: 'PUT', body: JSON.stringify({ payment_status: newStatus }) });
        const result = await res.json();
        if (!res.ok) throw new Error(result.error);
        showToast('Status updated', 'success');
        closeModal('status-modal');
        loadSales(); loadDashboard();
    } catch (err) { showToast(err.message, 'error'); }
}

function markSalePaid(id) {
    showConfirm('Mark this sale as paid?', async () => {
        try {
            const res = await fetchWithAuth(`${API_BASE}/sales/${id}/payment-status`, { method: 'PUT', body: JSON.stringify({ payment_status: 'completed' }) });
            const result = await res.json();
            if (!res.ok) throw new Error(result.error);
            showToast('Sale marked as paid', 'success');
            loadSales(); loadDashboard();
        } catch (err) { showToast(err.message, 'error'); }
    });
}

function confirmDeleteSale(id) {
    showConfirm('Delete this sale? Stock will be restored.', async () => {
        try {
            const res = await fetchWithAuth(`${API_BASE}/sales/${id}`, { method: 'DELETE' });
            const result = await res.json();
            if (!res.ok) throw new Error(result.error);
            showToast('Sale deleted and stock restored', 'success');
            loadSales(); loadDashboard(); loadStock();
        } catch (err) { showToast(err.message, 'error'); }
    });
}

// ===================================================
// REPORTS
// ===================================================

async function loadReports() {
    try {
        const warehouseId = document.getElementById('warehouse-filter')?.value || '';
        const whParam = warehouseId ? `?warehouse_id=${warehouseId}` : '';

        const [byProductRes, byCustomerRes, dailyRes] = await Promise.all([
            fetchWithAuth(`${API_BASE}/reports/sales/by-product${whParam}`),
            fetchWithAuth(`${API_BASE}/reports/sales/by-customer${whParam}`),
            fetchWithAuth(`${API_BASE}/reports/sales/daily${whParam}`)
        ]);

        const topProducts = await byProductRes.json();
        const topCustomers = await byCustomerRes.json();
        const dailySales = await dailyRes.json();

        // Category report — group by product since no categories
        document.querySelector('#category-report-table tbody').innerHTML =
            topProducts.length ? topProducts.slice(0, 10).map(p => `
                <tr>
                    <td>${escapeHtml(p.name)}</td>
                    <td>1</td>
                    <td>${formatCurrency(p.total_revenue)}</td>
                    <td>${p.total_quantity_sold}</td>
                </tr>`).join('')
            : '<tr><td colspan="4" class="empty-state">No data</td></tr>';

        document.querySelector('#top-products-table tbody').innerHTML =
            topProducts.length ? topProducts.map(p => `
                <tr>
                    <td>${escapeHtml(p.name)}</td>
                    <td>—</td>
                    <td>${p.total_quantity_sold}</td>
                    <td>${formatCurrency(p.total_revenue)}</td>
                    <td>${p.sales_count}</td>
                </tr>`).join('')
            : '<tr><td colspan="5" class="empty-state">No sales data</td></tr>';

        document.querySelector('#top-customers-table tbody').innerHTML =
            topCustomers.length ? topCustomers.map(c => `
                <tr>
                    <td>${escapeHtml(c.name)}</td>
                    <td>${c.total_purchases}</td>
                    <td>${formatCurrency(c.total_spent)}</td>
                    <td>${formatCurrency(c.avg_purchase)}</td>
                    <td>${c.last_purchase ? new Date(c.last_purchase).toLocaleDateString() : '—'}</td>
                </tr>`).join('')
            : '<tr><td colspan="5" class="empty-state">No customer data</td></tr>';

        // Simple bar chart
        const chartContainer = document.getElementById('daily-sales-chart');
        if (dailySales.length) {
            const maxRevenue = Math.max(...dailySales.map(d => d.daily_revenue));
            chartContainer.innerHTML = `<div class="simple-chart">${
                dailySales.slice(0, 30).reverse().map(d => {
                    const pct = maxRevenue > 0 ? (d.daily_revenue / maxRevenue * 100) : 0;
                    return `<div class="chart-bar-wrap" title="${d.sale_day}: ${formatCurrency(d.daily_revenue)}">
                        <div class="chart-bar" style="height:${Math.max(pct, 2)}%"></div>
                        <div class="chart-label">${d.sale_day?.slice(5)}</div>
                    </div>`;
                }).join('')
            }</div>`;
        } else {
            chartContainer.innerHTML = '<div class="empty-state"><h4>No Sales Data</h4><p>Sales chart will appear here</p></div>';
        }
    } catch (err) {
        console.error('Reports error:', err);
        showToast('Failed to load reports', 'error');
    }
}

// ===================================================
// ALERTS
// ===================================================

async function loadAlerts() {
    try {
        const unreadOnly = document.getElementById('show-unread-only')?.checked;
        const warehouseId = document.getElementById('warehouse-filter')?.value || '';
        const params = new URLSearchParams();
        if (unreadOnly) params.append('unread_only', 'true');
        if (warehouseId) params.append('warehouse_id', warehouseId);

        const res = await fetchWithAuth(`${API_BASE}/alerts?${params}`);
        const alerts = await res.json();
        const tbody = document.querySelector('#alerts-table tbody');

        if (!alerts.length) {
            tbody.innerHTML = '<tr><td colspan="6" class="empty-state"><h4>No Alerts</h4><p>All clear!</p></td></tr>';
            return;
        }

        tbody.innerHTML = alerts.map(a => `
            <tr class="${a.is_read ? '' : 'unread'}">
                <td>${escapeHtml(a.type?.replace('_', ' '))}</td>
                <td>${escapeHtml(a.product_name || '—')}</td>
                <td>${escapeHtml(a.message)}</td>
                <td><span class="status-badge status-${a.severity === 'danger' ? 'cancelled' : a.severity === 'warning' ? 'pending' : 'ordered'}">${a.severity}</span></td>
                <td>${new Date(a.created_at).toLocaleString()}</td>
                <td>
                    ${!a.is_read ? `<button class="action-btn edit" data-action="mark-alert-read" data-id="${a.id}">✓ Read</button>` : ''}
                    <button class="action-btn delete" data-action="delete-alert" data-id="${a.id}">🗑️</button>
                </td>
            </tr>`).join('');
    } catch (err) {
        console.error('Alerts error:', err);
        showToast('Failed to load alerts', 'error');
    }
}

async function markAlertRead(id) {
    try {
        await fetchWithAuth(`${API_BASE}/alerts/${id}/read`, { method: 'PUT' });
        loadAlerts(); loadDashboard();
    } catch (err) { showToast(err.message, 'error'); }
}

async function markAllAlertsRead() {
    try {
        const warehouseId = document.getElementById('warehouse-filter')?.value || '';
        await fetchWithAuth(`${API_BASE}/alerts/read-all`, { method: 'PUT', body: JSON.stringify({ warehouse_id: warehouseId || undefined }) });
        showToast('All alerts marked as read', 'success');
        loadAlerts(); loadDashboard();
    } catch (err) { showToast(err.message, 'error'); }
}

function confirmDeleteAlert(id) {
    showConfirm('Delete this alert?', async () => {
        try {
            await fetchWithAuth(`${API_BASE}/alerts/${id}`, { method: 'DELETE' });
            showToast('Alert deleted', 'success');
            loadAlerts();
        } catch (err) { showToast(err.message, 'error'); }
    });
}

// ===================================================
// SETTINGS
// ===================================================

async function loadSettings() {
    try {
        const res = await fetchWithAuth(`${API_BASE}/settings`);
        const settings = await res.json();
        settings.forEach(s => {
            const el = document.getElementById(`setting-${s.key}`);
            if (!el) return;
            // tax_rate is stored as a fraction (0.10 = 10%) but shown as a percentage.
            if (s.key === 'tax_rate') {
                el.value = String((Number.isFinite(parseFloat(s.value)) ? parseFloat(s.value) : 0) * 100);
            } else {
                el.value = s.value;
            }
        });
        const tr = settings.find(s => s.key === 'tax_rate');
        if (tr) taxRate = Number.isFinite(parseFloat(tr.value)) ? parseFloat(tr.value) : 0;
        const te = settings.find(s => s.key === 'tax_enabled');
        if (te) taxEnabled = te.value !== 'false';
        const sv = settings.find(s => s.key === 'show_total_value');
        if (sv) showTotalValue = sv.value !== 'false';
        const cur = settings.find(s => s.key === 'currency');
        if (cur) currencySymbol = CURRENCY_SYMBOLS[cur.value] || (cur.value ? cur.value + ' ' : '₵');
        const th = settings.find(s => s.key === 'low_stock_threshold_default');
        if (th) defaultThreshold = Number.isSafeInteger(parseInt(th.value, 10)) && parseInt(th.value, 10) >= 0 ? parseInt(th.value, 10) : 10;
        applyTotalValueVisibility();
    } catch (err) { console.error('Settings error:', err); }
}

async function handleCompanySettings(e) {
    e.preventDefault();
    const fields = ['company_name', 'company_phone', 'company_email', 'company_address'];
    try {
        for (const key of fields) {
            const el = document.getElementById(`setting-${key}`);
            if (el) await fetchWithAuth(`${API_BASE}/settings/${key}`, { method: 'PUT', body: JSON.stringify({ value: el.value }) });
        }
        showToast('Company settings saved', 'success');
    } catch (err) { showToast(err.message, 'error'); }
}

async function handleSystemSettings(e) {
    e.preventDefault();
    const fields = ['tax_rate', 'tax_enabled', 'show_total_value', 'currency', 'low_stock_threshold_default', 'notifications_enabled', 'notifications_webhook_url'];
    try {
        for (const key of fields) {
            const el = document.getElementById(`setting-${key}`);
            if (!el) continue;
            let value = el.value;
            // tax_rate is shown as a percentage but stored as a fraction.
            if (key === 'tax_rate') {
                const pct = parseFloat(el.value);
                value = String(Number.isFinite(pct) ? pct / 100 : 0);
            }
            await fetchWithAuth(`${API_BASE}/settings/${key}`, { method: 'PUT', body: JSON.stringify({ value }) });
        }
        const taxRatePct = parseFloat(document.getElementById('setting-tax_rate')?.value);
        taxRate = (Number.isFinite(taxRatePct) ? taxRatePct : 0) / 100;
        taxEnabled = document.getElementById('setting-tax_enabled')?.value !== 'false';
        showTotalValue = document.getElementById('setting-show_total_value')?.value !== 'false';
        applyTotalValueVisibility();
        showToast('System settings saved', 'success');
    } catch (err) { showToast(err.message, 'error'); }
}

// ===================================================
// USER MANAGEMENT
// ===================================================

async function loadUsers() {
    try {
        const res = await fetchWithAuth(`${API_BASE}/auth/users`);
        const users = await res.json();
        const tbody = document.querySelector('#users-table tbody');
        if (!tbody) return;
        tbody.innerHTML = users.map(u => `
            <tr>
                <td>${escapeHtml(u.username)}</td>
                <td>${escapeHtml(u.email)}</td>
                <td><span class="status-badge ${u.role === 'admin' ? 'status-completed' : 'status-ordered'}">${u.role}</span></td>
                <td>${new Date(u.created_at).toLocaleDateString()}</td>
                <td>
                    ${u.id !== currentUser?.id ? `
                        <button class="action-btn edit" data-action="edit-user" data-id="${u.id}">✏️ Edit</button>
                        <button class="action-btn view" data-action="revoke-sessions" data-id="${u.id}" data-name="${escapeAttr(u.username)}">🔒 Sign Out</button>
                        <button class="action-btn delete" data-action="delete-user" data-id="${u.id}" data-name="${escapeAttr(u.username)}">🗑️ Delete</button>
                    ` : '<span style="color:var(--text-muted)">You</span>'}
                </td>
            </tr>`).join('');
    } catch (err) { console.error('Users error:', err); }
}

function openUserModal() {
    document.getElementById('user-form').reset();
    document.getElementById('user-id').value = '';
    document.getElementById('user-modal-title').textContent = 'Add User';
    document.getElementById('user-password').required = true;
    setPermissionCheckboxes([]);
    showModal('user-modal');
}

function setPermissionCheckboxes(perms) {
    document.querySelectorAll('#user-form input[data-perm]').forEach(cb => {
        cb.checked = (perms || []).includes(cb.dataset.perm);
    });
}

function collectPermissions() {
    const perms = [];
    document.querySelectorAll('#user-form input[data-perm]:checked').forEach(cb => perms.push(cb.dataset.perm));
    return perms;
}

async function editUser(id) {
    try {
        const res = await fetchWithAuth(`${API_BASE}/auth/users/${id}`);
        const u = await res.json();
        document.getElementById('user-form').reset();
        document.getElementById('user-id').value = u.id;
        document.getElementById('user-modal-title').textContent = 'Edit User';
        document.getElementById('user-username').value = u.username;
        document.getElementById('user-email').value = u.email;
        document.getElementById('user-role').value = u.role;
        document.getElementById('user-password').required = false;
        document.getElementById('user-password').placeholder = 'Leave blank to keep current';
        setPermissionCheckboxes(u.permissions || []);
        showModal('user-modal');
    } catch (err) { showToast(err.message, 'error'); }
}

async function handleUserSubmit(e) {
    e.preventDefault();
    const id = document.getElementById('user-id').value;
    const password = document.getElementById('user-password').value;
    const data = {
        username: document.getElementById('user-username').value.trim(),
        email: document.getElementById('user-email').value.trim(),
        role: document.getElementById('user-role').value,
        permissions: collectPermissions()
    };
    if (!id) {
        if (!password) { showToast('Password is required', 'error'); return; }
        data.password = password;
    } else if (password) {
        data.password = password;
    }
    try {
        const url = id ? `${API_BASE}/auth/users/${id}` : `${API_BASE}/auth/register`;
        const method = id ? 'PUT' : 'POST';
        const res = await fetchWithAuth(url, { method, body: JSON.stringify(data) });
        const result = await res.json();
        if (!res.ok) throw new Error(result.error);
        showToast(id ? 'User updated' : 'User created', 'success');
        closeModal('user-modal');
        loadUsers();
    } catch (err) { showToast(err.message, 'error'); }
}

function confirmRevokeSessions(id, username) {
    showConfirm(`Sign out "${username}" from all sessions?`, async () => {
        try {
            const res = await fetchWithAuth(`${API_BASE}/auth/users/${id}/revoke-sessions`, { method: 'POST' });
            const result = await res.json();
            if (!res.ok) throw new Error(result.error);
            showToast('Sessions revoked', 'success');
        } catch (err) { showToast(err.message, 'error'); }
    });
}

function confirmDeleteUser(id, username) {
    showConfirm(`Delete user "${username}"?`, async () => {
        try {
            const res = await fetchWithAuth(`${API_BASE}/auth/users/${id}`, { method: 'DELETE' });
            const result = await res.json();
            if (!res.ok) throw new Error(result.error);
            showToast('User deleted', 'success');
            loadUsers();
        } catch (err) { showToast(err.message, 'error'); }
    });
}

// ===================================================
// WAREHOUSE MANAGEMENT
// ===================================================

async function loadWarehouseManagement() {
    try {
        const res = await fetchWithAuth(`${API_BASE}/warehouses`);
        const warehouses = await res.json();
        const isAdmin = currentUser?.role === 'admin';
        const addBtn = document.getElementById('add-warehouse-btn');
        if (addBtn) addBtn.style.display = isAdmin ? '' : 'none';
        const tbody = document.querySelector('#warehouses-table tbody');
        if (!tbody) return;
        tbody.innerHTML = warehouses.map(w => `
            <tr>
                <td>${escapeHtml(w.name)}</td>
                <td>${escapeHtml(w.code)}</td>
                <td>${escapeHtml(w.city || '—')}</td>
                <td><span class="status-badge ${w.is_active ? 'status-completed' : 'status-ordered'}">${w.is_active ? 'Active' : 'Inactive'}</span></td>
                <td>${isAdmin ? `
                    <button class="action-btn edit" data-action="edit-warehouse" data-id="${w.id}" data-name="${escapeAttr(w.name)}" data-code="${escapeAttr(w.code)}" data-city="${escapeAttr(w.city || '')}" data-address="${escapeAttr(w.address || '')}" data-country="${escapeAttr(w.country || '')}">✏️ Rename</button>
                    ${w.is_active ? `<button class="action-btn delete" data-action="deactivate-warehouse" data-id="${w.id}" data-name="${escapeAttr(w.name)}">🗑️ Deactivate</button>` : ''}
                ` : ''}</td>
            </tr>`).join('');
    } catch (err) { console.error('Warehouses error:', err); }
}

function openAddWarehouseModal() {
    document.getElementById('warehouse-form').reset();
    document.getElementById('warehouse-id').value = '';
    document.getElementById('warehouse-country').value = 'Ghana';
    document.getElementById('warehouse-modal-title').textContent = 'Add Warehouse';
    showModal('warehouse-modal');
}

function openEditWarehouseModal(id, name, code, city, address, country) {
    document.getElementById('warehouse-id').value = id;
    document.getElementById('warehouse-name').value = name;
    document.getElementById('warehouse-code').value = code;
    document.getElementById('warehouse-city').value = city || '';
    document.getElementById('warehouse-address').value = address || '';
    document.getElementById('warehouse-country').value = country || 'Ghana';
    document.getElementById('warehouse-modal-title').textContent = 'Rename Warehouse';
    showModal('warehouse-modal');
}

async function handleWarehouseSubmit(e) {
    e.preventDefault();
    const id = document.getElementById('warehouse-id').value;
    const data = {
        name: document.getElementById('warehouse-name').value.trim(),
        code: document.getElementById('warehouse-code').value.trim(),
        city: document.getElementById('warehouse-city').value.trim(),
        address: document.getElementById('warehouse-address').value.trim(),
        country: document.getElementById('warehouse-country').value.trim()
    };
    try {
        const url = id ? `${API_BASE}/warehouses/${id}` : `${API_BASE}/warehouses`;
        const method = id ? 'PUT' : 'POST';
        const res = await fetchWithAuth(url, { method, body: JSON.stringify(data) });
        const result = await res.json();
        if (!res.ok) throw new Error(result.error);
        showToast(id ? 'Warehouse updated' : 'Warehouse added', 'success');
        closeModal('warehouse-modal');
        await loadWarehouses();
        await loadWarehouseManagement();
    } catch (err) { showToast(err.message, 'error'); }
}

function confirmDeactivateWarehouse(id, name) {
    showConfirm(`Deactivate warehouse "${name}"? Its history will be kept.`, async () => {
        try {
            const res = await fetchWithAuth(`${API_BASE}/warehouses/${id}`, { method: 'DELETE' });
            const result = await res.json();
            if (!res.ok) throw new Error(result.error);
            showToast('Warehouse deactivated', 'success');
            await loadWarehouses();
            await loadWarehouseManagement();
        } catch (err) { showToast(err.message, 'error'); }
    });
}

async function handleSystemReset(e) {
    e.preventDefault();
    const password = document.getElementById('reset-password').value;
    if (!password) { showToast('Password is required', 'error'); return; }
    try {
        const res = await fetchWithAuth(`${API_BASE}/system/reset`, { method: 'POST', body: JSON.stringify({ password }) });
        const result = await res.json();
        if (!res.ok) throw new Error(result.error);
        closeModal('reset-password-modal');
        document.getElementById('reset-password').value = '';
        showToast('System reset successfully', 'success');
        await loadWarehouses();
        await loadSettings();
        switchSection('dashboard');
    } catch (err) { showToast(err.message, 'error'); }
}

async function handlePasswordChange(e) {
    e.preventDefault();
    const newPass = document.getElementById('new-password').value;
    const confirmPass = document.getElementById('confirm-password').value;
    if (newPass !== confirmPass) { showToast('Passwords do not match', 'error'); return; }
    const data = {
        current_password: document.getElementById('current-password').value,
        new_password: newPass
    };
    try {
        const res = await fetchWithAuth(`${API_BASE}/auth/change-password`, { method: 'PUT', body: JSON.stringify(data) });
        const result = await res.json();
        if (!res.ok) throw new Error(result.error);
        forcePasswordChange = false;
        closeModal('password-modal');
        document.getElementById('password-form').reset();
        showToast('Password changed. Please log in again.', 'success');
        logout();
    } catch (err) { showToast(err.message, 'error'); }
}

// ===================================================
// GLOBAL SEARCH
// ===================================================

function handleGlobalSearch() {
    const query = document.getElementById('global-search')?.value.trim();
    if (!query) return;
    // Navigate to products and search there
    switchSection('products');
    const productSearch = document.getElementById('product-search');
    if (productSearch) { productSearch.value = query; loadProducts(); }
}

// ===================================================
// TRANSFERS
// ===================================================

async function loadTransfers() {
    try {
        const res = await fetchWithAuth(`${API_BASE}/transfers`);
        const transfers = await res.json();
        const tbody = document.querySelector('#transfers-table tbody');
        if (!transfers.length) { tbody.innerHTML = '<tr><td colspan="7" class="empty-state"><h4>No transfers yet</h4></td></tr>'; return; }
        tbody.innerHTML = transfers.map(t => `
            <tr>
                <td>${new Date(t.created_at).toLocaleString()}</td>
                <td>${escapeHtml(t.product_name)}</td>
                <td>${escapeHtml(t.from_warehouse_name)}</td>
                <td>${escapeHtml(t.to_warehouse_name)}</td>
                <td>${escapeHtml(formatSaleUnitType(t.unit_type))}</td>
                <td>${t.quantity}</td>
                <td>${escapeHtml(t.created_by_name || '—')}</td>
            </tr>`).join('');
    } catch (err) { console.error(err); showToast('Failed to load transfers', 'error'); }
}

async function openTransferModal() {
    document.getElementById('transfer-form').reset();
    await loadWarehouses();
    const products = await (await fetchWithAuth(`${API_BASE}/products`)).json();
    document.getElementById('transfer-product').innerHTML = '<option value="">Select Product</option>' + products.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
    showModal('transfer-modal');
}

async function handleTransferSubmit(e) {
    e.preventDefault();
    const data = {
        product_id: document.getElementById('transfer-product').value,
        from_warehouse_id: document.getElementById('transfer-from').value,
        to_warehouse_id: document.getElementById('transfer-to').value,
        unit_type: document.getElementById('transfer-unit-type').value,
        quantity: parseInt(document.getElementById('transfer-quantity').value),
        notes: document.getElementById('transfer-notes').value.trim()
    };
    try {
        const res = await fetchWithAuth(`${API_BASE}/transfers`, { method: 'POST', body: JSON.stringify(data) });
        const result = await res.json();
        if (!res.ok) throw new Error(result.error);
        showToast('Stock transferred', 'success');
        closeModal('transfer-modal');
        loadTransfers(); loadStock(); loadDashboard();
    } catch (err) { showToast(err.message, 'error'); }
}

// ===================================================
// RETURNS
// ===================================================

async function loadReturns() {
    try {
        const res = await fetchWithAuth(`${API_BASE}/returns`);
        const returns = await res.json();
        const tbody = document.querySelector('#returns-table tbody');
        if (!returns.length) { tbody.innerHTML = '<tr><td colspan="7" class="empty-state"><h4>No returns yet</h4></td></tr>'; return; }
        tbody.innerHTML = returns.map(r => `<tr>
            <td>${new Date(r.created_at).toLocaleString()}</td>
            <td>${escapeHtml(r.product_name)}</td>
            <td>${escapeHtml(formatSaleUnitType(r.unit_type))}</td>
            <td>${r.quantity}</td>
            <td>${formatCurrency(r.line_total)}</td>
            <td>${escapeHtml(r.reason || '—')}</td>
            <td>${escapeHtml(r.created_by_name || '—')}</td>
        </tr>`).join('');
    } catch (err) { console.error(err); showToast('Failed to load returns', 'error'); }
}

async function openReturnModal(saleId) {
    document.getElementById('return-form').reset();
    const sales = await (await fetchWithAuth(`${API_BASE}/sales?limit=100`)).json();
    document.getElementById('return-sale').innerHTML = '<option value="">Select Sale</option>' + sales.map(s => `<option value="${s.id}">#${s.id.slice(0,8)} — ${escapeHtml(s.customer_name || 'Walk-in')} — ${formatCurrency(s.total)}</option>`).join('');
    if (saleId) document.getElementById('return-sale').value = saleId;
    document.getElementById('return-sale').addEventListener('change', async function () {
        const id = this.value;
        const container = document.getElementById('return-items-container');
        if (!id) { container.innerHTML = ''; return; }
        const sale = await (await fetchWithAuth(`${API_BASE}/sales/${id}`)).json();
        container.innerHTML = (sale.items || []).map((item, i) => `
            <div class="form-row" style="margin-bottom:8px;align-items:center;">
                <div class="form-group" style="margin:0;"><label>${escapeHtml(item.product_name)} (${escapeHtml(formatSaleUnitType(item.unit_type))}, sold ${item.quantity})</label></div>
                <div class="form-group" style="margin:0;"><input type="number" class="return-qty" min="0" max="${item.quantity}" value="0" data-product="${item.product_id}" data-unit="${item.unit_type}"></div>
            </div>`).join('') || '<p>No items in this sale</p>';
    });
    showModal('return-modal');
}

async function handleReturnSubmit(e) {
    e.preventDefault();
    const saleId = document.getElementById('return-sale').value;
    const items = [];
    document.querySelectorAll('.return-qty').forEach(input => {
        const qty = parseInt(input.value);
        if (qty > 0) items.push({ product_id: input.dataset.product, unit_type: input.dataset.unit, quantity: qty });
    });
    if (!saleId || !items.length) { showToast('Select a sale and at least one item to return', 'error'); return; }
    try {
        const res = await fetchWithAuth(`${API_BASE}/returns`, { method: 'POST', body: JSON.stringify({ sale_id: saleId, items, reason: document.getElementById('return-reason').value.trim() }) });
        const result = await res.json();
        if (!res.ok) throw new Error(result.error);
        showToast('Return processed', 'success');
        closeModal('return-modal');
        loadReturns(); loadStock(); loadDashboard();
    } catch (err) { showToast(err.message, 'error'); }
}

// ===================================================
// AUDIT LOG
// ===================================================

function formatAuditAction(action) {
    const labels = {
        'auth.login': 'User login',
        'auth.login_failed': 'Failed login',
        'product.create': 'Create product',
        'product.update': 'Update product',
        'product.archive': 'Archive product',
        'product.delete': 'Delete product',
        'sale.create': 'Create sale',
        'sale.status': 'Update sale status',
        'sale.cancel': 'Cancel sale',
        'sale.return': 'Process return',
        'stock.adjust': 'Adjust stock',
        'stock.transfer': 'Transfer stock',
        'customer.create': 'Create customer',
        'customer.update': 'Update customer',
        'customer.delete': 'Delete customer',
        'user.create': 'Create user',
        'user.update': 'Update user',
        'user.disable': 'Disable user',
        'user.revoke_sessions': 'Revoke user sessions',
        'warehouse.create': 'Create warehouse',
        'warehouse.update': 'Update warehouse',
        'warehouse.deactivate': 'Deactivate warehouse'
    };
    return labels[action] || action;
}

async function loadAudit() {
    try {
        const search = document.getElementById('audit-search')?.value || '';
        const res = await fetchWithAuth(`${API_BASE}/audit?search=${encodeURIComponent(search)}`);
        const logs = await res.json();
        const tbody = document.querySelector('#audit-table tbody');
        if (!logs.length) { tbody.innerHTML = '<tr><td colspan="5" class="empty-state">No activity recorded</td></tr>'; return; }
        tbody.innerHTML = logs.map(l => `<tr>
            <td>${new Date(l.created_at).toLocaleString()}</td>
            <td>${escapeHtml(l.user_name || '—')}</td>
            <td>${escapeHtml(formatAuditAction(l.action))}</td>
            <td>${escapeHtml(l.entity_type || '')} ${escapeHtml(l.entity_id ? l.entity_id.slice(0,8) : '')}</td>
            <td>${escapeHtml(l.details || '')}</td>
        </tr>`).join('');
    } catch (err) { console.error(err); showToast('Failed to load audit log', 'error'); }
}

async function exportSales() {
    try {
        const dateFrom = document.getElementById('sale-date-from')?.value || '';
        const dateTo = document.getElementById('sale-date-to')?.value || '';
        const warehouseId = document.getElementById('warehouse-filter')?.value || '';
        const params = new URLSearchParams();
        if (dateFrom) params.append('start_date', dateFrom);
        if (dateTo) params.append('end_date', dateTo);
        if (warehouseId) params.append('warehouse_id', warehouseId);
        const res = await fetch(`${API_BASE}/sales/export?${params}`, { headers: { 'Authorization': `Bearer ${authToken}` } });
        if (!res.ok) { const e = await res.json(); throw new Error(e.error || 'Export failed'); }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `VEEMENZ-Sales-${new Date().toISOString().split('T')[0]}.xlsx`;
        document.body.appendChild(a); a.click(); URL.revokeObjectURL(url); document.body.removeChild(a);
        showToast('Sales exported', 'success');
    } catch (err) { showToast(err.message, 'error'); }
}

// ===================================================
// REAL-TIME UPDATES (WebSockets)
// ===================================================

let realtimeSocket = null;

function initRealtime() {
    if (typeof io === 'undefined') return;
    if (realtimeSocket) { realtimeSocket.disconnect(); realtimeSocket = null; }
    if (!authToken) return;
    realtimeSocket = io({ auth: { token: authToken } });
    realtimeSocket.on('data-changed', () => {
        const active = document.querySelector('.nav-item.active')?.dataset.section || 'dashboard';
        loadDashboard();
        switch (active) {
            case 'dashboard': break;
            case 'stock': loadStock(); break;
            case 'products': loadProducts(); break;
            case 'customers': loadCustomers(); break;
            case 'sales': loadSales(); break;
            case 'transfers': loadTransfers(); break;
            case 'returns': loadReturns(); break;
            case 'audit': loadAudit(); break;
            case 'reports': loadReports(); break;
            case 'alerts': loadAlerts(); break;
        }
    });
}

function disconnectRealtime() {
    if (realtimeSocket) { realtimeSocket.disconnect(); realtimeSocket = null; }
}

// ===================================================
// START THE APP
// ===================================================

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}