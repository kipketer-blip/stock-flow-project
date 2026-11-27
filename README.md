# StockFlow Pro — Inventory Movements

Full-stack inventory management with stock-in / stock-out movement tracking.
Node.js + Express, SQLite (better-sqlite3), session logins, plain HTML/CSS/JS frontend.

## How to run (VS Code)

You need **Node.js 20 LTS or newer** (https://nodejs.org, default options) and **Visual Studio Code** (https://code.visualstudio.com). The first run needs internet to download the libraries.

1. Extract the zip, e.g. to the Desktop.
2. Open VS Code → **File → Open Folder…** → choose this code folder (the one that contains `package.json`).
3. Press **F5** (or **Run → Start Debugging**). VS Code installs the libraries, starts the server and opens http://localhost:3000 in the browser.
4. To stop the server, press **Shift+F5** or click the red square.

Or open **Terminal → New Terminal** in VS Code and run:

```bash
npm install
npm start
```

then open http://localhost:3000. Outside VS Code you can also double-click **`start.bat`** on Windows.

### Running on another PC

The folder does **not** contain anybody's data: a new PC starts with a fresh database containing sample products and the default admin account below. To move real data as well, stop the app on the old PC and copy its `inventory.db` into this folder before the first start.

To use the system from other phones or computers on the same network, open `http://<this-PC-IP-address>:3000` (find the address with `ipconfig`). Windows may ask to allow Node.js through the firewall; allow it on private networks.

The project report (Chapters 1–5) is the Word file in this folder.

On first start the app creates `inventory.db`, some sample products and movements, and an admin account:

- **Username:** `admin`
- **Password:** `admin123` (or set `ADMIN_PASSWORD` before the first start)

Change the password after logging in (sidebar → Change password).

## Features

- **Dashboard** – product count, units on hand, stock value, low-stock count, 30-day in/out totals, open purchase orders, 14-day flow chart, low-stock list, recent movements
- **Products** – create/edit/search, SKU, category, unit, unit cost, reorder level, opening stock; delete (products with history are archived to keep the log intact); CSV import and export
- **Movements** – stock in, stock out, admin stock adjustments (with a required reason); stock can never go negative; every movement records the balance after it, the cost at the time and the user who made it; filter by type/product/supplier or customer/date/text; paged list; CSV export
- **Purchase orders** – order from a supplier, receive the goods in one or several deliveries (each delivery becomes a stock-in), cancel, print; overdue orders show in alerts
- **Suppliers & customers** – picked from a list on each movement; new names are added automatically; contact details, history, totals; admins can merge duplicates
- **Reports** – stock value by category, monthly in/out value, top movers, slow and dead stock, top suppliers and customers, for any date range; printable
- **Alerts** – the 🔔 in the sidebar shows low-stock items, overdue purchase orders and overdue invoices; a warning also pops up when a stock-out takes an item down to its reorder level
- **Barcodes** – print barcode labels (Code 128 of the SKU) for selected products; scan with any USB barcode scanner into the "Scan / type SKU" box, or with the camera where the browser supports it (Chrome on Android, Safari/Chrome on macOS)
- **Admin** – admin and staff roles; admins can adjust stock, delete things, add/delete users, change roles and reset passwords (the user is signed out everywhere); settings for company name and currency; activity log of changes to products, contacts, orders, users and settings
- **Accounts** – there is no public sign-up. The **main admin** (the first admin account) and other admins create accounts on the Admin page, and new users can sign in straight away. Only the main admin can create or delete other admins; the main admin cannot be deleted or demoted. Admins can delete users (type the username to confirm); the user's past movements and sales are kept.
- **Logins** – stored in the database, so they survive restarts; you are signed out after 8 hours of inactivity
- **Backups** – a copy of the database is saved to `backups/` once a day (the newest 14 are kept); admins can make one on demand and download any of them from the Admin page
- **Locations** – keep stock in several shops or warehouses (Admin → Locations). Every movement, sale and purchase order happens at a location; products show stock per location; **Transfer** moves units between locations; reports show stock by location. Existing stock starts in "Main Store". A location can only be closed once it is empty.
- **Sales & invoices** – the **Sales** page records a sale (customer, location, products, price, discount), takes the items out of stock and creates a numbered invoice (INV-00001…). Record full, part or later payments (cash, M-Pesa, card, bank, cheque); unpaid and overdue invoices show on the dashboard and in alerts. Print the invoice with your business details and KRA PIN. Admins can void a sale, which puts the stock back. Set VAT (e.g. 16%, prices including or excluding VAT), invoice prefix and footer under Admin → Invoices & tax. Give each product a **selling price** (edit the product, or import a `sell_price` column).
- **Profit** – each sale stores the cost of the goods sold, so Reports show sales, cost, gross profit and margin, the most profitable products, sales by month and payments by method.
- **Email alerts** – Admin → Email alerts: enter your mail server (e.g. Gmail with an App password: `smtp.gmail.com`, port 587, STARTTLS), a From address and who should receive alerts. You get one email when items drop to their reorder level (grouped, at most once a day per item) and, optionally, a daily summary of low stock, overdue purchase orders, overdue invoices and yesterday's sales. "Send test email" checks the settings; recent emails and errors are listed there. The mail password is stored in the app's database on this computer.

## Restoring a backup

1. Stop the app.
2. Delete `inventory.db`, `inventory.db-wal` and `inventory.db-shm`.
3. Copy the backup file into the project folder and rename it `inventory.db`.
4. Start the app.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DB_PATH` | `./inventory.db` | SQLite file |
| `SESSION_SECRET` | generated once, stored in the DB | Login cookie signing key |
| `ADMIN_PASSWORD` | `admin123` | Initial admin password (first start only) |
| `BACKUP_DIR` | `./backups` | Where backups are saved (point it at another drive if you can) |
| `BACKUP_KEEP` | `14` | How many backups to keep |

## Files

- `server.js` – Express setup; loads the route files
- `db.js` – schema and upgrades of older databases, password hashing, seed data, atomic stock-movement logic
- `routes/` – API by area: `auth`, `dashboard` (also alerts and settings), `products` (also import), `movements`, `parties` (suppliers & customers), `purchase-orders`, `reports`, `admin` (users, settings, activity log, backups), `locations`, `sales` (invoices, payments, voids), `email` (alert settings)
- `lib/http.js` – shared request helpers (login checks, local-time handling, CSV output)
- `lib/mailer.js`, `lib/alerts.js` – sending email, low-stock alerts and the daily summary
- `session-store.js` – keeps logins in SQLite
- `backup.js` – daily and on-demand database backups
- `start.bat` – one-click start on Windows (installs libraries if needed and opens the browser)
- `.vscode/` – VS Code run settings (F5 installs the libraries and starts the app)
- `public/` – frontend: `index.html`, `styles.css`, and `js/` with one file per page (`core.js` holds the shared helpers)

## Importing products

Products → **Import CSV**. Columns (header names are matched loosely): `sku`, `name`, `category`, `unit`, `unit_cost`, `reorder_level`, `opening_stock`.
New SKUs are added (opening stock is recorded as a stock-in); existing SKUs have their details updated but their stock is never changed by an import.
Numbers like `2,5`, `1,234.50` and `$3` are understood. Rows with problems are skipped and listed after the import.

Note: `better-sqlite3` is pinned to 12.4.1 because newer versions have no prebuilt binary for Node 20 on Windows.
