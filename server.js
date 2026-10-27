const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { initializeDatabase, readStore, writeStore, getSetting, setSetting, saveOrder, updateOrderStatus, getTrackedOrder, getOrderEvents, getCustomerByEmail, saveCustomer, listCustomerOrders } = require("./database/db");

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const DATABASE_FILE = path.resolve(ROOT, process.env.DATABASE_FILE || path.join("data", "store.sqlite"));
const DATABASE_DIR = path.dirname(DATABASE_FILE);
const UPLOAD_DIR = path.resolve(ROOT, process.env.UPLOAD_DIR || path.join("images", "uploads"));
const PORT = Number(process.env.PORT) || 3000;
const APP_ORIGIN = process.env.APP_ORIGIN || "";
const BOOTSTRAP_OWNER_PASSWORD = process.env.ADMIN_PASSWORD || "";
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || "";
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || "";
const adminSessions = new Map();
const customerSessions = new Map();
const authFailures = new Map();
const pendingPayments = new Map();
const AUTH_WINDOW_MS = 15 * 60 * 1000;
const AUTH_MAX_ATTEMPTS = 5;

const builtInProducts = [
    { id: "kids-daily-set", name: "Daily Comfort Set", category: "kids", price: 699, image: "images/kids-collection.svg", stock: null },
    { id: "kids-striped", name: "Kids Striped Outfit", category: "kids", price: 899, image: "images/kids-collection.svg", stock: null },
    { id: "kids-party-look", name: "Party Ready Look", category: "kids", price: 999, image: "images/kids-collection.svg", stock: null },
    { id: "kids-summer-set", name: "Summer Play Set", category: "kids", price: 799, image: "images/kids-collection.svg", stock: null }
];

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
    return { salt, hash: crypto.scryptSync(password, salt, 64).toString("hex") };
}

function verifyPassword(password) {
    const salt = getSetting("owner_password_salt");
    const savedHash = getSetting("owner_password_hash");
    if (!salt || !savedHash) return false;
    const submittedHash = crypto.scryptSync(password, salt, 64);
    const expectedHash = Buffer.from(savedHash, "hex");
    return submittedHash.length === expectedHash.length && crypto.timingSafeEqual(submittedHash, expectedHash);
}

function getClientAddress(request) {
    if (process.env.TRUST_PROXY === "1") {
        const forwarded = request.headers["x-forwarded-for"];
        if (typeof forwarded === "string" && forwarded.trim()) return forwarded.split(",")[0].trim();
    }
    return request.socket.remoteAddress || "unknown";
}

function isRateLimited(request) {
    const entry = authFailures.get(getClientAddress(request));
    if (!entry) return false;
    if (Date.now() - entry.windowStartedAt >= AUTH_WINDOW_MS) {
        authFailures.delete(getClientAddress(request));
        return false;
    }
    return entry.failures >= AUTH_MAX_ATTEMPTS;
}

function recordAuthFailure(request) {
    const key = getClientAddress(request);
    const now = Date.now();
    const entry = authFailures.get(key);
    if (!entry || now - entry.windowStartedAt >= AUTH_WINDOW_MS) {
        authFailures.set(key, { failures: 1, windowStartedAt: now });
    } else {
        entry.failures += 1;
    }
    if (authFailures.size > 1000) {
        for (const [address, record] of authFailures) {
            if (now - record.windowStartedAt >= AUTH_WINDOW_MS) authFailures.delete(address);
        }
    }
}

function clearAuthFailures(request) {
    authFailures.delete(getClientAddress(request));
}

function sendRateLimited(response) {
    response.setHeader("Retry-After", String(Math.ceil(AUTH_WINDOW_MS / 1000)));
    return sendJson(response, 429, { error: "Too many sign-in attempts. Try again in 15 minutes." });
}

function isSameOriginRequest(request) {
    const rawOrigin = request.headers.origin || request.headers.referer;
    if (!rawOrigin || !request.headers.host) return false;
    try {
        const supplied = new URL(rawOrigin);
        const expected = APP_ORIGIN ? new URL(APP_ORIGIN) : new URL(`${request.socket.encrypted ? "https" : "http"}://${request.headers.host}`);
        return supplied.origin === expected.origin;
    } catch { return false; }
}

