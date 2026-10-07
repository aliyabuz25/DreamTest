const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const path = require('path');
const cors = require('cors');
const bodyParser = require('body-parser');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;

// Cloudflare / Traefik proxy desteği
app.set('trust proxy', 1);

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'admin', 'uploads')));

// View Engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Session
app.use(session({
    store: new FileStore({ path: '/tmp/sessions', retries: 1 }),
    secret: process.env.SESSION_SECRET || 'dreamstudio_secret_key_2026',
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: process.env.NODE_ENV === 'production',
        maxAge: 24 * 60 * 60 * 1000
    }
}));

// Routes
const indexRoutes = require('./routes/index');
const adminRoutes = require('./routes/admin');
const apiRoutes = require('./routes/api');

app.use('/admin', adminRoutes);
app.use('/api', apiRoutes);
app.use('/', indexRoutes);

// Start Server
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on http://0.0.0.0:${PORT}`);
});
