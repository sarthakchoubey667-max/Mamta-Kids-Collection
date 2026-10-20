
 // ===============================
 // SHOP PAGE
 // ===============================

const allBtn = document.getElementById("allBtn");
const womenBtn = document.getElementById("womenBtn");
const menBtn = document.getElementById("menBtn");
const kidsBtn = document.getElementById("kidsBtn");

let products = Array.from(document.querySelectorAll(".product-card"));
const API_BASE = "";
const demoCatalog = [
    { id: "kids-daily-set", name: "Daily Comfort Set", category: "kids", price: 699, image: "images/kids-collection.svg", stock: null },
    { id: "kids-striped", name: "Kids Striped Outfit", category: "kids", price: 899, image: "images/kids-collection.svg", stock: null },
    { id: "kids-party-look", name: "Party Ready Look", category: "kids", price: 999, image: "images/kids-collection.svg", stock: null },
    { id: "kids-summer-set", name: "Summer Play Set", category: "kids", price: 799, image: "images/kids-collection.svg", stock: null }
];

async function apiRequest(path, options) {
    const { headers = {}, ...requestOptions } = options || {};
    try {
        const response = await fetch(API_BASE + path, {
            ...requestOptions,
            headers: { "Content-Type": "application/json", ...headers }
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "The request failed.");
        return result;
    } catch (error) {
        // The hosted static build keeps browsing and demo checkout usable without the local Node API.
        if (path === "/api/products") return { products: demoCatalog };
        if (path === "/api/orders" && requestOptions.method === "POST") {
            const body = JSON.parse(requestOptions.body || "{}");
            const byId = new Map(demoCatalog.map(product => [product.id, product]));
            const items = (body.items || []).map(item => {
                const product = byId.get(item.productId) || item;
                return { name: product.name, quantity: Number(item.quantity) || 1, price: Number(product.price) || 0 };
            });
            const order = {
                id: `LUME-${Date.now().toString(36).toUpperCase()}`,
                createdAt: new Date().toISOString(),
                customer: body.customer || {},
                payment: body.payment || "cod",
                status: "Confirmed",
                items,
                total: items.reduce((sum, item) => sum + item.price * item.quantity, 0)
            };
            return { order };
        }
        throw error;
    }
}

let selectedCategory = "all";

function setSelectedCategory(category) {
    selectedCategory = category;
    document.querySelectorAll(".category-options button").forEach(button => {
        button.classList.toggle("active", button.id === `${category}Btn`);
    });
}

function ensureGlobalSearch() {
    let container = document.getElementById("searchContainer");
    if (!container) {
        container = document.createElement("section");
        container.className = "search-container";
        container.id = "searchContainer";
        container.innerHTML = `
            <div class="search-top">
                <input type="search" id="searchInput" placeholder="Search products..." aria-label="Search products">
                <button type="button" id="searchBtn">Search</button>
                <button type="button" id="closeSearchBtn" aria-label="Close search">Close</button>
            </div>
            <div id="searchResults" aria-live="polite"></div>
            <p id="noProductsMsg" class="search-empty" style="display:none">No products found. Try another search.</p>`;
        document.body.appendChild(container);
    } else if (!container.querySelector("#closeSearchBtn")) {
        const closeButton = document.createElement("button");
        closeButton.type = "button";
        closeButton.id = "closeSearchBtn";
        closeButton.textContent = "Close";
        closeButton.setAttribute("aria-label", "Close search");
        container.querySelector(".search-top")?.appendChild(closeButton);
    }
    if (!document.getElementById("noProductsMsg")) {
        const noProducts = document.createElement("p");
        noProducts.id = "noProductsMsg";
        noProducts.className = "search-empty";
        noProducts.textContent = "No products found. Try another search.";
        noProducts.style.display = "none";
        container.appendChild(noProducts);
    }
    return {
        container,
        input: document.getElementById("searchInput"),
        button: document.getElementById("searchBtn"),
        results: document.getElementById("searchResults")
    };
}

const globalSearch = ensureGlobalSearch();

async function loadOwnerProducts() {
    const productList = document.getElementById("productList");
    if (!productList) return;
    try {
        const result = await apiRequest("/api/products");
        productList.replaceChildren();
        result.products.forEach(product => {
            const card = document.createElement("article");
            card.className = `product-card ${product.category}`;
            card.dataset.productId = product.id;
            const imageBox = document.createElement("div");
            imageBox.className = "product-image";
            const image = document.createElement("img");
            image.src = product.image;
            image.alt = product.name;
            image.loading = "lazy";
            imageBox.appendChild(image);
            const title = document.createElement("h3");
            title.textContent = product.name;
            const price = document.createElement("p");
            price.textContent = `₹${Number(product.price).toFixed(2)}`;
            const addButton = document.createElement("button");
            addButton.type = "button";
            addButton.className = "add-cart";
            addButton.dataset.productId = product.id;
            addButton.dataset.name = product.name;
            addButton.dataset.price = product.price;
            addButton.dataset.image = product.image;
            addButton.textContent = "Add to Cart";
            card.append(imageBox, title, price, addButton);
            productList.appendChild(card);
        });
        products = Array.from(document.querySelectorAll(".product-card"));
        const status = document.getElementById("productLoadStatus");
        if (status) status.textContent = `${products.length} styles available`;
        const requestedCategory = new URLSearchParams(window.location.search).get("category");
        if (["men", "women", "kids"].includes(requestedCategory)) {
            selectedCategory = requestedCategory;
            const activeButton = document.getElementById(`${requestedCategory}Btn`);
            document.querySelectorAll(".category-options button").forEach(button => button.classList.toggle("active", button === activeButton));
        }
        filterProducts();
        if (globalSearch.input.value.trim()) {
            const matches = filterProducts();
            if (initialSearch && matches > 0) {
                globalSearch.container.style.display = "none";
                productList.scrollIntoView({ behavior: "smooth", block: "start" });
            } else if (initialSearch && matches === 0) {
                globalSearch.container.style.display = "flex";
                showSuggestions();
            }
        }
    } catch (error) {
        console.error("Could not load owner-added products:", error);
        const status = document.getElementById("productLoadStatus");
        if (status) status.textContent = "The shop could not load. Please refresh when the store server is running.";
    }
}

loadOwnerProducts();


// ===============================
// SEARCH + CATEGORY FILTER
// ===============================

function filterProducts() {
    const searchText = globalSearch.input
        ? globalSearch.input.value.toLowerCase().trim()
        : "";

    let visibleCount = 0;

    products.forEach(function (product) {
        const heading = product.querySelector("h3");

        const productName = heading
            ? heading.textContent.toLowerCase().trim()
            : "";

        const matchesSearch = productName.includes(searchText);

        const matchesCategory =
            selectedCategory === "all" ||
            product.classList.contains(selectedCategory);

        if (matchesSearch && matchesCategory) {
            product.style.display = "";
            visibleCount++;
        } else {
            product.style.display = "none";
        }
    });

    const kidsEmptyState = document.getElementById("kidsEmptyState");
    if (kidsEmptyState) {
        const hasKidsStyles = products.some(product => product.classList.contains("kids"));
        kidsEmptyState.hidden = selectedCategory !== "kids" || hasKidsStyles || Boolean(searchText);
    }

    const noProductsMsg = document.getElementById("noProductsMsg");
    if (noProductsMsg && products.length) {
        noProductsMsg.textContent = "No products found. Try another search.";
        noProductsMsg.style.display = visibleCount === 0 ? "block" : "none";
    }
    return visibleCount;
}


// ===============================
// SEARCH SUGGESTIONS
// ===============================

function showSuggestions() {
    const input = globalSearch.input;
    const results = globalSearch.results;
    if (!input || !results) return 0;

    const searchText = input.value.toLowerCase().trim();

    results.innerHTML = "";

    if (searchText === "") {
        results.style.display = "none";
        const noProducts = document.getElementById("noProductsMsg");
        if (noProducts) noProducts.style.display = "none";
        return 0;
    }

    let suggestionCount = 0;

    products.forEach(function (product) {
        const heading = product.querySelector("h3");

        if (!heading) return;

        const productName = heading.textContent.trim();
        const productNameLower = productName.toLowerCase();

        const matchesSearch = productNameLower.includes(searchText);

        const matchesCategory =
            selectedCategory === "all" ||
            product.classList.contains(selectedCategory);

        if (matchesSearch && matchesCategory) {
            const suggestion = document.createElement("button");
            const image = product.querySelector(".product-image img");
            const thumbnail = document.createElement("img");
            const details = document.createElement("span");

            suggestion.type = "button";
            suggestion.className = "search-suggestion";
            thumbnail.src = image ? image.getAttribute("src") : "";
            thumbnail.alt = "";
            thumbnail.loading = "lazy";
            details.textContent = productName;
            suggestion.append(thumbnail, details);

            suggestion.addEventListener("click", function () {
                // Put selected product name in search box
                input.value = productName;

                // Hide suggestions
                results.innerHTML = "";
                results.style.display = "none";
                globalSearch.container.style.display = "none";

                // Apply product and category filter
                filterProducts();

                // Scroll to the matching product section
                const productList = document.querySelector(".product-list");

                if (productList) {
                    productList.scrollIntoView({
                        behavior: "smooth",
                        block: "start"
                    });
                }
            });

            results.appendChild(suggestion);
            suggestionCount++;
        }
    });

    results.style.display =
        suggestionCount > 0 ? "block" : "none";
    if (suggestionCount === 0) {
        const noProducts = document.getElementById("noProductsMsg");
        if (noProducts) noProducts.style.display = "block";
    } else {
        const noProducts = document.getElementById("noProductsMsg");
        if (noProducts) noProducts.style.display = "none";
    }
    return suggestionCount;
}


// ===============================
// SEARCH INPUT
// ===============================

if (globalSearch.input) {
    globalSearch.input.addEventListener("input", function () {
        filterProducts();
        showSuggestions();
    });

    globalSearch.input.addEventListener("keydown", function (event) {
        if (event.key === "Enter") {
            event.preventDefault();
            submitSearch();
        }

        if (event.key === "Escape") {
            globalSearch.results.innerHTML = "";
            globalSearch.results.style.display = "none";
            globalSearch.container.style.display = "none";
        }
    });
}


// ===============================
// SEARCH BUTTON
// ===============================

function submitSearch() {
    const query = globalSearch.input.value.trim();
    if (!query) {
        globalSearch.input.focus();
        showSuggestions();
        return;
    }

    showSuggestions();
    if (products.length) {
        const visibleCount = filterProducts();
        if (visibleCount > 0) {
            globalSearch.container.style.display = "none";
            const productList = document.querySelector(".product-list");
            if (productList) productList.scrollIntoView({ behavior: "smooth", block: "start" });
        } else {
            globalSearch.results.style.display = "block";
            const noProducts = document.getElementById("noProductsMsg");
            if (noProducts) noProducts.style.display = "block";
        }
        return;
    }

    window.location.href = `shop.html?search=${encodeURIComponent(query)}`;
}

if (globalSearch.button) {
    globalSearch.button.addEventListener("click", submitSearch);
}

const closeSearchBtn = document.getElementById("closeSearchBtn");
if (closeSearchBtn) closeSearchBtn.addEventListener("click", () => {
    globalSearch.container.style.display = "none";
});

const initialSearch = new URLSearchParams(window.location.search).get("search");
if (initialSearch && globalSearch.input) {
    globalSearch.input.value = initialSearch;
    const initialMatchCount = filterProducts();
    if (initialMatchCount > 0) {
        globalSearch.container.style.display = "none";
        const productList = document.querySelector(".product-list");
        if (productList) productList.scrollIntoView({ behavior: "smooth", block: "start" });
    } else if (products.length) {
        globalSearch.container.style.display = "flex";
        showSuggestions();
    }
}


// ===============================
// ALL PRODUCTS BUTTON
// ===============================

if (allBtn) {
    allBtn.addEventListener("click", function () {
        setSelectedCategory("all");
        filterProducts();
        showSuggestions();
    });
}


// ===============================
// WOMEN PRODUCTS BUTTON
// ===============================

if (womenBtn) {
    womenBtn.addEventListener("click", function () {
        setSelectedCategory("women");
        filterProducts();
        showSuggestions();
    });
}


// ===============================
// MEN PRODUCTS BUTTON
// ===============================

if (menBtn) {
    menBtn.addEventListener("click", function () {
        setSelectedCategory("men");
        filterProducts();
        showSuggestions();
    });
}

if (kidsBtn) {
    kidsBtn.addEventListener("click", function () {
        setSelectedCategory("kids");
        filterProducts();
        showSuggestions();
    });
}


// ===============================
// ADD TO CART
// ===============================

function getCart() {
    try {
        const cart = JSON.parse(localStorage.getItem("cart")) || [];
        const legacyIds = {
            "Men Casual Outfit": "men-casual",
            "Men Striped Outfit": "men-striped",
            "Men Summer Outfit": "men-summer",
            "Women Casual Outfit": "women-casual",
            "Women Office Outfit": "women-office"
        };
        return cart.map(item => item.productId ? item : ({
            productId: legacyIds[item.name], quantity: Number(item.quantity) || 1,
            name: item.name, price: Number(item.price) || 0, image: item.image || ""
        })).filter(item => item.productId);
    } catch { return []; }
}

function saveCart(cart) {
    localStorage.setItem("cart", JSON.stringify(cart));
    document.dispatchEvent(new Event("cartchange"));
}

function refreshCartCount() {
    const count = getCart().reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
    document.querySelectorAll(".nav-cart-count").forEach(badge => { badge.textContent = count; });
    document.querySelectorAll('a[title="Cart"]').forEach(link => {
        let badge = link.querySelector(".cart-count");
        if (!badge) {
            badge = document.createElement("span");
            badge.className = "cart-count";
            badge.style.cssText = "margin-left:6px;font-size:12px;font-weight:bold;";
            link.appendChild(badge);
        }
        badge.textContent = count ? `(${count})` : "";
    });
}

refreshCartCount();
document.addEventListener("cartchange", refreshCartCount);

const productListForCart = document.getElementById("productList");
if (productListForCart) {
    productListForCart.addEventListener("click", function (event) {
        const button = event.target.closest(".add-cart");
        if (!button) return;
        const productName = button.dataset.name;
        let cart = getCart();
        const productId = button.dataset.productId;

        const existingProduct = cart.find(function (item) {
            return item.productId === productId;
        });

        if (existingProduct) {
            existingProduct.quantity =
                (Number(existingProduct.quantity) || 1) + 1;
        } else {
            cart.push({
                productId,
                quantity: 1
            });
        }

        saveCart(cart);

        alert(productName + " added to cart!");
    });
}


// ===============================
// CART PAGE
// ===============================

const cartItems = document.getElementById("cartItems");
const cartTotal = document.getElementById("cartTotal");


// ===============================
// DISPLAY CART
// ===============================

function displayCart() {
    if (!cartItems || !cartTotal) return;

    let cart = getCart();

    cartItems.innerHTML = "";

    let total = 0;

    if (cart.length === 0) {
        cartItems.innerHTML = "<p>Your cart is empty.</p>";
        cartTotal.textContent = "Total: ₹0.00";
        return;
    }

    apiRequest("/api/products").then(result => {
        const catalog = new Map(result.products.map(product => [product.id, product]));
        cart = cart.map(item => ({ ...catalog.get(item.productId), ...item, ...(catalog.get(item.productId) ? {} : { name: "Unavailable product", price: 0, image: "" }) }));
        localStorage.setItem("cart", JSON.stringify(cart));
        displayCartFromItems(cart);
    }).catch(() => displayCartFromItems(cart));
}

function displayCartFromItems(cart) {
    if (!cartItems || !cartTotal) return;
    cartItems.innerHTML = "";
    let total = 0;

    cart.forEach(function (item, index) {
        item.quantity = Number(item.quantity) || 1;
        item.price = Number(item.price) || 0;

        const itemTotal = item.price * item.quantity;
        total += itemTotal;

        const itemDiv = document.createElement("div");
        itemDiv.className = "cart-item";

        const image = document.createElement("img");
        if (item.image) image.src = item.image;
        else image.hidden = true;
        image.alt = item.name || "Product";
        image.className = "cart-product-image";

        const heading = document.createElement("h3");
        heading.textContent = item.name || "Product";

        const price = document.createElement("p");
        price.textContent = "Price: ₹" + Number(item.price).toFixed(2);

        const quantityRow = document.createElement("div");

        const minusBtn = document.createElement("button");
        minusBtn.type = "button";
        minusBtn.className = "minus-btn";
        minusBtn.textContent = "−";

        const quantity = document.createElement("span");
        quantity.className = "quantity";
        quantity.textContent = item.quantity;

        const plusBtn = document.createElement("button");
        plusBtn.type = "button";
        plusBtn.className = "plus-btn";
        plusBtn.textContent = "+";

        quantityRow.append(minusBtn, quantity, plusBtn);

        const itemTotalText = document.createElement("p");
        itemTotalText.textContent = "Item Total: ₹" + itemTotal.toFixed(2);

        const removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.className = "remove-btn";
        removeBtn.textContent = "Remove";

        const hr = document.createElement("hr");

        itemDiv.append(
            image,
            heading,
            price,
            quantityRow,
            itemTotalText,
            removeBtn,
            hr
        );

        cartItems.appendChild(itemDiv);

        plusBtn.addEventListener("click", function () {
            if (item.quantity >= 99) return;
            item.quantity++;
            saveCart(cart);
            displayCartFromItems(cart);
        });

        minusBtn.addEventListener("click", function () {
            if (item.quantity > 1) {
                item.quantity--;
                saveCart(cart);
                displayCartFromItems(cart);
            }
        });

        removeBtn.addEventListener("click", function () {
            cart.splice(index, 1);
            saveCart(cart);
            displayCartFromItems(cart);
        });
    });

    cartTotal.textContent = "Total: ₹" + total.toFixed(2);
}


// ===============================
// RUN CART
// ===============================

if (cartItems && cartTotal) {
    displayCart();
    document.addEventListener("cartchange", displayCart);
}


// ===============================
// CHECKOUT BUTTON
// ===============================

const checkoutBtn = document.getElementById("checkoutBtn");
if (checkoutBtn) {
    const updateCheckoutAvailability = () => { checkoutBtn.disabled = getCart().length === 0; };
    updateCheckoutAvailability();
    document.addEventListener("cartchange", updateCheckoutAvailability);
}

if (checkoutBtn) {
    checkoutBtn.addEventListener("click", function () {
        const cart = getCart();

        if (cart.length === 0) {
            alert("Your cart is empty!");
            return;
        }

        window.location.href = "checkout.html";
    });
}


const checkoutSummary = document.getElementById("checkoutSummary");
if (checkoutSummary) {
    const cart = getCart();
    if (!cart.length) {
        checkoutSummary.textContent = "Your cart is empty. ";
        const shopLink = document.createElement("a");
        shopLink.href = "shop.html";
        shopLink.textContent = "Continue shopping";
        checkoutSummary.appendChild(shopLink);
    } else {
        apiRequest("/api/products").then(({ products: catalog }) => {
            const byId = new Map(catalog.map(product => [product.id, product]));
            const rows = cart.map(item => ({ product: byId.get(item.productId), quantity: Number(item.quantity) || 1 }));
            checkoutSummary.replaceChildren();
            if (rows.some(row => !row.product)) {
                checkoutSummary.textContent = "A product in your cart is no longer available. Remove it from your cart before ordering.";
                return;
            }
            let total = 0;
            rows.forEach(({ product, quantity }) => {
                const line = document.createElement("p");
                line.textContent = `${product.name} × ${quantity} — ₹${(product.price * quantity).toFixed(2)}`;
                checkoutSummary.appendChild(line);
                total += product.price * quantity;
            });
            const totalLine = document.createElement("strong");
            totalLine.textContent = `Total: ₹${total.toFixed(2)}`;
            checkoutSummary.appendChild(totalLine);
        }).catch(() => { checkoutSummary.textContent = "Could not load your order summary. Check that the store server is running."; });
    }
}


// ===============================
// PLACE ORDER
// ===============================

const placeOrderBtn = document.getElementById("placeOrderBtn");
const checkoutForm = document.getElementById("checkoutForm");

if (placeOrderBtn && checkoutForm) {
    checkoutForm.addEventListener("submit", function (event) {
        event.preventDefault();
        const cart = getCart();

        if (cart.length === 0) {
            alert("Your cart is empty!");
            return;
        }

        const nameInput = document.getElementById("name");
        const emailInput = document.getElementById("email");
        const addressInput = document.getElementById("address");
        const cityInput = document.getElementById("city");
        const pincodeInput = document.getElementById("pincode");

        if (!nameInput || !nameInput.value.trim()) {
            alert("Please enter your name");
            return;
        }

        if (!emailInput || !emailInput.value.trim() || !emailInput.validity.valid) {
            alert("Please enter your email");
            return;
        }

        if (!addressInput || !addressInput.value.trim()) {
            alert("Please enter your address");
            return;
        }

        if (!cityInput || !cityInput.value.trim()) {
            alert("Please enter your city");
            return;
        }

        if (!pincodeInput || !pincodeInput.value.trim()) {
            alert("Please enter your pincode");
            return;
        }

        const payment = document.querySelector(
            'input[name="payment"]:checked'
        );

        if (!payment) {
            alert("Please select a payment method");
            return;
        }

        placeOrderBtn.disabled = true;
        placeOrderBtn.textContent = "Placing order...";
        let idempotencyKey = sessionStorage.getItem("checkoutIdempotencyKey");
        if (!idempotencyKey) {
            idempotencyKey = globalThis.crypto?.randomUUID?.() || "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, character => {
                const random = Math.floor(Math.random() * 16);
                return (character === "x" ? random : (random & 3) | 8).toString(16);
            });
            sessionStorage.setItem("checkoutIdempotencyKey", idempotencyKey);
        }
        let trackingToken = sessionStorage.getItem("checkoutTrackingToken");
        if (!trackingToken) {
            if (!globalThis.crypto?.getRandomValues) {
                throw new Error("Secure order tracking is unavailable in this browser.");
            }
            const tokenBytes = new Uint8Array(32);
            globalThis.crypto.getRandomValues(tokenBytes);
            trackingToken = Array.from(tokenBytes, byte => byte.toString(16).padStart(2, "0")).join("");
            sessionStorage.setItem("checkoutTrackingToken", trackingToken);
        }
        apiRequest("/api/orders", {
            method: "POST",
            headers: { "Idempotency-Key": idempotencyKey, "X-Order-Tracking-Token": trackingToken },
            body: JSON.stringify({
                customer: { name: nameInput.value, email: emailInput.value, address: addressInput.value, city: cityInput.value, pincode: pincodeInput.value },
                payment: payment.value,
                items: cart.map(item => ({ productId: item.productId, quantity: item.quantity }))
            })
        }).then(result => {
            localStorage.removeItem("cart");
            try {
                localStorage.setItem("lastOrderId", result.order.id);
                localStorage.setItem("orderTrackingToken:" + result.order.id, trackingToken);
            } catch { /* The confirmation stays available in this tab if storage is disabled. */ }
            sessionStorage.removeItem("checkoutIdempotencyKey");
            sessionStorage.removeItem("checkoutTrackingToken");
            refreshCartCount();
            sessionStorage.setItem("lastOrder", JSON.stringify(result.order));
            window.location.href = "order-success.html";
        }).catch(error => {
            const message = document.getElementById("checkoutMessage");
            if (message) message.textContent = error.message;
            else alert(error.message);
            placeOrderBtn.disabled = false;
            placeOrderBtn.textContent = "Place Order";
        });
    });
}


