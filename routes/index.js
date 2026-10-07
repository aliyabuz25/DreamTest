const express = require('express');
const router = express.Router();
const db = require('../db');

// Ziyaretçi loglama middleware
const logVisitor = (req, res, next) => {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const page = req.originalUrl;
    try {
        db.prepare("INSERT INTO visitors (ip, page) VALUES (?, ?)").run(ip, page);
    } catch (e) {
        console.error("Visitor log error:", e);
    }
    next();
};

router.get('/', logVisitor, (req, res) => {
    res.render('index');
});

router.get('/track', logVisitor, (req, res) => {
    const code = req.query.code;
    let order = null;
    let error = null;

    if (code) {
        try {
            order = db.prepare("SELECT * FROM orders WHERE code = ?").get(code.trim().toUpperCase());
            if (!order) {
                // Küçük harfle de dene
                order = db.prepare("SELECT * FROM orders WHERE code = ?").get(code.trim());
            }
            if (!order) {
                error = 'Sipariş bulunamadı. Lütfen kodunuzu kontrol edin.';
            }
        } catch (e) {
            error = 'Bir hata oluştu.';
        }
    }
    res.render('track', { order, code, error });
});

module.exports = router;
