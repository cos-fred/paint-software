// ===================================================
// VEEMENZ Inventory & Sales Tracker — Frontend App
// ===================================================

const API_BASE = '/api';
let authToken = localStorage.getItem('authToken');
let currentUser = JSON.parse(localStorage.getItem('currentUser') || 'null');
let warehousesCache = [];
let taxRate = 0.10;
let confirmCallback = null;

// ===================================================
// CORE UTILITIES
// ===================================================

function formatCurrency(amount) {
    const num = parseFloat(amount) || 0;
    return '₵' + num.toLocaleString('en-GH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function escapeHtml(text) {
    if (text === null || text === undefined) return '';
    const d = document.createElement('div');
    d.textContent = String(text);
    return d.innerHTML;
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
    if (res.status === 401 || res.status === 403) {
        logout();
        throw new Error('Session expired. Please log in again.');
    }
    return res;
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
        }
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
    showLoginScreen();
}

async function init() {
    if (authToken) {
        const user = await loadUser();
        if (user) {
            showMainScreen();
            await loadWarehouses();
            await loadSettings();
            switchSection('dashboard');
        } else {
            logout();
        }
    } else {
        showLoginScreen();
    }
    setupEventListeners();
}

// ===================================================
// EVENT LISTENERS
// ===================================================

