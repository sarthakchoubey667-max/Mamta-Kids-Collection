# Fashion Store

## Run locally

Use Node.js 22.9 or newer. On Windows, run `start-server.cmd`, or open PowerShell here and run:

```powershell
npm.cmd start
```

Then open `http://localhost:3000`. Admin access is at `http://localhost:3000/admin.html`. On first setup, choose any non-empty owner password. Existing password hashes remain valid; the owner can change the password in Account settings.

## Security and store behavior

- Owner passwords are stored as per-password salted `scrypt` hashes; passwords are never saved as plain text.
- Admin endpoints require an owner session. Admin state-changing requests also require a same-origin `Origin` or `Referer` header. Sign-in/setup is limited to five failed attempts per IP address in a 15-minute window.
- Admin session cookies are `HttpOnly` and `SameSite=Strict`; `Secure` is added in production.
- Product uploads accept JPEG, PNG, or WebP only, verify the file signature, and are limited to 5 MB.
- Product prices and names are read from the server catalog when an order is calculated. The browser cannot set the charged price.
- Each checkout sends an idempotency key, preventing a repeated request from creating another order. Numeric stock set by the owner is checked and reduced atomically with order creation. Blank stock means untracked.
- Order IDs are unique. Orders and contact messages are saved in SQLite.
- After checkout, the customer sees an on-screen receipt with the order ID, date, products, payment method, delivery details, and total. No email or SMS confirmation is sent yet.
- Order tracking updates are saved as a status timeline. The customer tracking page checks for changes without reloading, and the owner can set manual delivery status/location notes. Courier GPS is not integrated. Browser tabs must remain open for live on-screen updates; off-page push/email/SMS alerts need an HTTPS deployment and a configured notification provider.
- Owners can update statuses through Confirmed, Processing, Shipped, Out for delivery, Near your location, and Delivered, then process Return requested, Return approved, Return picked up, or Returned. Customers can request a return after delivery from the order tracking page.
- Cash on Delivery is recorded as an order method. UPI is currently a manual arrangement; there is no payment gateway integration or verified online payment.

## Database, uploads, backup, and restore

`database/db.js` owns the database connection, schema initialization, migrations, settings, and storage operations. Tables are initialized automatically when the server starts. The default database is `data/store.sqlite`; uploaded product photos default to `images/uploads/`.

Both default folders are ignored by Git. For hosting, set `DATABASE_FILE` and `UPLOAD_DIR` to directories on the host's persistent volume. A local folder on an ephemeral container will be erased when that host replaces the container.

Create a consistent SQLite backup while the store is running:

```powershell
npm.cmd run db:backup
```

The backup is written under `backups/` (which is Git-ignored). To restore, stop the server first, then run:

```powershell
npm.cmd run db:restore -- "backups\store-backup.sqlite"
```

Restore saves a pre-restore safety backup beside the live database. Back up `images/uploads/` separately; the SQLite backup does not contain image files.

## Deployment configuration

Copy `.env.example` to `.env` for local environment variables, or set these variables in the hosting dashboard. Do not commit real `.env` files.

- `PORT`: hosting-provided port, usually supplied automatically.
- `NODE_ENV=production`: enables secure admin cookies.
- `APP_ORIGIN=https://your-domain.example`: exact public HTTPS origin used by CSRF checks and secure-cookie configuration.
- `DATABASE_FILE`: absolute path on persistent storage for SQLite.
- `UPLOAD_DIR`: absolute path on persistent storage for uploaded images.
- `ADMIN_PASSWORD`: optional first-start bootstrap password; if the database already has an owner hash it is ignored.
- `TRUST_PROXY=1`: use only behind a trusted proxy that replaces `X-Forwarded-For`; this lets per-IP login throttling use the visitor IP.

The production start command is `npm start`. Configure TLS/HTTPS and a persistent disk in the hosting provider. The app writes server errors to its process log; the host should retain those logs. Admin sessions are kept in memory, so owners sign in again after a process restart; use one app instance unless shared session storage is added.

## Current account scope

Customers can browse and place orders without signing in. Customer signup/login and personal order history are not implemented yet. The owner account is separate and has access to product, order, and contact-message management.

## Owner handoff checklist

1. Start the app locally and open `/admin.html` from the same server.
2. Create the first owner password in the setup form. Share it through a private channel; do not put it in source files or Git.
3. Add or edit products, set stock if it is tracked, and place a local COD test order before handoff.
4. Run `npm.cmd test` and create a backup with `npm.cmd run db:backup`.
5. Before public use, finish the hosting setup above and repeat customer checkout and owner admin checks on the live HTTPS URL.
