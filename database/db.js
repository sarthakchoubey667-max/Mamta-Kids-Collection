const fs = require("node:fs/promises");
const path = require("node:path");
const Database = require("better-sqlite3");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const DATA_FILE = path.join(DATA_DIR, "store.json");
const DATABASE_FILE = path.resolve(ROOT, process.env.DATABASE_FILE || path.join("data", "store.sqlite"));
let database;

async function readStore() {
    return {
        orders: database.prepare("SELECT payload FROM orders ORDER BY created_at").all().map(row => JSON.parse(row.payload)),
        messages: database.prepare("SELECT payload FROM messages ORDER BY created_at").all().map(row => JSON.parse(row.payload)),
        customProducts: database.prepare("SELECT payload FROM custom_products ORDER BY rowid").all().map(row => JSON.parse(row.payload))
    };
}

function writeStore(store) {
    const save = database.transaction(() => {
        database.prepare("DELETE FROM orders").run();
        database.prepare("DELETE FROM messages").run();
        database.prepare("DELETE FROM custom_products").run();
        const addOrder = database.prepare("INSERT INTO orders (id, created_at, payload) VALUES (?, ?, ?)");
        const addMessage = database.prepare("INSERT INTO messages (id, created_at, payload) VALUES (?, ?, ?)");
        const addProduct = database.prepare("INSERT INTO custom_products (id, payload) VALUES (?, ?)");
        for (const order of store.orders || []) addOrder.run(order.id, order.createdAt, JSON.stringify(order));
        for (const message of store.messages || []) addMessage.run(message.id, message.createdAt, JSON.stringify(message));
        for (const product of store.customProducts || []) addProduct.run(product.id, JSON.stringify(product));
    });
    save();
}

function getSetting(key) {
    return database.prepare("SELECT value FROM settings WHERE key = ?").get(key)?.value || "";
}

