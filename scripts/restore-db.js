const fs = require("node:fs/promises");
const path = require("node:path");
const Database = require("better-sqlite3");

const ROOT = path.resolve(__dirname, "..");
const databasePath = path.resolve(ROOT, process.env.DATABASE_FILE || path.join("data", "store.sqlite"));
const sourcePath = process.argv[2] ? path.resolve(process.argv[2]) : "";
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const tempPath = `${databasePath}.restore-${stamp}.tmp`;
const safetyPath = `${databasePath}.before-restore-${stamp}.sqlite`;

(async () => {
    if (!sourcePath) throw new Error("Usage: node scripts/restore-db.js <backup-file>");
    if (sourcePath === databasePath) throw new Error("Restore source must be a backup, not the live database.");
    await fs.access(sourcePath);
    await fs.mkdir(path.dirname(databasePath), { recursive: true });

    const backup = new Database(sourcePath, { readonly: true, fileMustExist: true });
    try { await backup.backup(tempPath); }
    finally { backup.close(); }

    try {
        try {
            const live = new Database(databasePath, { readonly: true, fileMustExist: true });
            try { await live.backup(safetyPath); }
            finally { live.close(); }
        } catch (error) {
            if (error.code !== "SQLITE_CANTOPEN" && error.code !== "SQLITE_CANTOPEN_NOTEMPDIR") throw error;
        }
        await fs.rm(`${databasePath}-wal`, { force: true });
        await fs.rm(`${databasePath}-shm`, { force: true });
        await fs.rm(databasePath, { force: true });
        await fs.rename(tempPath, databasePath);
        console.log(`Database restored from ${sourcePath}`);
        try { await fs.access(safetyPath); console.log(`Pre-restore safety backup saved to ${safetyPath}`); }
        catch { /* No database existed before restore. */ }
    } catch (error) {
        await fs.rm(tempPath, { force: true });
        throw error;
    }
})().catch(error => {
    console.error(`Database restore failed: ${error.message}`);
    process.exitCode = 1;
});
