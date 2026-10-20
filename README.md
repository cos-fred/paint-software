# Paint Software - Inventory & Sales Tracker

A comprehensive stock and inventory management system built for paint businesses with support for units, cartons (12 units), and 20L containers.

## Features

### Product Management
- **Multi-unit pricing**: Unit price, Carton price (12× unit), 20L container price
- **Stock tracking**: Separate inventory for units, cartons, and 20L containers
- **Low stock alerts**: Configurable thresholds with automatic notifications
- **Categories**: Organize products by category
- **Stock movements**: Full audit trail of all inventory changes

### Customer Management
- Complete customer profiles (name, contact, address, tax ID)
- Purchase history tracking
- Total spent and average purchase analytics

### Sales & Receipts
- **Multi-unit sales**: Sell by unit, carton (12), or 20L container
- **Automatic pricing**: Carton = 12× unit price, 20L = custom price
- **Professional receipts**: Company branding, itemized details, tax calculation
- **Payment tracking**: Cash, card, transfer, credit with status management
- **Walk-in customers**: Quick sales without customer selection

### Purchase Orders
- Create orders for suppliers
- Receive stock with automatic inventory updates
- Track order status (pending, ordered, partial, received, cancelled)

### Reports & Analytics
- **Inventory value**: Total worth by product and category
- **Sales summary**: Revenue, tax, discounts, average sale
- **Top products**: Best sellers by quantity and revenue
- **Top customers**: Highest spending customers
- **Daily sales chart**: 30-day visual revenue trend

### Alerts & Notifications
- Low stock warnings (configurable threshold)
- Severity levels (warning, danger, info)
- Mark as read / delete functionality

### Security
- **JWT authentication** with secure password hashing (bcrypt)
- **Role-based access**: Admin and User roles
- **Rate limiting** (general API + stricter login limiter)
- **Helmet.js** security headers
- **CORS** limited to configured origins (wildcard forbidden in production)
- **Input validation** on all endpoints
- **No default administrator password**

### Online Access Ready
- RESTful API for frontend integration
- Environment-based configuration
- Easy deployment to cloud platforms (Railway, Render, Heroku, etc.)
- PostgreSQL migration ready (currently uses SQLite)

## Quick Start

### Prerequisites
- Node.js 18+ installed

### Installation

```bash
cd "paint software"
npm install
npm start
```

The server will start at `http://localhost:3000`

### First-run administrator

There is **no default password**. On a fresh database, set `ADMIN_PASSWORD` (12+ characters) in `.env` before starting. The account username is `admin`. Later startups never reset that password.

If the database already exists, start the app as usual and log in with the current administrator credentials.

## Configuration

Copy `.env.example` to `.env` and fill in real values. Do not commit `.env`.

```env
PORT=3000
NODE_ENV=development
JWT_SECRET=
ADMIN_PASSWORD=
DB_PATH=./paint_inventory.db
# CORS_ORIGIN=http://localhost:3000
```

Generate a JWT secret:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

### CORS

- Leave `CORS_ORIGIN` empty when the browser loads the UI from this same server (same-origin).
- For a separate frontend, set explicit origins, e.g. `https://app.example.com`.
- `CORS_ORIGIN=*` is allowed only in development and is rejected in production.

### Roles

Server-side permission matrix:

| Action | Authenticated staff (`user`) | Administrator |
| --- | --- | --- |
| Create sales, view products/sales/customers | Yes | Yes |
| Create/update customers | Yes | Yes |
| Create/update/delete products, stock movements, transfers, returns | No | Yes |
| Change payment status or cancel a sale | No | Yes |
| User, settings, and audit management | No | Yes |

Authorization is enforced on the server. Hiding buttons in the UI is not sufficient.

Tokens last 24 hours by default (`JWT_EXPIRES_IN`). Every request re-checks the current role, active flag, and token version. Password changes, role changes, and disabling an account invalidate existing sessions immediately.

### Login rate limiting

Failed logins are limited separately from the general API (default 10 failures / 15 minutes per IP). Behind a reverse proxy set `TRUST_PROXY=1` so the limiter uses `X-Forwarded-For`.

### JWT secret rotation

Change `JWT_SECRET` and restart the process. All outstanding tokens stop verifying. Users must log in again. Rotate immediately if a secret may have been committed, logged, or shared.

### Production Deployment

1. Set a strong random `JWT_SECRET` (32+ characters, not a placeholder)
2. Set `ADMIN_PASSWORD` for first run only, then store it in a password manager
3. Set `NODE_ENV=production`
4. Set `CORS_ORIGIN` to your real https origin(s), never `*`
5. Set `TRUST_PROXY=1` behind Railway/Render/nginx
6. Enable HTTPS at the reverse proxy
7. Keep the SQLite file on a persistent volume and restrict file permissions