function setupEventListeners() {
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
                await loadUser();
                await loadWarehouses();
                await loadSettings();
                switchSection('dashboard');
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
        btn.addEventListener('click', () => closeModal());
    });
    document.querySelectorAll('.modal').forEach(modal => {
        modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(modal.id); });
    });

    // Confirm modal OK button
    document.getElementById('confirm-ok')?.addEventListener('click', handleConfirmAction);

    // Product form
    document.getElementById('add-product-btn')?.addEventListener('click', () => openProductModal());
    document.getElementById('product-form')?.addEventListener('submit', handleProductSubmit);
    document.getElementById('product-unit-price')?.addEventListener('input', updateCartonPrice);

    // Customer form
    document.getElementById('add-customer-btn')?.addEventListener('click', () => openCustomerModal());
    document.getElementById('customer-form')?.addEventListener('submit', handleCustomerSubmit);

    // Sales
    document.getElementById('new-sale-btn')?.addEventListener('click', openSaleModal);
    document.getElementById('sale-form')?.addEventListener('submit', handleSaleSubmit);
    document.getElementById('add-sale-item')?.addEventListener('click', addSaleItemRow);
    document.getElementById('sale-discount')?.addEventListener('input', updateSaleSummary);
    document.getElementById('sale-search')?.addEventListener('input', debounce(loadSales, 400));
    document.getElementById('sale-status-filter')?.addEventListener('change', loadSales);
    document.getElementById('sale-date-from')?.addEventListener('change', loadSales);
    document.getElementById('sale-date-to')?.addEventListener('change', loadSales);

    // Purchase Orders
    document.getElementById('new-po-btn')?.addEventListener('click', openPOModal);
    document.getElementById('po-form')?.addEventListener('submit', handlePOSubmit);
    document.getElementById('add-po-item')?.addEventListener('click', addPOItemRow);
    document.getElementById('po-status-filter')?.addEventListener('change', loadPurchaseOrders);

    // Alerts
    document.getElementById('mark-all-read-btn')?.addEventListener('click', markAllAlertsRead);
    document.getElementById('show-unread-only')?.addEventListener('change', loadAlerts);

    // Settings
    document.getElementById('company-settings-form')?.addEventListener('submit', handleCompanySettings);
    document.getElementById('system-settings-form')?.addEventListener('submit', handleSystemSettings);

    // Users
    document.getElementById('add-user-btn')?.addEventListener('click', () => openUserModal());
    document.getElementById('user-form')?.addEventListener('submit', handleUserSubmit);

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
        case 'products': loadProducts(); break;
        case 'customers': loadCustomers(); break;
        case 'sales': loadSales(); break;
        case 'purchase-orders': loadPurchaseOrders(); break;
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
        const res = await fetchWithAuth(`${API_BASE}/products/warehouses`);
        warehousesCache = await res.json();
        const selectors = ['warehouse-filter', 'stock-warehouse-filter', 'sale-warehouse', 'po-warehouse', 'stock-adjust-warehouse'];
        selectors.forEach(id => {
            const select = document.getElementById(id);
            if (!select) return;
            const current = select.value;
            const allLabel = (id === 'sale-warehouse' || id === 'po-warehouse' || id === 'stock-adjust-warehouse') ? 'Select Warehouse' : 'All Warehouses';
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

        document.getElementById('dashboard-stats').innerHTML = `
            <div class="stat-card primary">
                <div class="stat-icon">📦</div>
                <div class="stat-info"><h4>Total Products</h4><div class="stat-value">${inventory.summary?.total_products ?? 0}</div></div>
            </div>
            <div class="stat-card success">
                <div class="stat-icon">💰</div>
                <div class="stat-info"><h4>Inventory Value</h4><div class="stat-value">${formatCurrency(inventory.summary?.total_inventory_value ?? 0)}</div></div>
            </div>
            <div class="stat-card warning">
                <div class="stat-icon">📊</div>
                <div class="stat-info"><h4>Total Stock Items</h4><div class="stat-value">${inventory.summary?.total_stock_items ?? 0}</div></div>
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
                    <strong>${escapeHtml(p.name)}</strong> — Units: ${p.unit_stock}, Cartons: ${p.carton_stock}, 20L: ${p.liter20_stock}
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
            tbody.innerHTML = '<tr><td colspan="12" class="empty-state"><h4>No Products</h4><p>Add products to see stock here</p></td></tr>';
            return;
        }

        tbody.innerHTML = products.map(p => {
            const unitStock = p.warehouse_unit_stock ?? p.total_unit_stock ?? 0;
            const cartonStock = p.warehouse_carton_stock ?? p.total_carton_stock ?? 0;
            const liter20Stock = p.warehouse_liter20_stock ?? p.total_liter20_stock ?? 0;
            const totalValue = (p.unit_price * unitStock) + (p.carton_price * cartonStock) + (p.liter20_price * liter20Stock);
            const isLow = unitStock <= p.low_stock_threshold || cartonStock <= p.low_stock_threshold || liter20Stock <= p.low_stock_threshold;
            const cls = (stock) => stock <= p.low_stock_threshold ? 'stock-low' : (stock === 0 ? 'stock-warning' : 'stock-ok');
            return `<tr${isLow ? ' class="low-stock-row"' : ''}>
                <td><strong>${escapeHtml(p.name)}</strong><br><small style="color:var(--text-muted)">${escapeHtml(p.description || '—')}</small></td>
                <td>${escapeHtml(p.warehouse_name || 'All')}</td>
                <td>${formatCurrency(p.unit_price)}</td>
                <td>${formatCurrency(p.carton_price)}</td>
                <td>${formatCurrency(p.liter20_price)}</td>
                <td class="${cls(unitStock)}">${unitStock}</td>
                <td class="${cls(cartonStock)}">${cartonStock}</td>
                <td class="${cls(liter20Stock)}">${liter20Stock}</td>
                <td>${p.low_stock_threshold}</td>
                <td><strong>${formatCurrency(totalValue)}</strong></td>
                <td><span class="status-badge ${isLow ? 'status-pending' : 'status-completed'}">${isLow ? 'Low Stock' : 'OK'}</span></td>
                <td><button class="action-btn edit" onclick="openStockAdjustModal('${p.id}','${escapeHtml(p.name)}')">⚙️ Adjust</button></td>
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
        const fieldMap = { unit: 'warehouse_unit_stock', carton: 'warehouse_carton_stock', liter20: 'warehouse_liter20_stock' };
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
            tbody.innerHTML = '<tr><td colspan="10" class="empty-state"><h4>No Products</h4><p>Click "Add Product" to get started</p></td></tr>';
            return;
        }

        tbody.innerHTML = products.map(p => {
            const unitStock = p.total_unit_stock ?? 0;
            const cartonStock = p.total_carton_stock ?? 0;
            const liter20Stock = p.total_liter20_stock ?? 0;
            const totalValue = (p.unit_price * unitStock) + (p.carton_price * cartonStock) + (p.liter20_price * liter20Stock);
            const isLow = unitStock <= p.low_stock_threshold || cartonStock <= p.low_stock_threshold || liter20Stock <= p.low_stock_threshold;
            return `<tr${isLow ? ' class="low-stock-row"' : ''}>
                <td><strong>${escapeHtml(p.name)}</strong>${p.description ? `<br><small style="color:var(--text-muted)">${escapeHtml(p.description)}</small>` : ''}</td>
                <td>${formatCurrency(p.unit_price)}</td>
                <td>${formatCurrency(p.carton_price)}</td>
                <td>${formatCurrency(p.liter20_price)}</td>
                <td class="${unitStock <= p.low_stock_threshold ? 'stock-low' : 'stock-ok'}">${unitStock}</td>
                <td class="${cartonStock <= p.low_stock_threshold ? 'stock-low' : 'stock-ok'}">${cartonStock}</td>
                <td class="${liter20Stock <= p.low_stock_threshold ? 'stock-low' : 'stock-ok'}">${liter20Stock}</td>
                <td>${p.low_stock_threshold}</td>
                <td><strong>${formatCurrency(totalValue)}</strong></td>
                <td>
                    <button class="action-btn edit" onclick="editProduct('${p.id}')">✏️ Edit</button>
                    <button class="action-btn delete" onclick="confirmDeleteProduct('${p.id}','${escapeHtml(p.name)}')">🗑️ Delete</button>
                </td>
            </tr>`;
        }).join('');
    } catch (err) {
        console.error('Products error:', err);
        showToast('Failed to load products', 'error');
    }
}

