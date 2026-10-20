const fs = require("node:fs/promises");
const path = require("node:path");
const Database = require("better-sqlite3");

const ROOT = path.resolve(__dirname, "..");
const databasePath = path.resolve(ROOT, process.env.DATABASE_FILE || path.join("data", "store.sqlite"));
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const destination = path.resolve(ROOT, process.argv[2] || path.join("backups", `store-${stamp}.sqlite`));

(async () => {
    if (destination === databasePath) throw new Error("Backup destination must be different from the live database.");
    await fs.mkdir(path.dirname(destination), { recursive: true });
    const database = new Database(databasePath, { readonly: true, fileMustExist: true });
    try { await database.backup(destination); }
    finally { database.close(); }
    console.log(`Database backup saved to ${destination}`);
})().catch(error => {
    console.error(`Database backup failed: ${error.message}`);
    process.exitCode = 1;
});
