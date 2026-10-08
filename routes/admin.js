const express = require('express');
const router = express.Router();
const db = require('../db');
const bcrypt = require('bcryptjs');
const { format, subDays } = require('date-fns');
const multer = require('multer');
const path = require('path');

// Multer setup for reply uploads
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, path.join(__dirname, '../admin/uploads'))
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'reply_' + req.body.id + '_' + uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

// Admin Auth Middleware
const requireLogin = (req, res, next) => {
    if (!req.session.admin_id) {
        return res.redirect('/admin/login');
    }
    next();
};

// Setup Route — sadece hiç kullanıcı yokken erişilebilir
router.get('/setup', (req, res) => {
    const users = db.prepare("SELECT id FROM users").all();
    if (users.length > 0) return res.redirect('/admin/login');
    res.render('admin/setup', { error: null });
});

router.post('/setup', (req, res) => {
    const users = db.prepare("SELECT id FROM users").all();
    if (users.length > 0) return res.redirect('/admin/login'); // Zafiyet önleme

    const { username, password, confirm } = req.body;

    if (!username || username.length < 3) {
        return res.render('admin/setup', { error: 'Kullanıcı adı en az 3 karakter olmalı.' });
    }
    if (!password || password.length < 8) {
        return res.render('admin/setup', { error: 'Şifre en az 8 karakter olmalı.' });
    }
    if (password !== confirm) {
        return res.render('admin/setup', { error: 'Şifreler eşleşmiyor.' });
    }
    // Güçlü şifre kontrolü
    if (!/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
        return res.render('admin/setup', { error: 'Şifre en az 1 büyük harf ve 1 rakam içermeli.' });
    }

    const hash = bcrypt.hashSync(password, 12);
    db.prepare("INSERT INTO users (username, password) VALUES (?, ?)").run(username, hash);
    res.redirect('/admin/login');
});

// Login Route
router.get('/login', (req, res) => {
    if (req.session.admin_id) return res.redirect('/admin');
    // Kullanıcı yoksa setup'a yönlendir
    const users = db.prepare("SELECT id FROM users").all();
    if (users.length === 0) return res.redirect('/admin/setup');
    res.render('admin/login', { error: null });
});

router.post('/login', (req, res) => {
    const { username, password } = req.body;
    const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username);

    if (user && bcrypt.compareSync(password, user.password)) {
        req.session.admin_id = user.id;
        req.session.admin_user = user.username;
        res.redirect('/admin');
    } else {
        res.render('admin/login', { error: 'Hatalı kullanıcı adı veya şifre' });
    }
});

router.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/admin/login');
});

// Protected middleware - sadece korumalı route'lara uygulanır
const protect = [requireLogin, (req, res, next) => {
    res.locals.currentPath = req.path;
    res.locals.adminUser = req.session.admin_user;
    next();
}];

// Dashboard
router.get('/', protect, (req, res) => {
    const totalOrders = db.prepare("SELECT COUNT(*) as c FROM orders").get().c;
    const pendingOrders = db.prepare("SELECT COUNT(*) as c FROM orders WHERE status='beklemede'").get().c;
    const doneOrders = db.prepare("SELECT COUNT(*) as c FROM orders WHERE status='tamamlandi'").get().c;
    
    // SQLite'da date('now', 'localtime') için formatlama veya JS tarafında filtreleme
    const todayStr = format(new Date(), 'yyyy-MM-dd');
    const todayVisitors = db.prepare("SELECT COUNT(DISTINCT ip) as c FROM visitors WHERE date(created_at) = ?").get(todayStr).c;
    const totalCredit = db.prepare("SELECT COALESCE(SUM(amount),0) as c FROM credits").get().c;

    const last7 = [];
    const last7v = [];
    for (let i = 6; i >= 0; i--) {
        const d = subDays(new Date(), i);
        const dateStr = format(d, 'yyyy-MM-dd');
        const displayDate = format(d, 'dd MMM');
        
        const count = db.prepare("SELECT COUNT(*) as c FROM orders WHERE date(created_at) = ?").get(dateStr).c;
        last7.push({ date: displayDate, count });
        
        const vCount = db.prepare("SELECT COUNT(DISTINCT ip) as c FROM visitors WHERE date(created_at) = ?").get(dateStr).c;
        last7v.push(vCount);
    }

    const recentOrders = db.prepare("SELECT * FROM orders ORDER BY created_at DESC LIMIT 8").all();
    const inceleniyor = db.prepare("SELECT COUNT(*) as c FROM orders WHERE status='inceleniyor'").get().c;
    const iptal = db.prepare("SELECT COUNT(*) as c FROM orders WHERE status='iptal'").get().c;


    res.render('admin/index', {
        totalOrders, pendingOrders, doneOrders, todayVisitors, totalCredit,
        last7, last7v, recentOrders, inceleniyor, iptal
    });
});