function setSetting(key, value) {
    database.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

function saveOrder(order, idempotencyKey, requestHash, builtInProductIds, trackingTokenHash) {
    const save = database.transaction(() => {
        const existing = database.prepare(`
            SELECT idempotency_keys.request_hash, orders.payload
            FROM idempotency_keys
            JOIN orders ON orders.id = idempotency_keys.order_id
            WHERE idempotency_keys.key = ?
        `).get(idempotencyKey);
        if (existing) {
            if (existing.request_hash !== requestHash) {
                throw Object.assign(new Error("This checkout request was already used with different order details. Refresh checkout and try again."), { status: 409 });
            }
            return { order: JSON.parse(existing.payload), duplicate: true };
        }

        let builtInOverrides = {};
        try { builtInOverrides = JSON.parse(getSetting("built_in_products") || "{}"); }
        catch { builtInOverrides = {}; }
        let builtInStockChanged = false;

        for (const item of order.items) {
            const customRow = database.prepare("SELECT payload FROM custom_products WHERE id = ?").get(item.productId);
            if (customRow) {
                const product = JSON.parse(customRow.payload);
                if (Number.isInteger(product.stock)) {
                    if (item.quantity > product.stock) {
                        throw Object.assign(new Error(`${product.name} does not have enough stock for this quantity.`), { status: 409 });
                    }
                    product.stock -= item.quantity;
                    database.prepare("UPDATE custom_products SET payload = ? WHERE id = ?").run(JSON.stringify(product), item.productId);
                }
                continue;
            }

            if (!builtInProductIds.includes(item.productId)) {
                throw Object.assign(new Error("A product in your cart is no longer available."), { status: 409 });
            }
            const product = builtInOverrides[item.productId] || {};
            if (Number.isInteger(product.stock)) {
                if (item.quantity > product.stock) {
                    throw Object.assign(new Error(`${item.name} does not have enough stock for this quantity.`), { status: 409 });
                }
                product.stock -= item.quantity;
                builtInOverrides[item.productId] = product;
                builtInStockChanged = true;
            }
        }

        if (builtInStockChanged) setSetting("built_in_products", JSON.stringify(builtInOverrides));
        database.prepare("INSERT INTO orders (id, created_at, payload) VALUES (?, ?, ?)").run(order.id, order.createdAt, JSON.stringify(order));
        database.prepare("INSERT INTO idempotency_keys (key, order_id, request_hash) VALUES (?, ?, ?)").run(idempotencyKey, order.id, requestHash);
        database.prepare("INSERT INTO order_tracking (order_id, token_hash) VALUES (?, ?)").run(order.id, trackingTokenHash);
        database.prepare("INSERT INTO order_events (order_id, status, message, location, created_at) VALUES (?, ?, ?, ?, ?)")
            .run(order.id, order.status, "Order received by the store.", "", order.createdAt);
        return { order, duplicate: false };
    });
    return save();
}

function updateOrderStatus(orderId, status, message, location) {
    const update = database.transaction(() => {
        const row = database.prepare("SELECT payload FROM orders WHERE id = ?").get(orderId);
        if (!row) return null;
        const order = JSON.parse(row.payload);
        order.status = status;
        if (location) order.location = location;
        database.prepare("UPDATE orders SET payload = ? WHERE id = ?").run(JSON.stringify(order), orderId);
        database.prepare("INSERT INTO order_events (order_id, status, message, location, created_at) VALUES (?, ?, ?, ?, ?)")
            .run(orderId, status, message, location || order.location || "", new Date().toISOString());
        return order;
    });
    return update();
}

function getTrackedOrder(orderId, trackingTokenHash) {
    const row = database.prepare(`
        SELECT orders.payload FROM orders
        JOIN order_tracking ON order_tracking.order_id = orders.id
        WHERE orders.id = ? AND order_tracking.token_hash = ?
    `).get(orderId, trackingTokenHash);
    if (!row) return null;
    const order = JSON.parse(row.payload);
    const events = database.prepare("SELECT status, message, location, created_at AS createdAt FROM order_events WHERE order_id = ? ORDER BY id")
        .all(orderId);
    return { ...order, events };
}

function getOrderEvents(orderId) {
    return database.prepare("SELECT status, message, location, created_at AS createdAt FROM order_events WHERE order_id = ? ORDER BY id")
        .all(orderId);
}

function getCustomerByEmail(email) {
    const row = database.prepare("SELECT payload FROM customers WHERE email = ?").get(String(email).toLowerCase());
    return row ? JSON.parse(row.payload) : null;
}

function saveCustomer(customer) {
    database.prepare("INSERT INTO customers (email, payload) VALUES (?, ?) ON CONFLICT(email) DO UPDATE SET payload = excluded.payload")
        .run(customer.email.toLowerCase(), JSON.stringify(customer));
}

function listCustomerOrders(email) {
    return database.prepare("SELECT payload FROM orders ORDER BY created_at DESC").all()
        .map(row => JSON.parse(row.payload))
        .filter(order => order.customer?.email?.toLowerCase() === String(email).toLowerCase());
}

async function initializeDatabase({ bootstrapOwnerPassword = "", hashPassword, isValidOwnerPassword }) {
    await fs.mkdir(path.dirname(DATABASE_FILE), { recursive: true });
    database = new Database(DATABASE_FILE);
    database.pragma("journal_mode = WAL");
    database.pragma("foreign_keys = ON");
    database.exec(`
        CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS custom_products (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, completed_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS idempotency_keys (key TEXT PRIMARY KEY, order_id TEXT NOT NULL, request_hash TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS order_tracking (order_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS order_events (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT NOT NULL, status TEXT NOT NULL, message TEXT NOT NULL, location TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS customers (email TEXT PRIMARY KEY, payload TEXT NOT NULL);
    `);

    if (!database.prepare("SELECT 1 FROM migrations WHERE name = ?").get("import-store-json")) {
        let oldStore = { orders: [], messages: [], customProducts: [] };
        try {
            oldStore = JSON.parse(await fs.readFile(DATA_FILE, "utf8"));
            oldStore.orders ||= [];
            oldStore.messages ||= [];
            oldStore.customProducts ||= [];
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
        }
        writeStore(oldStore);
        database.prepare("INSERT INTO migrations (name, completed_at) VALUES (?, ?)").run("import-store-json", new Date().toISOString());
    }

    if (!getSetting("owner_password_hash") && bootstrapOwnerPassword) {
        const firstPassword = bootstrapOwnerPassword;
        if (!isValidOwnerPassword(firstPassword)) throw new Error("ADMIN_PASSWORD cannot be empty.");
        const credential = hashPassword(firstPassword);
        setSetting("owner_password_salt", credential.salt);
        setSetting("owner_password_hash", credential.hash);
    }
}

module.exports = { initializeDatabase, readStore, writeStore, getSetting, setSetting, saveOrder, updateOrderStatus, getTrackedOrder, getOrderEvents, getCustomerByEmail, saveCustomer, listCustomerOrders };
