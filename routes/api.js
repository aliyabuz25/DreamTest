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

        // Yeni sipariş eklendi
        const newOrder = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);

        // WA Bildirimi
        const axios = require('axios');
        const { ADMIN_PHONE, WA_SERVER, SITE_URL } = require('../config');
        
        // Müşteriye Mesaj
        if (newOrder.phone) {
            axios.post(`${WA_SERVER}/send`, {
                phone: newOrder.phone,
                message: `Sayın ${newOrder.name},\n\nDreamStudio'ya başvurduğunuz için teşekkür ederiz. Talebiniz sistemimize başarıyla kaydedilmiştir.\n\n— Talep Detayları —\nAraç: ${newOrder.car}\nHizmet: ${newOrder.service}\nPaket: ${newOrder.package || '-'}\nTakip Kodu: ${newOrder.code}\n\n— Ödeme Bilgileri —\nBanka: Akbank Altunizade\nHesap Sahibi: Celalettin Yabuz\nİBAN: TR96 0004 6008 6688 8000 0775 26\nAçıklama: ${newOrder.code}\n\nÖdemenizi gerçekleştirdikten sonra süreciniz başlatılacak olup en kısa sürede ekibimiz sizinle iletişime geçecektir.\n\nSipariş takibinizi aşağıdaki bağlantı üzerinden yapabilirsiniz:\n${SITE_URL}/track?code=${newOrder.code}\n\nSaygılarımızla,\nDreamStudio Tasarım & Üretim`
            }).catch(e => console.error('WA Müşteri Mesaj Hatası:', e.message));
        }

        // Admine Mesaj
        axios.post(`${WA_SERVER}/send`, {
            phone: ADMIN_PHONE,
            message: `[YENİ TALEP]\n\nMüşteri: ${newOrder.name}\nTelefon: ${newOrder.phone}\nAraç: ${newOrder.car}\nHizmet: ${newOrder.service}\nPaket: ${newOrder.package || '-'}\nNot: ${newOrder.note || '-'}\nKod: ${newOrder.code}\n\nPanel: ${SITE_URL}/admin/orders`
        }).catch(e => console.error('WA Admin Mesaj Hatası:', e.message));

        res.json({
            success: true,
            code: code,
            order: newOrder
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

router.get('/track', (req, res) => {
    const code = req.query.code;
    if (!code) return res.json({ success: false, error: 'Kod gönderilmedi' });
    
    try {
        const order = db.prepare("SELECT * FROM orders WHERE code = ?").get(code);
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