// Orders Route
router.get('/orders', protect, (req, res) => {
    let detailOrder = null;
    let orders = [];
    let photos = [];

    if (req.query.id) {
        detailOrder = db.prepare("SELECT * FROM orders WHERE id = ?").get(req.query.id);
        photos = db.prepare("SELECT * FROM order_photos WHERE order_id = ?").all(req.query.id);
    } else {
        orders = db.prepare("SELECT * FROM orders ORDER BY created_at DESC").all();
    }

    res.render('admin/orders', { detailOrder, orders, photos });
});

router.post('/orders', protect, (req, res) => {
    const { action, id } = req.body;
    
    if (action === 'update_status') {
        const { status } = req.body;
        db.prepare("UPDATE orders SET status=? WHERE id=?").run(status, id);

        // Tamamlandıysa otomatik gelir kaydı ekle (mükerrer önleme)
        if (status === 'tamamlandi') {
            const existingCredit = db.prepare("SELECT id FROM credits WHERE order_id = ?").get(id);
            if (!existingCredit) {
                const o = db.prepare("SELECT * FROM orders WHERE id = ?").get(id);
                let amount = 2000;
                if (o.package && o.package.includes('Pro Paket')) amount = 6000;
                else if (o.package && o.package.includes('VIP')) amount = 15000;
                db.prepare("INSERT INTO credits (type, amount, description, order_id, order_code) VALUES ('gelir', ?, ?, ?, ?)")
                  .run(amount, `${o.name} — ${o.car} — ${o.package || o.service}`, id, o.code);
            }
        }

        // WhatsApp Bildirimi
        const axios = require('axios');
        const { ADMIN_PHONE, WA_SERVER, SITE_URL } = require('../config');
        const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(id);
        
        const statusText = status === 'beklemede' ? 'Onay Bekleniyor' : status === 'inceleniyor' ? 'İşleme Alındı / Tasarım Aşaması' : status === 'tamamlandi' ? 'Tamamlandı' : status === 'iptal' ? 'İptal Edildi' : 'Ödeme Bekleniyor';

        // Müşteriye bildirim
        if (order.phone) {
            axios.post(`${WA_SERVER}/send`, {
                phone: order.phone,
                message: `Sayın ${order.name},\n\nSiparişinizin durumu güncellenmiştir.\n\n— Sipariş Bilgisi —\nTakip Kodu: ${order.code}\nAraç: ${order.car}\nGüncel Durum: ${statusText}\n\nSiparişinizi takip etmek için:\n${SITE_URL}/track?code=${order.code}\n\nHerhangi bir sorunuz olması halinde bizimle iletişime geçebilirsiniz.\n\nSaygılarımızla,\nDreamStudio Tasarım & Üretim`
            }).catch(e => console.error('WA Status Update Error:', e.message));
        }

        // Admine bildirim
        axios.post(`${WA_SERVER}/send`, {
            phone: ADMIN_PHONE,
            message: `[DURUM GÜNCELLEMESİ]\n\nKod: ${order.code}\nMüşteri: ${order.name}\nTelefon: ${order.phone}\nAraç: ${order.car}\nYeni Durum: ${statusText}`
        }).catch(e => console.error('WA Admin Status Update Error:', e.message));

        return res.json({ ok: true });
    }
});