// ===============================
// SEARCH ICON
// ===============================

const searchIcon = document.getElementById("searchIcon");
const searchContainer = globalSearch.container;

if (searchIcon && searchContainer) {
    searchIcon.addEventListener("click", function (event) {
        event.preventDefault();

        const isHidden =
            getComputedStyle(searchContainer).display === "none";

        searchContainer.style.display = isHidden ? "flex" : "none";

        if (isHidden && globalSearch.input) {
            globalSearch.input.focus();
        }

        if (isHidden && globalSearch.input) {
            const params = new URLSearchParams(window.location.search);
            globalSearch.input.value = params.get("search") || "";
            if (globalSearch.input.value) showSuggestions();
        }

        if (!isHidden && globalSearch.results) {
            globalSearch.results.innerHTML = "";
            globalSearch.results.style.display = "none";
            const noProducts = document.getElementById("noProductsMsg");
            if (noProducts) noProducts.style.display = "none";
        }
    });
}

async function showOwnerAdminLink() {
    const nav = document.querySelector("header nav");
    if (!nav || document.getElementById("ownerAdminLink")) return;
    try {
        const response = await fetch("/api/admin/session", { credentials: "same-origin" });
        if (!response.ok) return;
        const session = await response.json();
        if (!session.authenticated) return;
        const link = document.createElement("a");
        link.id = "ownerAdminLink";
        link.href = "admin.html";
        link.title = "Owner admin";
        link.setAttribute("aria-label", "Owner admin");
        link.innerHTML = '<svg class="nav-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill-rule="evenodd" d="M12 2a5 5 0 1 0 0 10 5 5 0 0 0 0-10ZM3 21a9 9 0 0 1 18 0H3Z"/></svg>';
        nav.appendChild(link);
    } catch {
        // A static preview without the Node server simply has no owner link.
    }
}

