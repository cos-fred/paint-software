# VEEMENZ Paint Software — Shareholder & User Guide

**Inventory & Sales Tracker for Paint Businesses**

---

## Welcome

VEEMENZ is a simple, secure system that helps your paint business track products, customers, sales, stock, and warehouse movements in one place. It works in any web browser, so staff can use it from a desktop, tablet, or laptop on your premises.

This guide explains what each screen and button does, written for business owners and managers — no technical knowledge required.

---

## Getting Started

### Logging In

1. Open the web address provided by your administrator.
2. You will see the **VEEMENZ login screen**.
3. Enter your **Username** and **Password**.
4. Click **Sign In**.

After logging in, you will see the main dashboard. The left sidebar contains the main menu. Your role (Admin or Staff) determines which menu items you can see.

### Logging Out

Click the profile icon in the top-right corner, then click **Logout**.

---

## Main Menu — What Each Section Does

| Menu Item | What It's For | Who Can Use It |
|-----------|---------------|----------------|
| **Dashboard** | Overview of your business: total products, inventory value, stock count, low-stock warnings, recent sales, and a sales trend chart. | All users |
| **Stock** | View current stock levels across warehouses. See which items are low, OK, or out of stock. Adjust stock levels here. | All users (view); Admin (adjust) |
| **Products** | Add, edit, and archive paint products. Manage pricing and SKUs. | All users (view); Admin (add/edit/delete) |
| **Customers** | Manage your customer list and see their purchase history and total spent. | All users (view/add/edit); Admin (delete) |
| **Sales** | Record new sales, view past sales, print receipts, update payment status, and cancel sales. | All users (create/view); Admin (cancel/change status) |
| **Transfers** | Move stock between warehouses (e.g., from Main Warehouse to Secondary Warehouse). | All users (view); Admin (create) |
| **Returns** | Process customer returns and restore stock to inventory. | All users (view); Admin (process) |
| **Alerts** | View low-stock warnings and system notifications. Mark them as read when handled. | All users |
| **Reports** | View sales by product, sales by customer, daily sales trends, and inventory value. | All users |
| **Settings** | Manage company details, tax rate, currency, notifications, and user accounts. | Admin only |
| **Audit Log** | See a history of who did what and when (useful for accountability). | Admin only |
| **Profile** | View your own account details and change your password. | All users |

---

## Dashboard — Your Business at a Glance

The Dashboard shows four key numbers at the top:

- **Total Products** — how many active products you have.
- **Inventory Value** — the total worth of stock on hand.
- **Cartons + 20L** — total quantity of paint in stock.
- **Low Stock Alerts** — how many items are running low and need reordering.

Below that, you will see:

- **Low Stock Alerts list** — products that need attention.
- **Recent Sales** — the last few sales completed.
- **Sales Trend (30 days)** — a simple bar chart showing daily revenue over the past month.

Use the **Warehouse** filter at the top to see data for one warehouse or all warehouses combined.

---

## Products — Managing Your Paint Inventory

### Adding a New Product

1. Go to **Products** in the sidebar.
2. Click **Add Product**.
3. Fill in the details:
   - **Name** — e.g., "Emulsion White 5L"
   - **SKU / Barcode** — optional product code
   - **Description** — optional notes
   - **Unit Price** — price for a single unit
   - **Carton Price** — price for a carton (auto-calculated as 12 × unit price, but you can change it)
   - **20L Container Price** — price for a 20-litre container
   - **Warehouse** — which warehouse this stock belongs to
   - **Initial Cartons** — how many cartons you are adding
   - **Initial 20L Stock** — how many 20L containers you are adding
   - **Low Stock Threshold** — when to get a warning (default is 10)
4. Click **Save Product**.

### Editing a Product

1. Go to **Products**.
2. Find the product in the list and click **Edit** (pencil icon).
3. Change the details you want to update.
4. Click **Save Product**.

### Archiving a Product

If you no longer sell a product:

1. Go to **Products**.
2. Click **Delete** (trash icon) next to the product.
3. Confirm the action.