// API for Reply
router.post('/api/reply', protect, upload.single('image'), (req, res) => {
    const { id, reply } = req.body;
    let imagePath = '';
    
    if (req.file) {
        imagePath = req.file.filename;
    }

    try {
        db.prepare("UPDATE orders SET reply=?, reply_image=?, status='tamamlandi' WHERE id=?").run(reply, imagePath, id);
        
        // WhatsApp Bildirimi
        const axios = require('axios');
        const { ADMIN_PHONE, WA_SERVER, SITE_URL } = require('../config');
        const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(id);

        // Müşteriye bildirim
        if (order.phone) {
            axios.post(`${WA_SERVER}/send`, {
                phone: order.phone,
                message: `Sayın ${order.name},\n\nAracınıza ait özel tasarım çalışması tamamlanmış ve sistemimize yüklenmiştir.\n\n— Sipariş Bilgisi —\nTakip Kodu: ${order.code}\nAraç: ${order.car}\nDurum: Tamamlandı\n\nTasarımınızı görüntülemek ve detayları incelemek için aşağıdaki bağlantıyı ziyaret ediniz:\n${SITE_URL}/track?code=${order.code}\n\nBizi tercih ettiğiniz için teşekkür eder, iyi sürüşler dileriz.\n\nSaygılarımızla,\nDreamStudio Tasarım & Üretim`
            }).catch(e => console.error('WA Reply Update Error:', e.message));
        }

        // Admine bildirim
        axios.post(`${WA_SERVER}/send`, {
            phone: ADMIN_PHONE,
            message: `[TASARİM TESLİMİ]\n\nKod: ${order.code}\nMüşteri: ${order.name}\nTelefon: ${order.phone}\nAraç: ${order.car}\n\nSipariş tamamlandı olarak işaretlendi.`
        }).catch(e => console.error('WA Admin Reply Error:', e.message));

        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// Dekont API
router.get('/credits/dekont/:id', protect, (req, res) => {
    const credit = db.prepare("SELECT * FROM credits WHERE id = ?").get(req.params.id);
    if (!credit) return res.json({ ok: false });
    const order = credit.order_id ? db.prepare("SELECT * FROM orders WHERE id = ?").get(credit.order_id) : null;
    res.json({ ok: true, credit, order });
});

// Credits Route
router.get('/credits', protect, (req, res) => {
    const { format, subDays, startOfWeek, startOfMonth, startOfYear } = require('date-fns');
    const now = new Date();

    const credits = db.prepare("SELECT c.*, o.name as order_name, o.car as order_car, o.phone as order_phone FROM credits c LEFT JOIN orders o ON c.order_id = o.id ORDER BY c.created_at DESC").all();
    const totalIn = db.prepare("SELECT COALESCE(SUM(amount),0) as c FROM credits WHERE type='gelir'").get().c;
    const totalOut = db.prepare("SELECT COALESCE(SUM(amount),0) as c FROM credits WHERE type='gider'").get().c;
    const balance = totalIn - totalOut;

    // Haftalık
    const weekStart = format(startOfWeek(now, {weekStartsOn: 1}), 'yyyy-MM-dd');
    const weekIn = db.prepare("SELECT COALESCE(SUM(amount),0) as c FROM credits WHERE type='gelir' AND date(created_at) >= ?").get(weekStart).c;
    const weekOut = db.prepare("SELECT COALESCE(SUM(amount),0) as c FROM credits WHERE type='gider' AND date(created_at) >= ?").get(weekStart).c;

    // Aylık
    const monthStart = format(startOfMonth(now), 'yyyy-MM-dd');
    const monthIn = db.prepare("SELECT COALESCE(SUM(amount),0) as c FROM credits WHERE type='gelir' AND date(created_at) >= ?").get(monthStart).c;
    const monthOut = db.prepare("SELECT COALESCE(SUM(amount),0) as c FROM credits WHERE type='gider' AND date(created_at) >= ?").get(monthStart).c;

    // Yıllık
    const yearStart = format(startOfYear(now), 'yyyy-MM-dd');
    const yearIn = db.prepare("SELECT COALESCE(SUM(amount),0) as c FROM credits WHERE type='gelir' AND date(created_at) >= ?").get(yearStart).c;
    const yearOut = db.prepare("SELECT COALESCE(SUM(amount),0) as c FROM credits WHERE type='gider' AND date(created_at) >= ?").get(yearStart).c;

    res.render('admin/credits', { 
        credits, totalIn, totalOut, balance,
        weekIn, weekOut, weekBalance: weekIn - weekOut,
        monthIn, monthOut, monthBalance: monthIn - monthOut,
        yearIn, yearOut, yearBalance: yearIn - yearOut
    });
});

router.post('/credits', protect, (req, res) => {
    const { action } = req.body;
    
    if (action === 'add') {
        const { type, amount, description } = req.body;
        db.prepare("INSERT INTO credits (type, amount, description) VALUES (?, ?, ?)").run(type, amount, description);
        res.json({ ok: true });
    }
    
    if (action === 'delete') {
        const { id } = req.body;
        db.prepare("DELETE FROM credits WHERE id = ?").run(id);
        res.json({ ok: true });
    }
});
router.post('/api/clear_visitors', protect, (req, res) => {
    try {
        db.prepare("DELETE FROM visitors").run();
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});
// WhatsApp Route
router.get('/whatsapp', protect, (req, res) => {
    res.render('admin/whatsapp');
});

// Campaign (Toplu Mesaj) Route
router.get('/campaign', protect, (req, res) => {
    // Benzersiz müşterileri (telefon bazlı) çekelim
    const allOrders = db.prepare("SELECT name, phone, car FROM orders ORDER BY created_at DESC").all();
    const uniqueCustomers = [];
    const phoneSet = new Set();
    
    for (const o of allOrders) {
        if (o.phone && !phoneSet.has(o.phone)) {
            phoneSet.add(o.phone);
            uniqueCustomers.push({ name: o.name, phone: o.phone, last_car: o.car });
        }
    }
    
    res.render('admin/campaign', { customers: uniqueCustomers });
});

router.post('/campaign/send', protect, async (req, res) => {
    const { phones, message } = req.body;
    if (!phones || !Array.isArray(phones) || phones.length === 0) {
        return res.json({ ok: false, error: 'Hiçbir müşteri seçilmedi.' });
    }
    if (!message || message.trim() === '') {
        return res.json({ ok: false, error: 'Mesaj boş olamaz.' });
    }

    const axios = require('axios');
    const { WA_SERVER } = require('../config');
    let successCount = 0;
    let failCount = 0;

    // Mesajları sırayla gönder (WhatsApp ban riskini azaltmak için ufak bir bekleme koyulabilir)
    for (const phone of phones) {
        try {
            await axios.post(`${WA_SERVER}/send`, { phone, message });
            successCount++;
            // Çok hızlı atmamak için 500ms bekle (isteğe bağlı ama iyi pratik)
            await new Promise(resolve => setTimeout(resolve, 500));
        } catch (e) {
            failCount++;
            console.error(`Kampanya gönderim hatası (${phone}):`, e.message);
        }
    }

    res.json({ ok: true, successCount, failCount });
});

// WA Proxy endpoints - tarayıcıdan direkt 3001'e bağlanmak yerine server üzerinden
const axios = require('axios');
const WA_SERVER = process.env.WA_SERVER_URL || 'http://localhost:3001';

router.get('/wa/status', protect, async (req, res) => {
    try {
        const r = await axios.get(`${WA_SERVER}/status`, { timeout: 3000 });
        res.json(r.data);
    } catch(e) { res.json({ status: 'disconnected' }); }
});

router.post('/wa/start', protect, async (req, res) => {
    try {
        const r = await axios.post(`${WA_SERVER}/start`, {}, { timeout: 30000 });
        res.json(r.data);
    } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/wa/disconnect', protect, async (req, res) => {
    try {
        const r = await axios.post(`${WA_SERVER}/disconnect`, {}, { timeout: 5000 });
        res.json(r.data);
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// Settings Route
router.get('/settings', protect, (req, res) => {
    const tables = {
        'orders': 'Toplam Talep',
        'visitors': 'Ziyaretçi Kaydı',
        'credits': 'Kredi Kaydı',
        'wa_sessions': 'WA Session'
    };
    const counts = {};
    for (const [table, label] of Object.entries(tables)) {
        counts[table] = {
            label,
            count: db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get().c
        };
    }
    res.render('admin/settings', { counts, msg: null });
});

router.post('/settings', protect, (req, res) => {
    const { action } = req.body;
    
    if (action === 'change_password') {
        const { current, new: newPass, confirm } = req.body;
        const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.session.admin_id);
        
        let msg = null;
        if (!bcrypt.compareSync(current, user.password)) {
            msg = { type: 'error', text: 'Mevcut şifre hatalı.' };
        } else if (newPass !== confirm) {
            msg = { type: 'error', text: 'Yeni şifreler eşleşmiyor.' };
        } else if (newPass.length < 6) {
            msg = { type: 'error', text: 'Şifre en az 6 karakter olmalı.' };
        } else {
            const hash = bcrypt.hashSync(newPass, 10);
            db.prepare("UPDATE users SET password = ? WHERE id = ?").run(hash, req.session.admin_id);
            msg = { type: 'success', text: 'Şifre başarıyla güncellendi.' };
        }
        
        const tables = { 'orders': 'Toplam Talep', 'visitors': 'Ziyaretçi Kaydı', 'credits': 'Kredi Kaydı', 'wa_sessions': 'WA Session' };
        const counts = {};
        for (const [table, label] of Object.entries(tables)) {
            counts[table] = { label, count: db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get().c };
        }
        
        return res.render('admin/settings', { counts, msg });
    }
});

// Users Route
router.get('/users', protect, (req, res) => {
    const users = db.prepare("SELECT id, username, created_at FROM users ORDER BY id ASC").all();
    res.render('admin/users', { users, currentUser: req.session.admin_id });
});

router.post('/users', protect, (req, res) => {
    const { action } = req.body;

    if (action === 'add') {
        const { username, password } = req.body;
        if (!username || !password || password.length < 6) {
            return res.json({ ok: false, error: 'Kullanıcı adı ve en az 6 karakterli şifre gerekli.' });
        }
        const existing = db.prepare("SELECT id FROM users WHERE username = ?").get(username);
        if (existing) return res.json({ ok: false, error: 'Bu kullanıcı adı zaten mevcut.' });
        const hash = bcrypt.hashSync(password, 10);
        db.prepare("INSERT INTO users (username, password) VALUES (?, ?)").run(username, hash);
        return res.json({ ok: true });
    }

    if (action === 'edit') {
        const { id, password } = req.body;
        if (!password || password.length < 6) {
            return res.json({ ok: false, error: 'Şifre en az 6 karakter olmalı.' });
        }
        const hash = bcrypt.hashSync(password, 10);
        db.prepare("UPDATE users SET password = ? WHERE id = ?").run(hash, id);
        return res.json({ ok: true });
    }

    if (action === 'delete') {
        const { id } = req.body;
        if (parseInt(id) === req.session.admin_id) {
            return res.json({ ok: false, error: 'Kendi hesabınızı silemezsiniz.' });
        }
        db.prepare("DELETE FROM users WHERE id = ?").run(id);
        return res.json({ ok: true });
    }
});

module.exports = router;
