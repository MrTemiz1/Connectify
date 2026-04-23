const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// ───── MEMORY DB ─────
const users = [];
const usedIds = new Set();
const requests = []; // contact requests
const blocked = new Map(); // userId -> [blockedIds]

// ───── ID GENERATOR ─────
function genId() {
    let id;
    do {
        const a = new Uint8Array(8);
        crypto.randomFillSync(a);
        const h = Array.from(a, b => b.toString(16).padStart(2, '0')).join('').toUpperCase();

        id = `${h.slice(0,4)}-${h.slice(4,8)}-${h.slice(8,12)}-${h.slice(12,16)}`;
    } while (usedIds.has(id));

    usedIds.add(id);
    return id;
}

// ───── SOCKET ─────
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // ─── REGISTER ───
    socket.on('register', ({ name, email, password }) => {
        if (users.find(u => u.email === email)) {
            socket.emit('auth-error', 'Email already exists');
            return;
        }

        const user = {
            name,
            email,
            password,
            customId: genId(),
            socketId: socket.id
        };

        users.push(user);
        socket.emit('auth-success', user);
    });

    // ─── LOGIN ───
    socket.on('login', ({ email, password }) => {
        const user = users.find(u => u.email === email && u.password === password);

        if (!user) {
            socket.emit('auth-error', 'Wrong email or password');
            return;
        }

        user.socketId = socket.id;
        socket.emit('auth-success', user);
    });

    // ─── CONTACT REQUEST ───
    socket.on('contact-request', ({ fromId, fromName, toId, displayName }) => {
        const target = users.find(u => u.customId === toId);

        if (!target) {
            socket.emit('request-not-found');
            return;
        }

        const req = { fromId, fromName, toId, displayName };

        requests.push(req);

        io.to(target.socketId).emit('incoming-request', req);
        socket.emit('request-sent', { toId, displayName });
    });

    // ─── ACCEPT REQUEST ───
    socket.on('accept-request', ({ fromId, fromName, toId, toName }) => {
        const sender = users.find(u => u.customId === fromId);
        const receiver = users.find(u => u.customId === toId);

        if (sender && receiver) {
            io.to(sender.socketId).emit('request-accepted', {
                fromId: toId,
                fromName: toName
            });
        }
    });

    // ─── DECLINE REQUEST ───
    socket.on('decline-request', ({ fromId }) => {
        const idx = requests.findIndex(r => r.fromId === fromId);
        if (idx !== -1) requests.splice(idx, 1);
    });

    // ─── BLOCK ───
    socket.on('block-user', ({ blockerId, blockedId }) => {
        if (!blocked.has(blockerId)) blocked.set(blockerId, []);
        blocked.get(blockerId).push(blockedId);
    });

    socket.on('unblock-user', ({ unblockerId, unblockedId }) => {
        const list = blocked.get(unblockerId) || [];
        blocked.set(unblockerId, list.filter(x => x !== unblockedId));
    });

    // ─── TYPING ───
    socket.on('typing', ({ fromId, toId }) => {
        const target = users.find(u => u.customId === toId);
        if (!target) return;

        io.to(target.socketId).emit('user-typing', { fromId });
    });

    // ─── MESSAGES ───
    socket.on('send-message', ({ senderId, senderName, receiverId, text }) => {
        const sender = users.find(u => u.customId === senderId);
        const receiver = users.find(u => u.customId === receiverId);

        if (!receiver || !sender) return;

        // block check
        const blockedList = blocked.get(receiverId) || [];
        if (blockedList.includes(senderId)) return;

        const msg = {
            senderId,
            senderName,
            receiverId,
            text,
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        };

        // send to receiver
        io.to(receiver.socketId).emit('receive-message', msg);

        // send back to sender
        socket.emit('receive-message', msg);
    });

    // ─── READ RECEIPT ───
    socket.on('message-read', ({ readerId, senderId }) => {
        const sender = users.find(u => u.customId === senderId);
        if (!sender) return;

        io.to(sender.socketId).emit('message-status', {
            status: 'read'
        });
    });

    // ─── DISCONNECT ───
    socket.on('disconnect', () => {
        const user = users.find(u => u.socketId === socket.id);
        if (user) user.socketId = null;
    });
});

// ───── SERVER ─────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server ${PORT} portunda çalışıyor...`);
});
