const express = require('express');
const router = express.Router();
const db = require('../db');
const multer = require('multer');
const path = require('path');

// Multer setup for uploads
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, path.join(__dirname, '../admin/uploads'))
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

function generateCode() {
    return 'DS' + Math.random().toString(36).substring(2, 6).toUpperCase() + Math.floor(Math.random() * 100);
}

// Yeni sipariş oluşturma (Eski api.php?action=create)
router.post('/order', upload.any(), (req, res) => {
    try {
        const { name, phone, email, car, plate, service, note } = req.body;
        const pkg = req.body.package;
        const code = generateCode();
        
        // Ödeme adımı olduğu için her siparişi 'odeme_bekliyor' durumunda başlatıyoruz.
        const initialStatus = 'odeme_bekliyor';

        const stmt = db.prepare(`
            INSERT INTO orders (code, name, phone, email, car, plate, service, package, note, status) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        
        const result = stmt.run(code, name, phone, email, car, plate, service, pkg, note, initialStatus);
        const orderId = result.lastInsertRowid;

        // Dosyalar varsa 
        if (req.files && req.files.length > 0) {
            const photoStmt = db.prepare("INSERT INTO order_photos (order_id, type, filename) VALUES (?, ?, ?)");
            req.files.forEach(file => {
                photoStmt.run(orderId, file.fieldname, file.filename);
            });
        }

        // WA Bildirimi - form verisinden direkt gönder (newOrder null olsa bile çalışır)
        const axios = require('axios');
        const { ADMIN_PHONE, WA_SERVER, SITE_URL } = require('../config');
        
        if (phone) {
            axios.post(`${WA_SERVER}/send`, {
                phone: phone,
                message: `Sayın ${name},\n\nDreamStudio'ya başvurduğunuz için teşekkür ederiz. Talebiniz sistemimize başarıyla kaydedilmiştir.\n\n— Talep Detayları —\nAraç: ${car}\nHizmet: ${service}\nPaket: ${pkg || '-'}\nTakip Kodu: ${code}\n\n— Ödeme Bilgileri —\nBanka: Akbank Altunizade\nHesap Sahibi: Celalettin Yabuz\nİBAN: TR96 0004 6008 6688 8000 0775 26\nAçıklama: ${code}\n\nÖdemenizi gerçekleştirdikten sonra süreciniz başlatılacak olup en kısa sürede ekibimiz sizinle iletişime geçecektir.\n\nSipariş takibinizi aşağıdaki bağlantı üzerinden yapabilirsiniz:\n${SITE_URL}/track?code=${code}\n\nSaygılarımızla,\nDreamStudio Tasarım & Üretim`
            }).catch(e => console.error('WA Müşteri Mesaj Hatası:', e.message));
        }

        axios.post(`${WA_SERVER}/send`, {
            phone: ADMIN_PHONE,
            message: `[YENİ TALEP]\n\nMüşteri: ${name}\nTelefon: ${phone}\nAraç: ${car}\nHizmet: ${service}\nPaket: ${pkg || '-'}\nNot: ${note || '-'}\nKod: ${code}\n\nPanel: ${SITE_URL}/admin/orders`
        }).catch(e => console.error('WA Admin Mesaj Hatası:', e.message));

        const newOrder = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);

        res.json({
            success: true,
            code: code,
            order: newOrder || { code, name, phone, car, service, status: initialStatus }
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

router.get('/track', (req, res) => {
    const code = req.query.code;
    if (!code) return res.json({ success: false, error: 'Kod gönderilmedi' });
    
    try {
        let order = db.prepare("SELECT * FROM orders WHERE code = ?").get(code.trim());
        if (!order) order = db.prepare("SELECT * FROM orders WHERE code = ?").get(code.trim().toUpperCase());
        if (order) {
            res.json({ success: true, order: order });
        } else {
            res.json({ success: false, error: 'Sipariş bulunamadı' });
        }
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

router.get('/badge', (req, res) => {
    try {
        const count = db.prepare("SELECT COUNT(*) as c FROM orders WHERE status='odeme_bekliyor' OR status='beklemede'").get().c;
        res.json({ count });
    } catch (e) {
        res.json({ count: 0 });
    }
});

module.exports = router;