showOwnerAdminLink();

if (globalSearch.input) {
    globalSearch.input.addEventListener("input", () => {
        const noProducts = document.getElementById("noProductsMsg");
        if (noProducts) noProducts.style.display = "none";
    });
}
// ===============================
// CUSTOMER PROFILE
// ===============================

const accountMessage = document.getElementById("accountMessage");
const authCards = document.getElementById("authCards");
const profilePanel = document.getElementById("profilePanel");

function accountRequest(path, options = {}) {
    return apiRequest(path, { ...options, credentials: "include" });
}

function renderCustomerProfile(customer, orders = []) {
    if (!customer || !profilePanel) return;
    if (authCards) authCards.hidden = true;
    profilePanel.hidden = false;
    document.getElementById("profileName").textContent = customer.name;
    document.getElementById("profileEmail").textContent = customer.email;
    document.getElementById("profilePhone").textContent = customer.phone ? `Phone: ${customer.phone}` : "Phone not added yet";
    const orderBox = document.getElementById("customerOrders");
    if (!orders.length) { orderBox.textContent = "No orders yet. Start shopping for your little one."; return; }
    orderBox.innerHTML = orders.map(order => `<article class="mini-order"><strong>${order.id}</strong><span>${order.status} · ₹${Number(order.total).toFixed(2)}</span><small>${new Date(order.createdAt).toLocaleDateString()}</small></article>`).join("");
}

