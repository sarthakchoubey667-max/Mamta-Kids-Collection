(() => {
    const page = location.pathname.split("/").pop() || "index.html";
    const publicPages = new Set(["", "index.html", "account.html", "admin.html"]);
    if (publicPages.has(page)) return;
    const destination = `${page}${location.search}${location.hash}`;
    fetch("/api/customer/session", { credentials: "include" })
        .then(response => response.ok ? response.json() : { authenticated: false })
        .then(session => {
            if (!session.authenticated) location.replace(`account.html?next=${encodeURIComponent(destination)}`);
            else document.documentElement.classList.add("customer-authenticated");
        })
        .catch(() => location.replace(`account.html?next=${encodeURIComponent(destination)}`));
})();