function openProductModal(productId = null) {
    const form = document.getElementById('product-form');
    form.reset();
    document.getElementById('product-id').value = '';
    document.getElementById('product-modal-title').textContent = 'Add Product';
    document.getElementById('product-threshold').value = 10;
    if (productId) {
        fetchWithAuth(`${API_BASE}/products/${productId}`)
            .then(r => r.json())
            .then(p => {
                document.getElementById('product-modal-title').textContent = 'Edit Product';
                document.getElementById('product-id').value = p.id;
                document.getElementById('product-name').value = p.name;
                document.getElementById('product-description').value = p.description || '';
                document.getElementById('product-unit-price').value = p.unit_price;
                document.getElementById('product-carton-price').value = p.carton_price;
                document.getElementById('product-liter20-price').value = p.liter20_price;
                document.getElementById('product-threshold').value = p.low_stock_threshold;
            }).catch(err => showToast(err.message, 'error'));
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
        description: document.getElementById('product-description').value.trim(),
        unit_price: parseFloat(document.getElementById('product-unit-price').value),
        carton_price: parseFloat(document.getElementById('product-carton-price').value) || null,
        liter20_price: parseFloat(document.getElementById('product-liter20-price').value) || 0,
        low_stock_threshold: parseInt(document.getElementById('product-threshold').value) || 10,
        unit_stock: parseInt(document.getElementById('product-unit-stock')?.value) || 0,
        carton_stock: parseInt(document.getElementById('product-carton-stock')?.value) || 0,
        liter20_stock: parseInt(document.getElementById('product-liter20-stock')?.value) || 0
    };
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
        const warehouseId = document.getElementById('sale-warehouse')?.value || document.getElementById('po-warehouse')?.value || '';
        const params = warehouseId ? `?warehouse_id=${warehouseId}` : '';
        const res = await fetchWithAuth(`${API_BASE}/products${params}`);
        const products = await res.json();
        const options = '<option value="">Select Product</option>' +
            products.map(p => `<option value="${p.id}" data-unit="${p.unit_price}" data-carton="${p.carton_price}" data-liter20="${p.liter20_price}">${escapeHtml(p.name)}</option>`).join('');
        document.querySelectorAll('.sale-item-product').forEach(s => s.innerHTML = options);
        document.querySelectorAll('.po-item-product').forEach(s => s.innerHTML = options);
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
                <td>—</td><td>—</td><td>—</td>
                <td>
                    <button class="action-btn edit" onclick="editCustomer('${c.id}')">✏️ Edit</button>
                    <button class="action-btn delete" onclick="confirmDeleteCustomer('${c.id}','${escapeHtml(c.name)}')">🗑️ Delete</button>
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
    showConfirm(`Delete customer "${name}"?`, async () => {
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
                    <button class="action-btn view" onclick="viewReceipt('${s.id}')">👁️ View</button>
                    <button class="action-btn edit" onclick="editSaleStatus('${s.id}','${s.payment_status}')">✏️ Status</button>
                    <button class="action-btn delete" onclick="confirmDeleteSale('${s.id}')">🗑️ Delete</button>
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
            <option value="unit">Unit</option>
            <option value="carton">Carton (12)</option>
            <option value="liter20">20L Container</option>
        </select>
        <input type="number" class="sale-item-qty" min="1" value="1" required>
        <span class="sale-item-price"></span>
        <span class="sale-item-total">${formatCurrency(0)}</span>
        <button type="button" class="btn btn-icon btn-danger remove-item" aria-label="Remove item">×</button>
    </div>`;
}

function attachSaleItemEvents(row) {
    row.querySelector('.sale-item-product').addEventListener('change', updateSaleItemPrice);
    row.querySelector('.sale-item-unit').addEventListener('change', updateSaleItemPrice);
    row.querySelector('.sale-item-qty').addEventListener('input', updateSaleSummary);
    row.querySelector('.remove-item').addEventListener('click', () => {
        if (document.querySelectorAll('.sale-item-row').length > 1) { row.remove(); updateSaleSummary(); }
    });
}

function addSaleItemRow() {
    const container = document.getElementById('sale-items-container');
    container.insertAdjacentHTML('beforeend', buildSaleItemRow());
    const newRow = container.lastElementChild;
    // Copy product options from first row
    const firstOptions = container.querySelector('.sale-item-product').innerHTML;
    newRow.querySelector('.sale-item-product').innerHTML = firstOptions;
    attachSaleItemEvents(newRow);
}

function updateSaleItemPrice() {
    const row = this.closest('.sale-item-row');
    const option = row.querySelector('.sale-item-product').selectedOptions[0];
    const unitType = row.querySelector('.sale-item-unit').value;
    const qty = parseInt(row.querySelector('.sale-item-qty').value) || 0;
    let price = 0;
    if (option && option.value) {
        if (unitType === 'unit') price = parseFloat(option.dataset.unit) || 0;
        else if (unitType === 'carton') price = parseFloat(option.dataset.carton) || 0;
        else if (unitType === 'liter20') price = parseFloat(option.dataset.liter20) || 0;
    }
    row.querySelector('.sale-item-price').textContent = formatCurrency(price) + ' each';
    row.querySelector('.sale-item-total').textContent = formatCurrency(price * qty);
    updateSaleSummary();
}

function updateSaleSummary() {
    let subtotal = 0;
    document.querySelectorAll('.sale-item-row').forEach(row => {
        const option = row.querySelector('.sale-item-product').selectedOptions[0];
        const unitType = row.querySelector('.sale-item-unit').value;
        const qty = parseInt(row.querySelector('.sale-item-qty').value) || 0;
        let price = 0;
        if (option && option.value) {
            if (unitType === 'unit') price = parseFloat(option.dataset.unit) || 0;
            else if (unitType === 'carton') price = parseFloat(option.dataset.carton) || 0;
            else if (unitType === 'liter20') price = parseFloat(option.dataset.liter20) || 0;
        }
        const lineTotal = price * qty;
        row.querySelector('.sale-item-total').textContent = formatCurrency(lineTotal);
        subtotal += lineTotal;
    });
    const tax = subtotal * taxRate;
    const discount = parseFloat(document.getElementById('sale-discount')?.value) || 0;
    const total = subtotal + tax - discount;
    document.getElementById('sale-subtotal').textContent = formatCurrency(subtotal);
    document.getElementById('sale-tax').textContent = formatCurrency(tax);
    document.getElementById('sale-discount-display').textContent = formatCurrency(discount);
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
        const option = row.querySelector('.sale-item-product').selectedOptions[0];
        let price = 0;
        if (unitType === 'unit') price = parseFloat(option.dataset.unit) || 0;
        else if (unitType === 'carton') price = parseFloat(option.dataset.carton) || 0;
        else if (unitType === 'liter20') price = parseFloat(option.dataset.liter20) || 0;
        items.push({ product_id: productId, unit_type: unitType, quantity: qty, unit_price: price });
    });
    if (hasError || !items.length) { showToast('Please add at least one valid item', 'error'); return; }
    const data = {
        customer_id: document.getElementById('sale-customer').value || null,
        warehouse_id: warehouseId, items,
        payment_method: document.getElementById('sale-payment-method').value,
        discount: parseFloat(document.getElementById('sale-discount').value) || 0,
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
                        <td>${escapeHtml(item.unit_type)}</td>
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
    const statuses = ['pending', 'completed', 'cancelled', 'refunded'];
    const newStatus = prompt(`Change status (current: ${currentStatus})\nOptions: ${statuses.join(', ')}`, currentStatus);
    if (!newStatus || !statuses.includes(newStatus.toLowerCase())) return;
    fetchWithAuth(`${API_BASE}/sales/${id}/payment-status`, {
        method: 'PUT', body: JSON.stringify({ payment_status: newStatus.toLowerCase() })
    }).then(r => r.json()).then(result => {
        if (result.error) throw new Error(result.error);
        showToast('Status updated', 'success');
        loadSales();
    }).catch(err => showToast(err.message, 'error'));
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
// PURCHASE ORDERS
// ===================================================

async function loadPurchaseOrders() {
    try {
        const status = document.getElementById('po-status-filter')?.value || '';
        const warehouseId = document.getElementById('warehouse-filter')?.value || '';
        const params = new URLSearchParams();
        if (status) params.append('status', status);
        if (warehouseId) params.append('warehouse_id', warehouseId);

        const res = await fetchWithAuth(`${API_BASE}/purchase-orders?${params}`);
        const orders = await res.json();
        const tbody = document.querySelector('#purchase-orders-table tbody');

        if (!orders.length) {
            tbody.innerHTML = '<tr><td colspan="7" class="empty-state"><h4>No Purchase Orders</h4><p>Click "New Purchase Order" to create one</p></td></tr>';
            return;
        }

        tbody.innerHTML = orders.map(o => `
            <tr>
                <td>${new Date(o.order_date).toLocaleDateString()}</td>
                <td>${escapeHtml(o.supplier_name)}</td>
                <td>—</td>
                <td>${formatCurrency(o.total_cost)}</td>
                <td><span class="status-badge status-${o.status}">${o.status}</span></td>
                <td>${o.expected_date ? new Date(o.expected_date).toLocaleDateString() : '—'}</td>
                <td>
                    <button class="action-btn view" onclick="viewPO('${o.id}')">👁️ View</button>
                    ${o.status !== 'received' && o.status !== 'cancelled' ? `<button class="action-btn edit" onclick="receivePO('${o.id}')">✅ Receive</button>` : ''}
                    <button class="action-btn edit" onclick="editPOStatus('${o.id}','${o.status}')">✏️ Status</button>
                    <button class="action-btn delete" onclick="confirmDeletePO('${o.id}')">🗑️ Delete</button>
                </td>
            </tr>`).join('');
    } catch (err) {
        console.error('PO error:', err);
        showToast('Failed to load purchase orders', 'error');
    }
}

async function openPOModal() {
    document.getElementById('po-form').reset();
    document.getElementById('po-items-container').innerHTML = buildPOItemRow();
    await loadWarehouses();
    await loadProductsForSelect();
    document.getElementById('po-warehouse')?.addEventListener('change', loadProductsForSelect);
    attachPOItemEvents(document.querySelector('.po-item-row'));
    updatePOTotal();
    showModal('purchase-order-modal');
}

function buildPOItemRow() {
    return `<div class="po-item-row">
        <select class="po-item-product" required><option value="">Select Product</option></select>
        <select class="po-item-unit" required>
            <option value="unit">Unit</option><option value="carton">Carton (12)</option><option value="liter20">20L Container</option>
        </select>
        <input type="number" class="po-item-qty" min="1" value="1" required>
        <input type="number" class="po-item-cost" step="0.01" min="0" placeholder="Unit Cost" required>
        <span class="po-item-total">${formatCurrency(0)}</span>
        <button type="button" class="btn btn-icon btn-danger remove-item" aria-label="Remove item">×</button>
    </div>`;
}

function attachPOItemEvents(row) {
    row.querySelector('.po-item-qty').addEventListener('input', updatePOItemTotal.bind(row.querySelector('.po-item-qty')));
    row.querySelector('.po-item-cost').addEventListener('input', updatePOItemTotal.bind(row.querySelector('.po-item-cost')));
    row.querySelector('.remove-item').addEventListener('click', () => {
        if (document.querySelectorAll('.po-item-row').length > 1) { row.remove(); updatePOTotal(); }
    });
}

function addPOItemRow() {
    const container = document.getElementById('po-items-container');
    container.insertAdjacentHTML('beforeend', buildPOItemRow());
    const newRow = container.lastElementChild;
    const firstOptions = container.querySelector('.po-item-product').innerHTML;
    newRow.querySelector('.po-item-product').innerHTML = firstOptions;
    attachPOItemEvents(newRow);
}

function updatePOItemTotal() {
    const row = this.closest('.po-item-row');
    const qty = parseInt(row.querySelector('.po-item-qty').value) || 0;
    const cost = parseFloat(row.querySelector('.po-item-cost').value) || 0;
    row.querySelector('.po-item-total').textContent = formatCurrency(qty * cost);
    updatePOTotal();
}

function updatePOTotal() {
    let total = 0;
    document.querySelectorAll('.po-item-row').forEach(row => {
        const qty = parseInt(row.querySelector('.po-item-qty').value) || 0;
        const cost = parseFloat(row.querySelector('.po-item-cost').value) || 0;
        const lineTotal = qty * cost;
        row.querySelector('.po-item-total').textContent = formatCurrency(lineTotal);
        total += lineTotal;
    });
    document.getElementById('po-total').textContent = formatCurrency(total);
}

async function handlePOSubmit(e) {
    e.preventDefault();
    const warehouseId = document.getElementById('po-warehouse')?.value;
    if (!warehouseId) { showToast('Please select a warehouse', 'error'); return; }
    const items = [];
    let hasError = false;
    document.querySelectorAll('.po-item-row').forEach(row => {
        const productId = row.querySelector('.po-item-product').value;
        const unitCost = parseFloat(row.querySelector('.po-item-cost').value);
        if (!productId || isNaN(unitCost)) { hasError = true; return; }
        items.push({
            product_id: productId,
            unit_type: row.querySelector('.po-item-unit').value,
            quantity: parseInt(row.querySelector('.po-item-qty').value),
            unit_cost: unitCost
        });
    });
    if (hasError || !items.length) { showToast('Please add at least one valid item', 'error'); return; }
    const data = {
        supplier_name: document.getElementById('po-supplier-name').value.trim(),
        supplier_contact: document.getElementById('po-supplier-contact').value.trim(),
        warehouse_id: warehouseId,
        expected_date: document.getElementById('po-expected-date').value || null,
        items, notes: document.getElementById('po-notes').value.trim()
    };
    try {
        const res = await fetchWithAuth(`${API_BASE}/purchase-orders`, { method: 'POST', body: JSON.stringify(data) });
        const result = await res.json();
        if (!res.ok) throw new Error(result.error);
        showToast('Purchase order created', 'success');
        closeModal('purchase-order-modal');
        loadPurchaseOrders();
    } catch (err) { showToast(err.message, 'error'); }
}

async function viewPO(id) {
    try {
        const res = await fetchWithAuth(`${API_BASE}/purchase-orders/${id}`);
        const po = await res.json();
        alert(`PO: ${po.supplier_name}\nWarehouse: ${po.warehouse_name}\nStatus: ${po.status}\nTotal: ${formatCurrency(po.total_cost)}\nItems: ${po.items?.length || 0}`);
    } catch (err) { showToast(err.message, 'error'); }
}

async function receivePO(id) {
    showConfirm('Mark this purchase order as received? Stock will be updated.', async () => {
        try {
            const res = await fetchWithAuth(`${API_BASE}/purchase-orders/${id}/receive`, { method: 'PUT' });
            const result = await res.json();
            if (!res.ok) throw new Error(result.error);
            showToast('Purchase order received and stock updated', 'success');
            loadPurchaseOrders(); loadStock(); loadDashboard();
        } catch (err) { showToast(err.message, 'error'); }
    });
}

function editPOStatus(id, currentStatus) {
    const statuses = ['pending', 'ordered', 'partial', 'received', 'cancelled'];
    const newStatus = prompt(`Change status (current: ${currentStatus})\nOptions: ${statuses.join(', ')}`, currentStatus);
    if (!newStatus || !statuses.includes(newStatus.toLowerCase())) return;
    fetchWithAuth(`${API_BASE}/purchase-orders/${id}/status`, {
        method: 'PUT', body: JSON.stringify({ status: newStatus.toLowerCase() })
    }).then(r => r.json()).then(result => {
        if (result.error) throw new Error(result.error);
        showToast('Status updated', 'success');
        loadPurchaseOrders();
    }).catch(err => showToast(err.message, 'error'));
}

function confirmDeletePO(id) {
    showConfirm('Delete this purchase order?', async () => {
        try {
            const res = await fetchWithAuth(`${API_BASE}/purchase-orders/${id}`, { method: 'DELETE' });
            const result = await res.json();
            if (!res.ok) throw new Error(result.error);
            showToast('Purchase order deleted', 'success');
            loadPurchaseOrders();
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
                    ${!a.is_read ? `<button class="action-btn edit" onclick="markAlertRead('${a.id}')">✓ Read</button>` : ''}
                    <button class="action-btn delete" onclick="confirmDeleteAlert('${a.id}')">🗑️</button>
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
            if (el) el.value = s.value;
        });
        const tr = settings.find(s => s.key === 'tax_rate');
        if (tr) taxRate = parseFloat(tr.value) || 0.10;
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
    const fields = ['tax_rate', 'currency', 'low_stock_threshold_default'];
    try {
        for (const key of fields) {
            const el = document.getElementById(`setting-${key}`);
            if (el) await fetchWithAuth(`${API_BASE}/settings/${key}`, { method: 'PUT', body: JSON.stringify({ value: el.value }) });
        }
        taxRate = parseFloat(document.getElementById('setting-tax_rate')?.value) || 0.10;
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
                    ${u.id !== currentUser?.id ? `<button class="action-btn delete" onclick="confirmDeleteUser('${u.id}','${escapeHtml(u.username)}')">🗑️ Delete</button>` : '<span style="color:var(--text-muted)">You</span>'}
                </td>
            </tr>`).join('');
    } catch (err) { console.error('Users error:', err); }
}

function openUserModal() {
    document.getElementById('user-form').reset();
    document.getElementById('user-id').value = '';
    document.getElementById('user-modal-title').textContent = 'Add User';
    showModal('user-modal');
}

async function handleUserSubmit(e) {
    e.preventDefault();
    const data = {
        username: document.getElementById('user-username').value.trim(),
        email: document.getElementById('user-email').value.trim(),
        password: document.getElementById('user-password').value,
        role: document.getElementById('user-role').value
    };
    try {
        const res = await fetchWithAuth(`${API_BASE}/auth/register`, { method: 'POST', body: JSON.stringify(data) });
        const result = await res.json();
        if (!res.ok) throw new Error(result.error);
        showToast('User created', 'success');
        closeModal('user-modal');
        loadUsers();
    } catch (err) { showToast(err.message, 'error'); }
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
        showToast('Password changed successfully', 'success');
        closeModal('password-modal');
        document.getElementById('password-form').reset();
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
// START THE APP
// ===================================================

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}