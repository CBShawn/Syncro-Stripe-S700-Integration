// services/cache.js
const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "../data");
const CACHE_FILE = path.join(DATA_DIR, "cache.json");

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (e) {
    console.warn("⚠️ Could not create data dir:", e.message);
  }
}

// Initial state loader from disk
function loadState() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const raw = fs.readFileSync(CACHE_FILE, "utf-8");
      const data = JSON.parse(raw);
      return {
        statuses: new Map(Object.entries(data.statuses || {})),
        processed: new Set(data.processed || []),
        signatures: new Map(Object.entries(data.signatures || {})),
      };
    }
  } catch (err) {
    console.warn("⚠️ Failed to load local cache file, starting fresh:", err.message);
  }
  return {
    statuses: new Map(),
    processed: new Set(),
    signatures: new Map(),
  };
}

const state = loadState();

// Save state to disk
function persistState() {
  try {
    const payload = {
      statuses: Object.fromEntries(state.statuses),
      processed: Array.from(state.processed),
      signatures: Object.fromEntries(state.signatures),
    };
    fs.writeFileSync(CACHE_FILE, JSON.stringify(payload, null, 2), "utf-8");
  } catch (err) {
    console.error("❌ Failed to write cache to disk:", err.message);
  }
}

// =========================================================================
// PERSISTENT STORES
// =========================================================================

const invoicePaymentStatus = {
  get: (key) => state.statuses.get(String(key)),
  set: (key, val) => {
    state.statuses.set(String(key), val);
    persistState();
  },
  delete: (key) => {
    state.statuses.delete(String(key));
    persistState();
  },
  has: (key) => state.statuses.has(String(key)),
};

const processedSyncroPayments = {
  has: (key) => state.processed.has(String(key)),
  add: (key) => {
    state.processed.add(String(key));
    persistState();
  },
  delete: (key) => {
    state.processed.delete(String(key));
    persistState();
  },
  [Symbol.iterator]: () => state.processed[Symbol.iterator](),
  forEach: (...args) => state.processed.forEach(...args),
  get size() {
    return state.processed.size;
  },
};

const invoiceSignatureCache = {
  get: (key) => state.signatures.get(String(key)),
  set: (key, val) => {
    state.signatures.set(String(key), val);
    persistState();
  },
  delete: (key) => {
    state.signatures.delete(String(key));
    persistState();
  },
  has: (key) => state.signatures.has(String(key)),
};

// =========================================================================
// TRANSIENT IN-FLIGHT STORES (Not written to disk)
// =========================================================================
const invoiceCustomerCache = new Map();
const pendingSyncroPayments = new Map();
const activeReaderIntents = new Map();

module.exports = {
  invoiceCustomerCache,
  invoicePaymentStatus,
  processedSyncroPayments,
  pendingSyncroPayments,
  activeReaderIntents,
  invoiceSignatureCache,
};
