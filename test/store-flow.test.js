const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const crypto = require("node:crypto");
const Database = require("better-sqlite3");

const projectRoot = path.resolve(__dirname, "..");
const password = "TestOwnerPassword2026";
const customer = { name: "Test Buyer", email: "buyer@example.com", address: "10 Test Road", city: "Delhi", pincode: "110001" };
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/0ioAAAAASUVORK5CYII=";

async function freePort() {
    const socket = net.createServer();
    socket.listen(0, "127.0.0.1");
    await once(socket, "listening");
    const port = socket.address().port;
    await new Promise(resolve => socket.close(resolve));
    return port;
}

test("customer checkout and owner APIs enforce auth, CSRF, price, stock, and replay rules", async t => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "fashion-store-test-"));
    const port = await freePort();
    const databasePath = path.join(temp, "store.sqlite");
    const uploadPath = path.join(temp, "uploads");
    const origin = "http://127.0.0.1:" + port;
    const child = spawn(process.execPath, ["server.js"], {
        cwd: projectRoot,
        env: { ...process.env, PORT: String(port), NODE_ENV: "test", APP_ORIGIN: origin, DATABASE_FILE: databasePath, UPLOAD_DIR: uploadPath, ADMIN_PASSWORD: password },
        stdio: ["ignore", "pipe", "pipe"]
    });
    let logs = "";
    child.stdout.on("data", chunk => { logs += chunk.toString(); });
    child.stderr.on("data", chunk => { logs += chunk.toString(); });
    let cookie = "";
    const api = (url, options = {}) => fetch(origin + url, options);
    const owner = (url, options = {}) => api(url, {
        ...options,
        headers: { Origin: origin, ...(options.headers || {}), ...(cookie ? { Cookie: cookie } : {}) }
    });

    t.after(async () => {
        child.kill();
        await Promise.race([once(child, "exit"), new Promise(resolve => setTimeout(resolve, 3000))]);
        await fs.rm(temp, { recursive: true, force: true });
    });

    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
        if (child.exitCode !== null) break;
        try {
            const response = await api("/api/products");
            if (response.ok) { ready = true; break; }
        } catch { /* Server is still starting. */ }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(ready, true, "server did not start: " + logs);

    for (const page of ["/", "/shop.html", "/cart.html", "/checkout.html", "/order-success.html", "/admin.html", "/css/style.css", "/JS/script.js"]) {
        const pageResponse = await api(page);
        assert.equal(pageResponse.status, 200, "missing page or asset: " + page);
    }

    const noSession = await api("/api/admin/products");
    assert.equal(noSession.status, 401);
    const wrongOrigin = await owner("/api/admin/login", { method: "POST", headers: { Origin: "https://attacker.example", "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
    assert.equal(wrongOrigin.status, 403);
    const login = await owner("/api/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
    assert.equal(login.status, 200);
    cookie = login.headers.get("set-cookie").split(";")[0];
    assert.match(login.headers.get("set-cookie"), /HttpOnly/i);
    assert.match(login.headers.get("set-cookie"), /SameSite=Strict/i);

    const adminProducts = await owner("/api/admin/products");
    assert.equal(adminProducts.status, 200);
    const addProduct = await owner("/api/admin/products", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Test Kids Shirt", category: "kids", price: 25, stock: 1, imageData: "data:image/png;base64," + png })
    });
    assert.equal(addProduct.status, 201, addProduct.status === 201 ? "" : await addProduct.text());
    const added = (await addProduct.json()).product;
    assert.equal(added.stock, 1);
    const products = await (await api("/api/products")).json();
    assert.ok(products.products.some(product => product.id === added.id));
    const editProduct = await owner("/api/admin/products/" + added.id, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Updated Test Kids Shirt", category: "kids", price: 25, stock: 1 })
    });
    assert.equal(editProduct.status, 200);

    const orderBody = { customer, payment: "cod", items: [{ productId: added.id, quantity: 1, price: 0.01 }] };
    const key = crypto.randomUUID();
    const trackingToken = crypto.randomBytes(32).toString("hex");
    const place = () => api("/api/orders", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key, "X-Order-Tracking-Token": trackingToken }, body: JSON.stringify(orderBody) });
    const first = await place();
    assert.equal(first.status, 201, first.status === 201 ? "" : await first.text());
    const placed = (await first.json()).order;
    assert.equal(placed.total, 25);
    assert.equal(placed.payment, "cod");
    assert.equal(placed.customer.email, customer.email);
    assert.deepEqual(placed.items, [{ name: "Updated Test Kids Shirt", quantity: 1 }]);
    const replay = await place();
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).order.id, placed.id);
    const exhausted = await api("/api/orders", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID(), "X-Order-Tracking-Token": crypto.randomBytes(32).toString("hex") }, body: JSON.stringify(orderBody) });
    assert.equal(exhausted.status, 409);
    const invalid = await api("/api/orders", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID(), "X-Order-Tracking-Token": crypto.randomBytes(32).toString("hex") }, body: JSON.stringify({ ...orderBody, items: [{ productId: added.id, quantity: 0 }] }) });
    assert.equal(invalid.status, 400);
    const orders = await owner("/api/admin/orders");
    const savedOrders = (await orders.json()).orders;
    assert.equal(savedOrders.length, 1);
    assert.equal(savedOrders[0].events.length, 1);
    const deniedTracking = await api("/api/orders/" + placed.id + "/tracking", { headers: { "X-Order-Tracking-Token": crypto.randomBytes(32).toString("hex") } });
    assert.equal(deniedTracking.status, 404);
    const tracking = () => api("/api/orders/" + placed.id + "/tracking", { headers: { "X-Order-Tracking-Token": trackingToken } });
    assert.equal((await tracking()).status, 200);
    const updateOrder = await owner("/api/admin/orders/" + placed.id, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "Near your location", location: "Test city delivery hub" })
    });
    assert.equal(updateOrder.status, 200);
    let trackingData = await (await tracking()).json();
    assert.equal(trackingData.order.status, "Near your location");
    assert.equal(trackingData.order.events.length, 2);
    const earlyReturn = await api("/api/orders/" + placed.id + "/return", { method: "POST", headers: { "X-Order-Tracking-Token": trackingToken } });
    assert.equal(earlyReturn.status, 409);
    const delivered = await owner("/api/admin/orders/" + placed.id, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "Delivered", location: "Customer address" })
    });
    assert.equal(delivered.status, 200);
    const returnRequest = await api("/api/orders/" + placed.id + "/return", { method: "POST", headers: { "X-Order-Tracking-Token": trackingToken } });
    assert.equal(returnRequest.status, 200);
    trackingData = await (await tracking()).json();
    assert.equal(trackingData.order.status, "Return requested");

    const contact = await api("/api/messages", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: customer.name, email: customer.email, subject: "Test contact", message: "Message from integration test" })
    });
    assert.equal(contact.status, 201);
    const messages = await owner("/api/admin/messages");
    const savedMessages = (await messages.json()).messages;
    assert.equal(savedMessages.length, 1);
    const deleteMessage = await owner("/api/admin/messages/" + savedMessages[0].id, { method: "PATCH" });
    assert.equal(deleteMessage.status, 200);

    const badImage = await owner("/api/admin/products", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Bad Image", category: "kids", price: 10, imageData: "data:image/png;base64,SGVsbG8=" })
    });
    assert.equal(badImage.status, 400);

    const deleteProduct = await owner("/api/admin/products/" + added.id, { method: "DELETE" });
    assert.equal(deleteProduct.status, 200);

    const passwordDb = new Database(databasePath, { readonly: true });
    try {
        const savedHash = passwordDb.prepare("SELECT value FROM settings WHERE key = 'owner_password_hash'").get().value;
        assert.notEqual(savedHash, password);
        assert.equal(savedHash.length, 128);
    } finally { passwordDb.close(); }

    const changePassword = await owner("/api/admin/password", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: password, newPassword: "x" })
    });
    assert.equal(changePassword.status, 200);

    const logout = await owner("/api/admin/logout", { method: "POST" });
    assert.equal(logout.status, 200);
    cookie = "";
    assert.equal((await api("/api/admin/products")).status, 401);
    const shortPasswordLogin = await owner("/api/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "x" }) });
    assert.equal(shortPasswordLogin.status, 200);
    cookie = shortPasswordLogin.headers.get("set-cookie").split(";")[0];
    await owner("/api/admin/logout", { method: "POST" });
    cookie = "";

    for (let attempt = 0; attempt < 5; attempt++) {
        const failed = await owner("/api/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "wrong-password" }) });
        assert.equal(failed.status, 401);
    }
    const limited = await owner("/api/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
    assert.equal(limited.status, 429);
});