function setAdminCookie(response, request, sessionId) {
    const secure = process.env.NODE_ENV === "production" || Boolean(APP_ORIGIN.startsWith("https://"));
    response.setHeader("Set-Cookie", `fashion_admin=${sessionId}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secure ? "; Secure" : ""}`);
}

function setCustomerCookie(response, sessionId, clear = false) {
    const secure = process.env.NODE_ENV === "production" || Boolean(APP_ORIGIN.startsWith("https://"));
    response.setHeader("Set-Cookie", `mamta_customer=${clear ? "" : sessionId}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${clear ? 0 : 2592000}${secure ? "; Secure" : ""}`);
}

function createCustomerSession(response, customer) {
    const sessionId = crypto.randomBytes(32).toString("hex");
    customerSessions.set(sessionId, { email: customer.email, expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000 });
    setCustomerCookie(response, sessionId);
}

function getCustomer(request) {
    const cookie = request.headers.cookie || "";
    const entry = cookie.split(";").map(part => part.trim()).find(part => part.startsWith("mamta_customer="));
    const sessionId = entry ? decodeURIComponent(entry.slice("mamta_customer=".length)) : "";
    const session = customerSessions.get(sessionId);
    if (!session || session.expiresAt < Date.now()) {
        customerSessions.delete(sessionId);
        return null;
    }
    return getCustomerByEmail(session.email);
}

function publicCustomer(customer) {
    if (!customer) return null;
    const { passwordHash, passwordSalt, ...safe } = customer;
    return safe;
}

function createAdminSession(response, request) {
    const sessionId = crypto.randomBytes(32).toString("hex");
    adminSessions.set(sessionId, Date.now() + 8 * 60 * 60 * 1000);
    setAdminCookie(response, request, sessionId);
}

function sendJson(response, status, body) {
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    response.end(JSON.stringify(body));
}

async function validateCartItems(rawItems) {
    const catalog = await getProducts();
    if (!Array.isArray(rawItems) || rawItems.length === 0 || rawItems.length > Math.min(catalog.length, 50)) return { error: "Your cart is empty or invalid." };
    const items = [];
    for (const item of rawItems) {
        if (!item || typeof item !== "object" || typeof item.productId !== "string") return { error: "Your cart contains an invalid product." };
        const product = catalog.find(entry => entry.id === item.productId);
        const quantity = item.quantity;
        if (!product || !Number.isInteger(quantity) || quantity < 1 || quantity > 99) return { error: "Your cart contains an invalid product or quantity." };
        const existing = items.find(entry => entry.productId === product.id);
        if (existing) {
            existing.quantity += quantity;
            if (existing.quantity > 99) return { error: "Maximum quantity per product is 99." };
        } else items.push({ productId: product.id, name: product.name, price: product.price, image: product.image, quantity });
    }
    return { items, total: items.reduce((sum, item) => sum + item.price * item.quantity, 0) };
}

