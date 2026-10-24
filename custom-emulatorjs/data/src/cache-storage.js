const CACHE_STORAGE_TIMEOUT_MS = 5000;

// Download cache only. Save/state storage has a separate lifecycle.
class EJS_CacheStorage {
    constructor(dbName, storeName) {
        this.dbName = dbName;
        this.storeName = storeName;
    }

    request(mode, operation) {
        return new Promise((resolve, reject) => {
            let db, transaction, settled = false;
            const finish = (error, result) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                db?.close();
                if (error) reject(error);
                else resolve(result);
            };
            const timer = setTimeout(() => {
                finish(new Error("Download cache storage timed out"));
                try { transaction?.abort(); } catch {}
            }, CACHE_STORAGE_TIMEOUT_MS);

            try {
                const open = window.indexedDB.open(this.dbName, 1);
                open.onerror = () => finish(open.error);
                open.onblocked = () => finish(new Error("Download cache database is blocked"));
                open.onupgradeneeded = () => {
                    if (settled) {
                        open.transaction.abort();
                        return;
                    }
                    const database = open.result;
                    if (!database.objectStoreNames.contains("cache")) {
                        const cache = database.createObjectStore("cache");
                        for (const index of ["type", "url"]) {
                            cache.createIndex(index, index, { unique: false });
                        }
                    }
                    if (!database.objectStoreNames.contains("blobs")) database.createObjectStore("blobs");
                };
                open.onsuccess = () => {
                    db = open.result;
                    if (settled) {
                        db.close();
                        return;
                    }
                    db.onversionchange = () => db.close();
                    try {
                        transaction = db.transaction(this.storeName, mode);
                        transaction.onabort = () => finish(transaction.error || new Error("Download cache transaction aborted"));
                        const request = operation(transaction.objectStore(this.storeName));
                        transaction.oncomplete = () => finish(null, request.result);
                        // Schedule closure without aborting the active transaction.
                        db.close();
                    } catch (error) {
                        try { transaction?.abort(); } catch {}
                        finish(error);
                    }
                };
            } catch (error) {
                finish(error);
            }
        });
    }

    get(key, indexName = null) {
        return this.request("readonly", store => (indexName ? store.index(indexName) : store).get(key));
    }

    put(key, value) {
        return this.request("readwrite", store => store.put(value, key));
    }

    remove(key) {
        return this.request("readwrite", store => store.delete(key));
    }

    async getAll() {
        const items = await this.request("readonly", store => store.getAll());
        // Key-index records are not cache metadata.
        return items.filter(item => item && !Array.isArray(item));
    }

    async getKeys() {
        const keys = await this.request("readonly", store => store.getAllKeys());
        return keys.filter(key => key !== "?EJS_KEYS!");
    }
}

export { EJS_CacheStorage };
