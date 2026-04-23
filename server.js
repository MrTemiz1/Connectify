const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// Bellekte tutulan veriler (Render uyarı: Sunucu uyursa bunlar silinir, 
// gerçek projede MongoDB veya PostgreSQL kullanmalısınız)
const users = []; 
const usedIds = new Set();

// Sizin istediğiniz ID oluşturma sistemi
function genId() {
    let id;
    do {
        const a = new Uint8Array(8);
        crypto.randomFillSync(a); // Node.js için uyumlu hali
        const h = Array.from(a, b => b.toString(16).padStart(2, '0'))
            .join('')
            .toUpperCase();
        id = `${h.slice(0, 4)}-${h.slice(4, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}`;
    } while (usedIds.has(id));
    usedIds.add(id);
    return id;
}

io.on('connection', (socket) => {
    console.log('Bir kullanıcı bağlandı:', socket.id);

    // KAYIT OLMA
    socket.on('register', ({ email, password }) => {
        const userExists = users.find(u => u.email === email);
        if (userExists) {
            socket.emit('auth-error', 'Bu e-posta zaten kayıtlı!');
            return;
        }
        const newUser = {
            email,
            password,
            customId: genId(),
            socketId: socket.id
        };
        users.push(newUser);
        socket.emit('auth-success', newUser);
    });

    // GİRİŞ YAPMA
    socket.on('login', ({ email, password }) => {
        const user = users.find(u => u.email === email && u.password === password);
        if (user) {
            user.socketId = socket.id;
            socket.emit('auth-success', user);
        } else {
            socket.emit('auth-error', 'Hatalı e-posta veya şifre!');
        }
    });

    // MESAJ GÖNDERME
    socket.on('send-message', ({ senderId, receiverId, text }) => {
        const targetUser = users.find(u => u.customId === receiverId);
        const msgData = { senderId, text, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) };
        
        if (targetUser) {
            io.to(targetUser.socketId).emit('receive-message', msgData);
        }
        // Kendisine de onayı gönder
        socket.emit('receive-message', msgData);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Sunucu ${PORT} portunda çalışıyor...`));