## Database Migration (SQLite → PostgreSQL)

For production, migrate to PostgreSQL:

1. Install `pg` package: `npm install pg`
2. Update `database.js` to use `pg` instead of `sqlite3`
3. Run migration script to transfer data
4. Update connection pool settings

## API Endpoints

### Authentication
- `POST /api/auth/login` - Login
- `POST /api/auth/register` - Register (admin only)
- `GET /api/auth/me` - Current user
- `PUT /api/auth/change-password` - Change password
- `GET /api/auth/users` - List users (admin)
- `POST /api/auth/users` - Create user (admin)
- `PUT /api/auth/users/:id` - Update user (admin)
- `DELETE /api/auth/users/:id` - Delete user (admin)

### Products
- `GET /api/products` - List products (with filters)
- `GET /api/products/categories` - List categories
- `GET /api/products/low-stock` - Low stock products
- `GET /api/products/:id` - Get product
- `POST /api/products` - Create product
- `PUT /api/products/:id` - Update product
- `DELETE /api/products/:id` - Delete product
- `POST /api/products/:id/stock-movement` - Record stock movement
- `GET /api/products/:id/movements` - Stock movement history

### Customers
- `GET /api/customers` - List customers
- `GET /api/customers/:id` - Get customer
- `GET /api/customers/:id/purchases` - Customer purchase history
- `POST /api/customers` - Create customer
- `PUT /api/customers/:id` - Update customer
- `DELETE /api/customers/:id` - Delete customer

### Sales
- `GET /api/sales` - List sales (with filters)
- `GET /api/sales/:id` - Get sale with items
- `GET /api/sales/:id/receipt` - Generate receipt
- `POST /api/sales` - Create sale
- `PUT /api/sales/:id/payment-status` - Update payment status
- `DELETE /api/sales/:id` - Delete sale (restores stock)

### Purchase Orders
- `GET /api/purchase-orders` - List purchase orders
- `GET /api/purchase-orders/:id` - Get PO with items
- `POST /api/purchase-orders` - Create PO
- `PUT /api/purchase-orders/:id/receive` - Receive PO (updates stock)
- `PUT /api/purchase-orders/:id/status` - Update status
- `DELETE /api/purchase-orders/:id` - Delete PO

### Reports
- `GET /api/reports/inventory` - Inventory summary & value
- `GET /api/reports/inventory/value-by-category` - Value by category
- `GET /api/reports/sales/summary` - Sales summary
- `GET /api/reports/sales/by-product` - Top products
- `GET /api/reports/sales/by-customer` - Top customers
- `GET /api/reports/sales/daily` - Daily sales (last N days)
- `GET /api/reports/stock-movements` - Stock movement history

### Alerts
- `GET /api/alerts` - List alerts
- `GET /api/alerts/unread-count` - Unread count
- `PUT /api/alerts/:id/read` - Mark as read
- `PUT /api/alerts/read-all` - Mark all as read
- `DELETE /api/alerts/:id` - Delete alert

### Settings
- `GET /api/settings` - List settings (admin)
- `GET /api/settings/:key` - Get setting
- `PUT /api/settings/:key` - Update setting (admin)
- `DELETE /api/settings/:key` - Delete setting (admin)

## Recommended Features for Future Enhancement

1. **Barcode/QR Code Scanning** - Quick product entry and sales
2. **Email Notifications** - Low stock alerts via email
3. **Multi-location Support** - Warehouse/store inventory separation
4. **Supplier Management** - Dedicated supplier profiles
5. **Expense Tracking** - Operational costs and profit margins
6. **Customer Portal** - Online ordering for repeat customers
7. **Mobile App** - React Native / PWA for on-the-go access
8. **Advanced Analytics** - Seasonal trends, forecasting
9. **Integration APIs** - Accounting software (QuickBooks, Xero)
10. **Backup/Restore** - Automated database backups

## File Structure

```
paint software/
├── server.js              # Main entry point
├── database.js            # SQLite initialization & schema
├── auth.js                # JWT authentication utilities
├── .env                   # Environment configuration
├── package.json
├── routes/
│   ├── auth.js            # Authentication routes
│   ├── products.js        # Product management
│   ├── customers.js       # Customer management
│   ├── sales.js           # Sales & receipts
│   ├── purchaseOrders.js  # Purchase orders
│   ├── reports.js         # Analytics & reports
│   ├── alerts.js          # Alert management
│   ├── settings.js        # System settings
│   └── users.js           # User management (admin)
└── public/
    ├── index.html         # Main HTML
    ├── styles.css         # Complete styling
    └── app.js             # Frontend application
```

## License

MIT License - Feel free to modify and distribute.

## Support

For issues or feature requests, please check the codebase or create an issue in your repository.