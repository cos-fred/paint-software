function guardedSubmit(handler) {
    return async function (event) {
        event.preventDefault();
        const form = event.currentTarget;
        if (form.dataset.submitting === 'true') return;
        form.dataset.submitting = 'true';
        const buttons = [...form.querySelectorAll('button[type="submit"]')];
        buttons.forEach((button) => (button.disabled = true));
        try {
            await handler.call(this, event);
        } catch (err) {
            showToast(err.message, 'error');
        } finally {
            form.dataset.submitting = 'false';
            buttons.forEach((button) => (button.disabled = false));
        }
    };
}

function setConnectionStatus(message) {
    const status = document.getElementById('connection-status');
    if (status) status.textContent = message;
}

function updatePendingReturnButton() {
    const button = document.getElementById('retry-return-btn');
    if (button)
        button.hidden = !sessionStorage.getItem(mutationStorageKey('return'));
}
async function retryPendingReturn() {
    const cached = JSON.parse(
        sessionStorage.getItem(mutationStorageKey('return')) || 'null'
    );
    if (!cached) return;
    try {
        await mutationRequest(
            API_BASE + '/returns',
            JSON.parse(cached.body),
            'return'
        );
        updatePendingReturnButton();
        closeModal('return-modal');
        showToast('Return confirmed', 'success');
        loadReturns();
        loadStock();
        loadDashboard();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

async function loadBackupHealth() {
    const response = await fetchWithAuth(API_BASE + '/system/status');
    const status = await response.json();
    const backup = status.backup;
    const messages = [
        backup.last_success
            ? `Last verified local backup: ${new Date(backup.last_success).toLocaleString()}`
            : 'No verified backup yet.'
    ];
    if (backup.error) messages.push(backup.error);
    if (backup.overdue) messages.push('Backup is overdue.');
    if (!backup.remote_configured)
        messages.push('Off-server backup destination is not configured.');
    else
        messages.push(
            backup.last_remote_success
                ? `Last independent copy: ${new Date(backup.last_remote_success).toLocaleString()}`
                : 'An independent copy has not succeeded yet.'
        );
    if (!backup.encrypted)
        messages.push('Backup encryption is not configured.');
    document.getElementById('backup-health').textContent = messages.join(' ');
    document.getElementById('reset-card').style.display =
        status.reset_enabled && currentUser?.username === 'admin' ? '' : 'none';
}

function setupLaunchControls() {
    for (const name of Object.keys(listPages)) {
        const section = document.getElementById(name + '-section');
        const pager = document.createElement('div');
        pager.id = name + '-pagination';
        pager.className = 'pagination';
        pager.setAttribute('aria-label', name + ' pages');
        section.appendChild(pager);
    }
    const resetSearch = (id, name) =>
        document.getElementById(id)?.addEventListener('input', () => {
            listPages[name].offset = 0;
        });
    resetSearch('customer-search', 'customers');
    resetSearch('sale-search', 'sales');
    resetSearch('audit-search', 'audit');
    for (const id of ['sale-status-filter', 'sale-date-from', 'sale-date-to'])
        document.getElementById(id)?.addEventListener('change', () => {
            listPages.sales.offset = 0;
        });
    document
        .getElementById('warehouse-filter')
        .addEventListener('change', () => {
            for (const state of Object.values(listPages)) state.offset = 0;
            document.getElementById('stock-warehouse-filter').value =
                getActiveWarehouseId();
            const active =
                document.querySelector('.nav-item.active')?.dataset.section;
            if (active === 'sales') loadSales();
        });
    document
        .getElementById('return-sale')
        .addEventListener('change', loadReturnItems);
    document.getElementById('return-sale-search').addEventListener(
        'input',
        debounce(async () => {
            document.getElementById('return-items-container').innerHTML = '';
            try {
                await loadReturnSaleOptions();
            } catch (err) {
                showToast(err.message, 'error');
            }
        }, 300)
    );
    document
        .getElementById('sale-customer-search')
        .addEventListener('input', debounce(loadCustomersForSelect, 300));
    document
        .getElementById('retry-sale-btn')
        .addEventListener('click', retryPendingSale);
    document
        .getElementById('retry-return-btn')
        .addEventListener('click', retryPendingReturn);
    document.getElementById('profile-form').addEventListener(
        'submit',
        guardedSubmit(async () => {
            await fetchWithAuth(API_BASE + '/auth/profile', {
                method: 'PUT',
                body: JSON.stringify({
                    email: document.getElementById('profile-email').value.trim()
                })
            });
            await loadUser();
            showToast('Profile saved', 'success');
        })
    );
    document
        .getElementById('backup-now-btn')
        .addEventListener('click', async function () {
            this.disabled = true;
            try {
                await fetchWithAuth(API_BASE + '/system/backup', {
                    method: 'POST',
                    body: '{}'
                });
                await loadBackupHealth();
                showToast('Backup verified', 'success');
            } catch (err) {
                showToast(err.message, 'error');
                await loadBackupHealth().catch(() => {});
            } finally {
                this.disabled = false;
            }
        });
    document
        .getElementById('backup-download-btn')
        .addEventListener('click', async function () {
            this.disabled = true;
            try {
                const response = await fetchWithAuth(
                    API_BASE + '/system/backup/download'
                );
                const url = URL.createObjectURL(await response.blob());
                const anchor = document.createElement('a');
                anchor.href = url;
                anchor.download =
                    /filename="?([^";]+)"?/.exec(
                        response.headers.get('Content-Disposition') || ''
                    )?.[1] || 'paint-backup.db';
                anchor.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
                await loadBackupHealth();
            } catch (err) {
                showToast(err.message, 'error');
            } finally {
                this.disabled = false;
            }
        });
    window.addEventListener('offline', () =>
        setConnectionStatus('Offline — saves unavailable')
    );
    window.addEventListener('online', () => {
        setConnectionStatus('Connection restored; refreshing…');
        loadDashboard();
    });
    document.querySelectorAll('.modal').forEach((modal) => {
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        modal.tabIndex = -1;
        const title = modal.querySelector('h3');
        if (title) {
            if (!title.id) title.id = modal.id + '-heading';
            modal.setAttribute('aria-labelledby', title.id);
        }
        modal.addEventListener('keydown', (event) => {
            if (event.key !== 'Tab') return;
            const controls = [
                ...modal.querySelectorAll(
                    'button,input:not([type="hidden"]),select,textarea,a[href]'
                )
            ].filter(
                (el) => !el.disabled && !el.hidden && el.getClientRects().length
            );
            const first = controls[0],
                last = controls.at(-1);
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last?.focus();
            }
            if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first?.focus();
            }
        });
    });
    document.querySelectorAll('.form-group').forEach((group) => {
        const label = group.querySelector('label');
        const control = group.querySelector('input,select,textarea');
        if (label && control?.id && !label.htmlFor) label.htmlFor = control.id;
    });
    applyPermissions();
}