async function createRazorpayOrder(amount, receipt) {
    const credentials = Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString("base64");
    const response = await fetch("https://api.razorpay.com/v1/orders", {
        method: "POST",
        headers: { Authorization: `Basic ${credentials}`, "Content-Type": "application/json" },
        body: JSON.stringify({ amount, currency: "INR", receipt, payment_capture: 1 })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.id) throw new Error(result.error?.description || "Could not start online payment.");
    return result;
}

function verifyRazorpaySignature(orderId, paymentId, signature) {
    const expected = crypto.createHmac("sha256", RAZORPAY_KEY_SECRET).update(`${orderId}|${paymentId}`).digest("hex");
    const actual = Buffer.from(signature || "", "utf8");
    const expectedBuffer = Buffer.from(expected, "utf8");
    return actual.length === expectedBuffer.length && crypto.timingSafeEqual(actual, expectedBuffer);
}

async function readBody(request, maxBytes = 1_000_000) {
    let body = "";
    for await (const chunk of request) {
        body += chunk;
        if (body.length > maxBytes) throw Object.assign(new Error("Request is too large."), { status: 413 });
    }
    try { return JSON.parse(body || "{}"); }
    catch { throw Object.assign(new Error("Request body must be valid JSON."), { status: 400 }); }
}

async function getProducts() {
    const store = await readStore();
    let builtInOverrides = {};
    try { builtInOverrides = JSON.parse(getSetting("built_in_products") || "{}"); }
    catch { builtInOverrides = {}; }
    const editableBuiltIns = builtInProducts.map(product => ({
        ...product,
        ...(builtInOverrides[product.id] || {})
    }));
    return [...editableBuiltIns, ...store.customProducts].filter(product => product.category === "kids");
}

function getSessionId(request) {
    const cookie = request.headers.cookie || "";
    const entry = cookie.split(";").map(part => part.trim()).find(part => part.startsWith("fashion_admin="));
    return entry ? decodeURIComponent(entry.slice("fashion_admin=".length)) : "";
}

function isAdmin(request) {
    const sessionId = getSessionId(request);
    const expiresAt = adminSessions.get(sessionId);
    if (!expiresAt || expiresAt < Date.now()) {
        adminSessions.delete(sessionId);
        return false;
    }
    return true;
}

function requireAdmin(request, response) {
    if (isAdmin(request)) return true;
    sendJson(response, 401, { error: "Owner sign-in required." });
    return false;
}

function parseImageData(dataUrl) {
    if (typeof dataUrl !== "string") return null;
    const match = dataUrl.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (!match) return null;
    const buffer = Buffer.from(match[2], "base64");
    if (!buffer.length || buffer.length > 5 * 1024 * 1024) return null;
    const type = match[1];
    const valid = type === "image/jpeg"
        ? buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
        : type === "image/png"
            ? buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
            : buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP";
    if (!valid) return null;
    const extension = type === "image/jpeg" ? ".jpg" : type === "image/png" ? ".png" : ".webp";
    return { buffer, extension };
}

function cleanText(value, maxLength) {
    return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function isValidOwnerPassword(password) {
    return typeof password === "string" && password.length > 0;
}

async function handleApi(request, response, pathname) {
    if (pathname.startsWith("/api/admin/") && !["GET", "HEAD", "OPTIONS"].includes(request.method) && !isSameOriginRequest(request)) {
        return sendJson(response, 403, { error: "This admin request must come from the same site." });
    }

    if (request.method === "GET" && pathname === "/api/products") {
        return sendJson(response, 200, { products: await getProducts() });
    }

    if (request.method === "GET" && pathname === "/api/customer/session") {
        const customer = getCustomer(request);
        return sendJson(response, 200, { authenticated: Boolean(customer), customer: publicCustomer(customer) });
    }

    if (request.method === "POST" && pathname === "/api/customer/signup") {
        const body = await readBody(request);
        const name = cleanText(body.name, 100);
        const email = cleanText(body.email, 200).toLowerCase();
        const phone = cleanText(body.phone, 30);
        const password = typeof body.password === "string" ? body.password : "";
        if (!name || !/^\S+@\S+\.\S+$/.test(email) || password.length < 6) return sendJson(response, 400, { error: "Name, valid email, and a password of at least 6 characters are required." });
        if (getCustomerByEmail(email)) return sendJson(response, 409, { error: "An account with this email already exists. Please sign in." });
        const credential = hashPassword(password);
        const customer = { id: `customer-${crypto.randomUUID()}`, name, email, phone, passwordSalt: credential.salt, passwordHash: credential.hash, createdAt: new Date().toISOString() };
        saveCustomer(customer);
        createCustomerSession(response, customer);
        return sendJson(response, 201, { customer: publicCustomer(customer) });
    }

    if (request.method === "POST" && pathname === "/api/customer/login") {
        const body = await readBody(request);
        const email = cleanText(body.email, 200).toLowerCase();
        const password = typeof body.password === "string" ? body.password : "";
        const customer = getCustomerByEmail(email);
        if (!customer || !crypto.timingSafeEqual(Buffer.from(hashPassword(password, customer.passwordSalt).hash, "hex"), Buffer.from(customer.passwordHash, "hex"))) return sendJson(response, 401, { error: "Email or password is incorrect." });
        createCustomerSession(response, customer);
        return sendJson(response, 200, { customer: publicCustomer(customer) });
    }

    if (request.method === "POST" && pathname === "/api/customer/logout") {
        const cookie = request.headers.cookie || "";
        const entry = cookie.split(";").map(part => part.trim()).find(part => part.startsWith("mamta_customer="));
        if (entry) customerSessions.delete(decodeURIComponent(entry.slice("mamta_customer=".length)));
        setCustomerCookie(response, "", true);
        return sendJson(response, 200, { message: "Signed out." });
    }

    if (request.method === "GET" && pathname === "/api/customer/orders") {
        const customer = getCustomer(request);
        if (!customer) return sendJson(response, 401, { error: "Customer sign-in required." });
        return sendJson(response, 200, { orders: listCustomerOrders(customer.email) });
    }

    const trackingMatch = pathname.match(/^\/api\/orders\/([0-9a-f-]{36})\/(tracking|return)$/i);
    if (trackingMatch && ["GET", "POST"].includes(request.method)) {
        const token = request.headers["x-order-tracking-token"] || "";
        if (!/^[0-9a-f]{64}$/i.test(token)) return sendJson(response, 401, { error: "Valid order tracking access is required." });
        const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
        const trackedOrder = getTrackedOrder(trackingMatch[1], tokenHash);
        if (!trackedOrder) return sendJson(response, 404, { error: "Order tracking details could not be found." });
        if (request.method === "GET" && trackingMatch[2] === "tracking") {
            return sendJson(response, 200, {
                order: {
                    id: trackedOrder.id, createdAt: trackedOrder.createdAt, status: trackedOrder.status,
                    location: trackedOrder.location || "", customer: trackedOrder.customer,
                    payment: trackedOrder.payment, items: trackedOrder.items.map(({ name, quantity }) => ({ name, quantity })),
                    total: trackedOrder.total, events: trackedOrder.events
                }
            });
        }
        if (request.method === "POST" && trackingMatch[2] === "return") {
            if (trackedOrder.status !== "Delivered") return sendJson(response, 409, { error: "A return can be requested after the order is delivered." });
            const updated = updateOrderStatus(trackedOrder.id, "Return requested", "Customer requested a return.", trackedOrder.location || "");
            return sendJson(response, 200, { message: "Return request received.", status: updated.status });
        }
    }

    if (request.method === "GET" && pathname === "/api/admin/session") {
        return sendJson(response, 200, {
            authenticated: isAdmin(request),
            configured: Boolean(getSetting("owner_password_hash"))
        });
    }

    if (request.method === "POST" && pathname === "/api/admin/setup") {
        if (getSetting("owner_password_hash")) return sendJson(response, 409, { error: "Owner password is already set. Sign in instead." });
        if (isRateLimited(request)) return sendRateLimited(response);
        const body = await readBody(request);
        const password = typeof body.password === "string" ? body.password : "";
        if (!isValidOwnerPassword(password)) {
            recordAuthFailure(request);
            return sendJson(response, 400, { error: "Password cannot be empty." });
        }
        const credential = hashPassword(password);
        setSetting("owner_password_salt", credential.salt);
        setSetting("owner_password_hash", credential.hash);
        clearAuthFailures(request);
        createAdminSession(response, request);
        return sendJson(response, 201, { message: "Owner password created. Keep it private; it cannot be recovered from the database." });
    }

    if (request.method === "POST" && pathname === "/api/admin/login") {
        if (!getSetting("owner_password_hash")) return sendJson(response, 503, { error: "Owner password is not set. Stop the server, set ADMIN_PASSWORD once, and restart it. The password hash will be saved in the database." });
        if (isRateLimited(request)) return sendRateLimited(response);
        const body = await readBody(request);
        const supplied = Buffer.from(typeof body.password === "string" ? body.password : "");
        if (!verifyPassword(supplied.toString("utf8"))) {
            recordAuthFailure(request);
            return sendJson(response, 401, { error: "Incorrect owner password." });
        }
        clearAuthFailures(request);
        createAdminSession(response, request);
        return sendJson(response, 200, { message: "Owner signed in." });
    }

    if (request.method === "POST" && pathname === "/api/admin/logout") {
        adminSessions.delete(getSessionId(request));
        const secure = process.env.NODE_ENV === "production" || Boolean(APP_ORIGIN.startsWith("https://"));
        response.setHeader("Set-Cookie", `fashion_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? "; Secure" : ""}`);
        return sendJson(response, 200, { message: "Signed out." });
    }

    if (pathname.startsWith("/api/admin/") && !requireAdmin(request, response)) return;

    if (request.method === "POST" && pathname === "/api/admin/password") {
        const body = await readBody(request);
        const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
        const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";
        if (!verifyPassword(currentPassword)) return sendJson(response, 401, { error: "Current password is incorrect." });
        if (!isValidOwnerPassword(newPassword)) return sendJson(response, 400, { error: "Password cannot be empty." });
        const credential = hashPassword(newPassword);
        setSetting("owner_password_salt", credential.salt);
        setSetting("owner_password_hash", credential.hash);
        adminSessions.clear();
        createAdminSession(response, request);
        return sendJson(response, 200, { message: "Owner password changed and saved in the database." });
    }

    if (request.method === "GET" && pathname === "/api/admin/products") {
        return sendJson(response, 200, { products: await getProducts() });
    }

    if (request.method === "GET" && pathname === "/api/admin/orders") {
        const store = await readStore();
        return sendJson(response, 200, { orders: store.orders.slice().reverse().map(order => ({ ...order, events: getOrderEvents(order.id) })) });
    }

    if (request.method === "GET" && pathname === "/api/admin/messages") {
        const store = await readStore();
        return sendJson(response, 200, { messages: store.messages.slice().reverse() });
    }

    if (request.method === "PATCH" && pathname.startsWith("/api/admin/orders/")) {
        const orderId = decodeURIComponent(pathname.slice("/api/admin/orders/".length));
        const body = await readBody(request);
        const status = cleanText(body.status, 20);
        const allowedStatuses = ["Pending", "Confirmed", "Processing", "Shipped", "Out for delivery", "Near your location", "Delivered", "Return requested", "Return approved", "Return picked up", "Returned", "Cancelled"];
        if (!allowedStatuses.includes(status)) return sendJson(response, 400, { error: "Choose a valid order status." });
        const bodyLocation = cleanText(body.location, 180);
        const bodyMessage = cleanText(body.message, 240);
        const eventMessage = bodyMessage || `Order status changed to ${status}.`;
        const order = updateOrderStatus(orderId, status, eventMessage, bodyLocation);
        if (!order) return sendJson(response, 404, { error: "Order not found." });
        return sendJson(response, 200, { message: "Order status updated.", order });
    }

    if (request.method === "PATCH" && pathname.startsWith("/api/admin/messages/")) {
        const messageId = decodeURIComponent(pathname.slice("/api/admin/messages/".length));
        const store = await readStore();
        const index = store.messages.findIndex(entry => entry.id === messageId);
        if (index < 0) return sendJson(response, 404, { error: "Message not found." });
        store.messages.splice(index, 1);
        await writeStore(store);
        return sendJson(response, 200, { message: "Contact message deleted." });
    }

    if (request.method === "POST" && pathname === "/api/admin/products") {
        const body = await readBody(request, 8_000_000);
        const name = cleanText(body.name, 100);
        const category = cleanText(body.category, 20);
        const price = Number(body.price);
        const stock = body.stock === "" || body.stock == null ? null : Number(body.stock);
        const imageDataList = Array.isArray(body.imageData) ? body.imageData : (body.imageData ? [body.imageData] : []);
        const images = imageDataList.map(parseImageData).filter(Boolean);
        if (!name || category !== "kids" || !Number.isFinite(price) || price <= 0 || price > 1_000_000 || (stock !== null && (!Number.isInteger(stock) || stock < 0 || stock > 1_000_000)) || !images.length || images.length > 2) {
            return sendJson(response, 400, { error: "Enter a kids product name, price, and upload a JPEG, PNG, or WebP image up to 5 MB." });
        }
        const id = `custom-${crypto.randomUUID()}`;
        await fs.mkdir(UPLOAD_DIR, { recursive: true });
        const imagePaths = [];
        for (const image of images) {
            const filename = `${id}-${crypto.randomUUID()}${image.extension}`;
            await fs.writeFile(path.join(UPLOAD_DIR, filename), image.buffer, { flag: "wx" });
            imagePaths.push(`images/uploads/${filename}`);
        }
        const product = { id, name, category, price: Math.round(price * 100) / 100, stock, image: imagePaths[0], images: imagePaths, description: cleanText(body.description, 2000), sizes: cleanText(body.sizes, 200), color: cleanText(body.color, 80), ownerAdded: true };
        const store = await readStore();
        store.customProducts.push(product);
        await writeStore(store);
        return sendJson(response, 201, { message: "Product added.", product });
    }

    const updateMatch = pathname.match(/^\/api\/admin\/products\/([a-z0-9-]+)$/i);
    if (request.method === "PUT" && updateMatch) {
        const body = await readBody(request, 8_000_000);
        const name = cleanText(body.name, 100);
        const category = cleanText(body.category, 20);
        const price = Number(body.price);
        const stock = body.stock === "" || body.stock == null ? null : Number(body.stock);
        const imageDataList = Array.isArray(body.imageData) ? body.imageData : (body.imageData ? [body.imageData] : []);
        const images = imageDataList.map(parseImageData).filter(Boolean);
        if (!name || category !== "kids" || !Number.isFinite(price) || price <= 0 || price > 1_000_000 || (stock !== null && (!Number.isInteger(stock) || stock < 0 || stock > 1_000_000)) || (imageDataList.length && (!images.length || images.length > 2))) {
            return sendJson(response, 400, { error: "Enter a kids product name, price, and choose a JPEG, PNG, or WebP image up to 5 MB." });
        }
        const id = updateMatch[1];
        const store = await readStore();
        const product = store.customProducts.find(entry => entry.id === id);
        const isBuiltIn = builtInProducts.some(entry => entry.id === id);
        if (!product && !isBuiltIn) return sendJson(response, 404, { error: "Product not found." });
        let builtInOverrides = {};
        if (isBuiltIn) {
            try { builtInOverrides = JSON.parse(getSetting("built_in_products") || "{}"); }
            catch { builtInOverrides = {}; }
        }
        const oldImage = product?.image || builtInOverrides[id]?.image;
        const updatedFields = { name, category, price: Math.round(price * 100) / 100, stock, description: cleanText(body.description, 2000), sizes: cleanText(body.sizes, 200), color: cleanText(body.color, 80) };
        if (product) Object.assign(product, updatedFields);
        else builtInOverrides[id] = { ...(builtInOverrides[id] || {}), ...updatedFields };
        if (images.length) {
            const imagePaths = [];
            for (const image of images) {
                const filename = `${id}-${crypto.randomUUID()}${image.extension}`;
                await fs.mkdir(UPLOAD_DIR, { recursive: true });
                await fs.writeFile(path.join(UPLOAD_DIR, filename), image.buffer, { flag: "wx" });
                imagePaths.push(`images/uploads/${filename}`);
            }
            if (product) { product.image = imagePaths[0]; product.images = imagePaths; }
            else { builtInOverrides[id].image = imagePaths[0]; builtInOverrides[id].images = imagePaths; }
        }
        await writeStore(store);
        if (isBuiltIn) setSetting("built_in_products", JSON.stringify(builtInOverrides));
        if (images.length && oldImage) {
            const oldPath = path.resolve(ROOT, oldImage);
            if (oldPath.startsWith(UPLOAD_DIR + path.sep)) await fs.rm(oldPath, { force: true });
        }
        const updatedProduct = product || { ...builtInProducts.find(entry => entry.id === id), ...builtInOverrides[id] };
        return sendJson(response, 200, { message: "Product updated.", product: updatedProduct });
    }

    const deleteMatch = pathname.match(/^\/api\/admin\/products\/(custom-[a-f0-9-]+)$/i);
    if (request.method === "DELETE" && deleteMatch) {
        const store = await readStore();
        const index = store.customProducts.findIndex(product => product.id === deleteMatch[1]);
        if (index < 0) return sendJson(response, 404, { error: "Owner-added product not found." });
        const [product] = store.customProducts.splice(index, 1);
        await writeStore(store);
        const imagePath = path.resolve(ROOT, product.image);
        if (imagePath.startsWith(UPLOAD_DIR + path.sep)) await fs.rm(imagePath, { force: true });
        return sendJson(response, 200, { message: "Product deleted." });
    }

    if (request.method === "GET" && pathname === "/api/payments/razorpay/config") {
        return sendJson(response, 200, { enabled: Boolean(RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET), keyId: RAZORPAY_KEY_ID || null });
    }

    if (request.method === "POST" && pathname === "/api/payments/razorpay/order") {
        if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) return sendJson(response, 503, { error: "Online payment is not configured yet. Please choose Cash on Delivery." });
        const body = await readBody(request);
        const cart = await validateCartItems(body.items);
        if (cart.error) return sendJson(response, 400, { error: cart.error });
        const amount = Math.round(cart.total * 100);
        try {
            const razorpayOrder = await createRazorpayOrder(amount, `mamta-${crypto.randomUUID().slice(0, 8)}`);
            pendingPayments.set(razorpayOrder.id, { amount, expiresAt: Date.now() + 15 * 60 * 1000 });
            return sendJson(response, 200, { keyId: RAZORPAY_KEY_ID, orderId: razorpayOrder.id, amount, currency: "INR" });
        } catch (error) {
            return sendJson(response, 502, { error: error.message || "Could not start online payment." });
        }
    }

    if (request.method === "POST" && pathname === "/api/orders") {
        const body = await readBody(request);
        const customer = body.customer || {};
        const name = cleanText(customer.name, 120);
        const email = cleanText(customer.email, 200);
        const address = cleanText(customer.address, 300);
        const city = cleanText(customer.city, 120);
        const pincode = cleanText(customer.pincode, 20);
        const payment = cleanText(body.payment, 20);
        if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !address || !city || !pincode) {
            return sendJson(response, 400, { error: "Enter valid customer and delivery details." });
        }
        if (!["cod", "upi_qr"].includes(payment)) return sendJson(response, 400, { error: "Select a valid payment method." });
        const idempotencyKey = cleanText(request.headers["idempotency-key"], 80);
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idempotencyKey)) {
            return sendJson(response, 400, { error: "Refresh checkout and submit the order again." });
        }
        const trackingToken = cleanText(request.headers["x-order-tracking-token"], 80);
        if (!/^[0-9a-f]{64}$/i.test(trackingToken)) return sendJson(response, 400, { error: "Order tracking could not be started. Refresh checkout and try again." });
        const cart = await validateCartItems(body.items);
        if (cart.error) return sendJson(response, 400, { error: cart.error });
        const { items, total } = cart;
        let paymentDetails = null;
        if (payment === "upi_qr") {
            paymentDetails = { method: "UPI QR", status: "Verification pending", reference: cleanText(body.paymentDetails?.reference, 100) };
        }

        const normalizedCustomer = { name, email, address, city, pincode };
        const requestHash = crypto.createHash("sha256").update(JSON.stringify({ customer: normalizedCustomer, payment, items: items.map(({ productId, quantity }) => ({ productId, quantity })) })).digest("hex");
        const order = {
            id: crypto.randomUUID(),
            createdAt: new Date().toISOString(),
            status: "Pending",
            customer: normalizedCustomer,
            payment,
            ...(paymentDetails ? { paymentDetails } : {}),
            items,
            total
        };
        const trackingTokenHash = crypto.createHash("sha256").update(trackingToken).digest("hex");
        const saved = saveOrder(order, idempotencyKey, requestHash, builtInProducts.map(product => product.id), trackingTokenHash);
        return sendJson(response, saved.duplicate ? 200 : 201, {
            message: saved.duplicate ? "Order was already placed." : "Order placed successfully.",
            order: {
                id: saved.order.id,
                trackingToken,
                createdAt: saved.order.createdAt,
                status: saved.order.status,
                customer: saved.order.customer,
                payment: saved.order.payment,
                items: saved.order.items.map(({ name, quantity }) => ({ name, quantity })),
                total: saved.order.total
            }
        });
    }

    if (request.method === "POST" && pathname === "/api/messages") {
        const body = await readBody(request);
        const message = {
            id: crypto.randomUUID(),
            createdAt: new Date().toISOString(),
            name: cleanText(body.name, 120),
            email: cleanText(body.email, 200),
            subject: cleanText(body.subject, 200),
            message: cleanText(body.message, 3000)
        };
        if (!message.name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(message.email) || !message.subject || !message.message) {
            return sendJson(response, 400, { error: "Complete all contact fields with a valid email." });
        }
        const store = await readStore();
        store.messages.push(message);
        await writeStore(store);
        return sendJson(response, 201, { message: "Your message has been received." });
    }

    return sendJson(response, 404, { error: "API route not found." });
}