if (profilePanel) {
    const loadProfile = async () => {
        try {
            const session = await accountRequest("/api/customer/session");
            if (!session.authenticated) return;
            const result = await accountRequest("/api/customer/orders");
            renderCustomerProfile(session.customer, result.orders);
        } catch (error) { if (accountMessage) accountMessage.textContent = error.message; }
    };
    loadProfile();
    document.getElementById("signupForm")?.addEventListener("submit", async event => {
        event.preventDefault();
        try {
            const result = await accountRequest("/api/customer/signup", { method: "POST", body: JSON.stringify({ name: document.getElementById("signupName").value, email: document.getElementById("signupEmail").value, phone: document.getElementById("signupPhone").value, password: document.getElementById("signupPassword").value }) });
            renderCustomerProfile(result.customer, []);
            accountMessage.textContent = "Your customer profile is ready.";
        } catch (error) { accountMessage.textContent = error.message; }
    });
    document.getElementById("loginForm")?.addEventListener("submit", async event => {
        event.preventDefault();
        try {
            const result = await accountRequest("/api/customer/login", { method: "POST", body: JSON.stringify({ email: document.getElementById("loginEmail").value, password: document.getElementById("loginPassword").value }) });
            const orders = await accountRequest("/api/customer/orders");
            renderCustomerProfile(result.customer, orders.orders);
            accountMessage.textContent = "Signed in successfully.";
        } catch (error) { accountMessage.textContent = error.message; }
    });
    document.getElementById("customerLogout")?.addEventListener("click", async () => {
        await accountRequest("/api/customer/logout", { method: "POST" });
        window.location.reload();
    });
}
