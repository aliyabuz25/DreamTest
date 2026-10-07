const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const dataDir = path.join(__dirname, 'admin', 'db');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// JSON dosyalarını oku/yaz
function readJSON(name) {
    const file = path.join(dataDir, `${name}.json`);
    if (!fs.existsSync(file)) return [];
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch(e) { return []; }
}

function writeJSON(name, data) {
    const file = path.join(dataDir, `${name}.json`);
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function now() {
    return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

function nextId(arr) {
    return arr.length === 0 ? 1 : Math.max(...arr.map(r => r.id || 0)) + 1;
}

// Tablo isimleri
const TABLES = ['users', 'orders', 'order_photos', 'visitors', 'credits'];
TABLES.forEach(t => { if (!fs.existsSync(path.join(dataDir, `${t}.json`))) writeJSON(t, []); });

// Kullanıcı yoksa setup sayfasına yönlendirme db.js tarafında yapılmaz,
// routes/admin.js içinde /admin/setup rotası halleder.

// SQLite-benzeri API (prepare/get/all/run)
function makeQuery(table) {
    return {
        get: (params) => {
            const data = readJSON(table);
            return data[0] || null;
        },
        all: () => readJSON(table),
        run: (params) => {}
    };
}

// DB nesnesi - tüm route'lar bu API'yi kullanır
const db = {
    _tables: TABLES,

    prepare(sql) {
        const self = this;
        return {
            get(...params) { return self._query(sql, params, 'get'); },
            all(...params) { return self._query(sql, params, 'all'); },
            run(...params) { return self._query(sql, params, 'run'); }
        };
    },

    exec(sql) { /* no-op for CREATE TABLE */ },

    _query(sql, params, mode) {
        const s = sql.trim();

        // SELECT
        if (/^SELECT/i.test(s)) {
            return this._select(s, params, mode);
        }
        // INSERT
        if (/^INSERT/i.test(s)) {
            return this._insert(s, params);
        }
        // UPDATE
        if (/^UPDATE/i.test(s)) {
            return this._update(s, params);
        }
        // DELETE
        if (/^DELETE/i.test(s)) {
            return this._delete(s, params);
        }
        // ALTER TABLE - ignore
        return mode === 'get' ? null : mode === 'all' ? [] : { changes: 0 };
    },

    _tableName(sql) {
        const m = sql.match(/(?:FROM|INTO|UPDATE|TABLE)\s+(\w+)/i);
        return m ? m[1] : null;
    },

    _select(sql, params, mode) {
        const table = this._tableName(sql);
        if (!table) return mode === 'all' ? [] : null;
        let data = readJSON(table);

        // JOIN desteği (basit LEFT JOIN)
        const joinMatch = sql.match(/LEFT JOIN\s+(\w+)\s+\w+\s+ON\s+\w+\.(\w+)\s*=\s*\w+\.(\w+)/i);
        if (joinMatch) {
            const joinTable = joinMatch[1];
            const leftCol = joinMatch[2];
            const rightCol = joinMatch[3];
            const joinData = readJSON(joinTable);
            data = data.map(row => {
                const joined = joinData.find(j => j[rightCol] == row[leftCol]) || {};
                const prefixed = {};
                Object.keys(joined).forEach(k => { prefixed[`${joinTable[0]}_${k}`] = joined[k]; });
                // Flatten join columns with aliases from SQL
                const result = { ...row };
                // order_name, order_car, order_phone aliases
                if (joinTable === 'orders') {
                    result.order_name = joined.name;
                    result.order_car = joined.car;
                    result.order_phone = joined.phone;
                }
                return result;
            });
        }

        // WHERE parsing
        const whereMatch = sql.match(/WHERE\s+(.+?)(?:\s+ORDER|\s+GROUP|\s+LIMIT|$)/is);
        if (whereMatch && params.length > 0) {
            const whereClause = whereMatch[1].trim();
            data = this._applyWhere(data, whereClause, params);
        }

        // ORDER BY
        const orderMatch = sql.match(/ORDER BY\s+(\w+(?:\.\w+)?)\s*(ASC|DESC)?/i);
        if (orderMatch) {
            const col = orderMatch[1].split('.').pop();
            const dir = (orderMatch[2] || 'ASC').toUpperCase();
            data = [...data].sort((a, b) => {
                if (a[col] < b[col]) return dir === 'ASC' ? -1 : 1;
                if (a[col] > b[col]) return dir === 'ASC' ? 1 : -1;
                return 0;
            });
        }

        // COUNT(DISTINCT col)
        if (/SELECT\s+COUNT\(DISTINCT\s+(\w+)\)/i.test(sql)) {
            const colMatch = sql.match(/COUNT\(DISTINCT\s+(\w+)\)/i);
            const col = colMatch ? colMatch[1] : 'id';
            const unique = new Set(data.map(r => r[col]));
            return { c: unique.size };
        }

        // COUNT(*)
        if (/SELECT\s+COUNT\(\*\)/i.test(sql)) {
            return { c: data.length };
        }

        // COALESCE SUM
        if (/SELECT\s+COALESCE\(SUM/i.test(sql)) {
            const colMatch = sql.match(/SUM\((\w+)\)/i);
            const col = colMatch ? colMatch[1] : 'amount';
            const sum = data.reduce((acc, r) => acc + (parseFloat(r[col]) || 0), 0);
            return { c: sum };
        }

        if (mode === 'get') return data[0] || null;
        return data;
    },

    _applyWhere(data, whereClause, params) {
        const conditions = whereClause.split(/\s+AND\s+/i);
        let paramIdx = 0;
        return data.filter(row => {
            return conditions.every(cond => {
                const c = cond.trim();
                // date(col) = ?
                const dateEqMatch = c.match(/date\((\w+)\)\s*=\s*\?/i);
                if (dateEqMatch) {
                    const col = dateEqMatch[1];
                    const val = params[paramIdx++];
                    return row[col] && row[col].substring(0, 10) === String(val);
                }
                // date(col) >= ?
                const dateGteMatch = c.match(/date\((\w+)\)\s*>=\s*\?/i);
                if (dateGteMatch) {
                    const col = dateGteMatch[1];
                    const val = params[paramIdx++];
                    return row[col] && row[col].substring(0, 10) >= String(val);
                }
                // col = ?
                const eqMatch = c.match(/(\w+(?:\.\w+)?)\s*=\s*\?/i);
                if (eqMatch) {
                    const col = eqMatch[1].split('.').pop();
                    const val = params[paramIdx++];
                    // Case-insensitive ve tip bağımsız kontrol
                    return String(row[col]).toLowerCase() === String(val).toLowerCase();
                }
                // status='value' (literal)
                const litMatch = c.match(/(\w+)\s*=\s*'([^']+)'/i);
                if (litMatch) {
                    const col = litMatch[1];
                    const val = litMatch[2];
                    return String(row[col]).toLowerCase() === String(val).toLowerCase();
                }
                paramIdx++;
                return true;
            });
        });
    },

    _insert(sql, params) {
        const table = this._tableName(sql);
        if (!table) return { lastInsertRowid: 0 };
        const data = readJSON(table);

        // Kolon isimlerini al
        const colMatch = sql.match(/\(([^)]+)\)\s+VALUES/i);
        if (!colMatch) return { lastInsertRowid: 0 };
        const cols = colMatch[1].split(',').map(c => c.trim());

        const id = nextId(data);
        const row = { id, created_at: now() };
        cols.forEach((col, i) => { row[col] = params[i] !== undefined ? params[i] : null; });

        data.push(row);
        writeJSON(table, data);
        return { lastInsertRowid: id, changes: 1 };
    },

    _update(sql, params) {
        const table = this._tableName(sql);
        if (!table) return { changes: 0 };
        let data = readJSON(table);

        // SET kısımlarını al
        const setMatch = sql.match(/SET\s+(.+?)\s+WHERE/is);
        if (!setMatch) return { changes: 0 };
        const setParts = setMatch[1].split(',').map(s => s.trim());
        const setCols = setParts.map(p => p.match(/(\w+)\s*=/)?.[1]).filter(Boolean);

        // WHERE kısımını al
        const whereMatch = sql.match(/WHERE\s+(.+?)(?:\s*$)/is);
        const whereClause = whereMatch ? whereMatch[1].trim() : null;

        // WHERE parametrelerini ayır
        const setParamCount = setCols.length;
        const setParams = params.slice(0, setParamCount);
        const whereParams = params.slice(setParamCount);

        let changed = 0;
        data = data.map(row => {
            if (whereClause) {
                const matched = this._applyWhere([row], whereClause, [...whereParams]);
                if (matched.length === 0) return row;
            }
            const updated = { ...row, updated_at: now() };
            setCols.forEach((col, i) => { updated[col] = setParams[i]; });
            changed++;
            return updated;
        });

        writeJSON(table, data);
        return { changes: changed };
    },

    _delete(sql, params) {
        const table = this._tableName(sql);
        if (!table) return { changes: 0 };
        let data = readJSON(table);

        const whereMatch = sql.match(/WHERE\s+(.+?)(?:\s*$)/is);
        if (whereMatch && params.length > 0) {
            const before = data.length;
            const toDelete = this._applyWhere(data, whereMatch[1].trim(), params);
            const deleteIds = new Set(toDelete.map(r => r.id));
            data = data.filter(r => !deleteIds.has(r.id));
            writeJSON(table, data);
            return { changes: before - data.length };
        }
        return { changes: 0 };
    }
};

module.exports = db;