The product is **archived**, not permanently deleted. This means your past sales records remain intact, but the product will no longer appear in the active product list or sales forms.

### Low Stock Only

Tick **Low Stock Only** to see only products that are at or below their warning threshold. This makes it easy to create a reorder list.

---

## Customers — Managing Your Client List

### Adding a Customer

1. Go to **Customers** in the sidebar.
2. Click **Add Customer**.
3. Fill in:
   - **Name** — required
   - **Email**, **Phone**, **Tax ID** — optional
   - **Address**, **City**, **Region**, **Postal Code**, **Country**
   - **Notes** — any special instructions
4. Click **Save Customer**.

### Editing a Customer

1. Go to **Customers**.
2. Click **Edit** next to the customer.
3. Update the details and click **Save Customer**.

### Deleting a Customer

Only administrators can delete customers. Click **Delete** (trash icon) and confirm.

### Customer Purchase History

Click on a customer's name or use **Purchases** to see everything they have bought from you, including dates and totals.

---

## Sales — Recording a Sale

### Creating a New Sale

1. Go to **Sales** in the sidebar.
2. Click **New Sale**.
3. Fill in:
   - **Customer** — select an existing customer, or leave as "Walk-in Customer" for cash sales.
   - **Warehouse** — which warehouse the stock is coming from.
   - **Payment Method** — Cash, Card, Bank Transfer, or Mobile Money (Momo).
   - **Items** — click **+ Add Item** for each product:
     - Select the product.
     - Select the unit type (Carton or 20L Container).
     - Enter the quantity.
     - Optionally add a line discount.
   - **Discount** — optional order-level discount (amount or percent).
   - **Notes** — optional.
4. Click **Complete Sale**.

The system will:
- Check that you have enough stock.
- Deduct the stock automatically.
- Calculate tax and totals.
- Create a receipt.
- Warn you if stock is running low after the sale.

### Viewing a Receipt

1. In the **Sales** list, click **View** (eye icon) next to any sale.
2. A receipt window opens showing:
   - Your company name and address.
   - Receipt number, date, and time.
   - Customer details (if not a walk-in).
   - Itemised list of products sold.
   - Subtotal, tax, discount, and total.
   - Payment method.
3. Click **Print** to print the receipt.

### Updating Payment Status

Only administrators can change payment status:

1. In the **Sales** list, click **Status** (pencil icon) next to a sale.
2. Choose the new status: Pending, Completed, Cancelled, or Refunded.
3. Confirm.

**Rules:**
- A sale cannot go back to "Pending" once it is "Completed".
- Cancelling or refunding a sale automatically returns the stock to your warehouse.

### Cancelling a Sale

1. In the **Sales** list, click **Delete** (trash icon) next to the sale.
2. Confirm.

This marks the sale as cancelled and restores the stock to inventory. The sale record is kept for history.

---

## Stock — Managing Inventory Levels

### Viewing Stock

Go to **Stock**. You will see a table of all products with:

- Carton price and 20L price.
- Carton stock and 20L stock quantities.
- Total value of stock.
- Status: OK, Low Stock, or Out of Stock.

Use the warehouse filter and **Low Stock Only** checkbox to narrow the list.

### Adjusting Stock

If you receive new stock, find damaged goods, or need to correct a mistake:

1. In the **Stock** section, click **Adjust** (gear icon) next to a product.
2. Select:
   - **Warehouse**
   - **Unit Type** (Carton or 20L Container)
   - **Movement Type**:
     - Stock In (+) — adding stock
     - Stock Out (-) — removing stock
     - Adjustment (+) or Adjustment (-) — correcting records
   - **Quantity**
   - **Notes** — reason for the change
3. Click **Save Adjustment**.

The system records the change in an audit trail so you always know who adjusted stock and why.

### Exporting Stock to Excel

Click **Export to Excel** in the Stock section to download a spreadsheet of your current inventory. This is useful for printing stock sheets or sharing with your accountant.

---

## Transfers — Moving Stock Between Warehouses

If you have more than one warehouse, you can move stock between them:

1. Go to **Transfers**.
2. Click **New Transfer**.
3. Select:
   - **Product**
   - **From Warehouse**
   - **To Warehouse** (must be different)
   - **Unit Type** (Carton or 20L Container)
   - **Quantity**
   - **Notes** — optional
4. Click **Transfer Stock**.

The system deducts stock from the source warehouse and adds it to the destination warehouse. All transfers are recorded in the audit log.

---

## Returns — Processing Customer Returns

If a customer returns paint:

1. Go to **Returns**.
2. Click **Process Return**.
3. Select the original **Sale**.
4. For each item being returned, enter the quantity (cannot exceed what was originally sold).
5. Enter a **Reason** (e.g., Damaged, Wrong Item).
6. Click **Process Return**.

The system:
- Restores the returned stock to your warehouse.
- Records the return against the original sale.
- Prevents you from returning more than was sold.

---

## Alerts — Low Stock Warnings

When a product's stock falls at or below its threshold, the system creates an alert.

### Viewing Alerts

Go to **Alerts**. You will see:

- **Type** — usually "Low Stock".
- **Product** — which item is low.
- **Message** — details of the warning.
- **Severity** — Info, Warning, or Danger.
- **Date** — when the alert was created.
- **Actions** — Mark as Read or Delete.

### Marking Alerts as Read

- Click **Read** next to an individual alert, or
- Click **Mark All Read** to clear all alerts at once.

You can also filter to show **Unread Only** so you focus on new warnings.

---

## Reports — Understanding Your Business

Go to **Reports** to see:

- **Inventory Value by Category** — how much stock you have and what it is worth.
- **Top Selling Products** — which paints sell the most by quantity and revenue.
- **Top Customers** — who spends the most with you.
- **Daily Sales (Last 30 Days)** — a chart showing revenue day by day.

Use the warehouse filter at the top to see reports for one location or all locations combined.

---

## Settings — Company & System Configuration (Admin Only)

Go to **Settings** to manage:

### Company Information

- **Company Name** — appears on receipts.
- **Company Address** — appears on receipts.
- **Company Phone** — appears on receipts.
- **Company Email** — appears on receipts.

### System Settings

- **Tax Rate (%)** — the default tax applied to sales (e.g., 10 for 10%).
- **Currency** — e.g., GHS.
- **Default Low Stock Threshold** — the default warning level for new products.
- **Notifications Enabled** — turn low-stock alerts on or off.
- **Webhook URL** — if you use an external messaging service, enter the webhook address here to receive low-stock notifications automatically.

---

## User Management (Admin Only)

### Adding a Staff Member

1. Go to **Settings** → **User Management**.
2. Click **Add User**.
3. Enter:
   - **Username**
   - **Email**
   - **Password** (must be at least 8 characters)
   - **Role** — Admin or Staff
4. Click **Save**.

### Editing or Disabling a User

1. In **User Management**, click **Edit** next to a user.
2. You can change their username, email, role, or mark them as inactive.
3. Click **Save**.

**Important:** Disabling a user immediately logs them out and prevents them from logging in again. Their sales and audit history are preserved.

### Changing Your Own Password

1. Click your profile icon in the top-right corner.
2. Click **Change Password**.
3. Enter your current password and new password.
4. Click **Change Password**.

---

## Real-Time Updates

If multiple staff members use VEEMENZ at the same time, the screens update automatically. When someone completes a sale, adjusts stock, or adds a customer, all other open screens refresh within seconds so everyone sees the same current data.

---

## Security & Best Practices

- **Keep your password secret.** Do not share login credentials.
- **Administrators should change the default admin password** after first login.
- **Log out** when you leave the computer unattended.
- **Only administrators** can add products, change prices, cancel sales, manage users, or view the audit log.
- **All actions are recorded** in the Audit Log, so there is always a record of who changed what.

---

## Getting Help

If you encounter an error or need assistance:

1. Note down what you were doing when the problem occurred.
2. Take a screenshot if possible.
3. Contact your system administrator or IT support.

---

*VEEMENZ Paint Software — Built for paint businesses. Simple, secure, and real-time.*