const mimeTypes = {
    ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml"
};

async function serveFile(response, pathname) {
    const requested = pathname === "/" ? "/index.html" : decodeURIComponent(pathname);
    const uploadsUrlPrefix = "/images/uploads/";
    let filePath;
    if (requested.startsWith(uploadsUrlPrefix)) {
        const filename = requested.slice(uploadsUrlPrefix.length);
        if (!/^[a-z0-9-]+\.(?:jpg|png|webp)$/i.test(filename)) {
            response.writeHead(404); response.end("Not found"); return;
        }
        filePath = path.resolve(UPLOAD_DIR, filename);
    } else {
        filePath = path.resolve(ROOT, `.${requested}`);
    }
    if (filePath === DATA_DIR || filePath.startsWith(DATA_DIR + path.sep)
        || (DATABASE_DIR !== ROOT && (filePath === DATABASE_DIR || filePath.startsWith(DATABASE_DIR + path.sep)))
        || [DATABASE_FILE, `${DATABASE_FILE}-wal`, `${DATABASE_FILE}-shm`].includes(filePath)
        || ["server.js", "package.json"].includes(path.basename(filePath))) {
        response.writeHead(404); response.end("Not found"); return;
    }
    if (!filePath.startsWith(ROOT + path.sep) && !filePath.startsWith(UPLOAD_DIR + path.sep)) {
        response.writeHead(403); response.end("Forbidden"); return;
    }
    try {
        const content = await fs.readFile(filePath);
        response.writeHead(200, { "Content-Type": mimeTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream" });
        response.end(content);
    } catch (error) {
        if (error.code === "ENOENT" || error.code === "EISDIR") {
            response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); response.end("Not found");
        } else throw error;
    }
}

const server = http.createServer(async (request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    response.setHeader("X-Frame-Options", "DENY");
    if (process.env.NODE_ENV === "production") response.setHeader("Strict-Transport-Security", "max-age=31536000");
    try {
        const pathname = new URL(request.url, "http://localhost").pathname;
        if (pathname.startsWith("/api/")) await handleApi(request, response, pathname);
        else if (request.method === "GET" || request.method === "HEAD") await serveFile(response, pathname);
        else { response.writeHead(405); response.end("Method not allowed"); }
    } catch (error) {
        sendJson(response, error.status || 500, { error: error.status ? error.message : "The server could not complete the request." });
        if (!error.status) console.error(error);
    }
});

server.on("error", error => {
    if (error.code === "EADDRINUSE") {
        console.error(`Port ${PORT} is already in use. If this store is already running, open http://localhost:${PORT}; otherwise stop the other process and start again.`);
        return;
    }
    console.error("The Fashion Store server could not start:", error);
});

initializeDatabase({
    bootstrapOwnerPassword: BOOTSTRAP_OWNER_PASSWORD,
    hashPassword,
    isValidOwnerPassword
}).then(() => {
    server.listen(PORT, "0.0.0.0", () => console.log(`Fashion Store running at http://localhost:${PORT}`));
}).catch(error => {
    console.error("Could not initialize the Fashion Store database:", error);
    process.exit(1);
});
