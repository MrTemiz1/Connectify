const express  = require('express');
const http      = require('http');
const { Server } = require('socket.io');
const crypto    = require('crypto');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
    cors: { origin: '*' },
    pingTimeout: 60000
});

app.use(express.static('public'));

// ═══════════════════════════════════════════
//  IN-MEMORY DATABASE
// ═══════════════════════════════════════════
const users    = [];          // { name, email, password, customId, socketId, createdAt, lastSeen }
const usedIds  = new Set();
const pending  = [];          // contact requests: { fromId, fromName, toId, displayName, sentAt }
const blocked  = new Map();   // blockerId -> Set(blockedId)
const messages = new Map();   // conversationKey -> [msg, ...]

// ═══════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════

/** Generate a unique 4x4 hex ID */
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

/** Canonical conversation key (always same regardless of who is A/B) */
function convKey(a, b) {
    return [a, b].sort().join('::');
}

/** Find user by customId */
function byId(id) {
    return users.find(u => u.customId === id) || null;
}

/** Check if blocker has blocked target */
function isBlocked(blockerId, targetId) {
    return (blocked.get(blockerId) || new Set()).has(targetId);
}

/** Format current time */
function fmtTime() {
    return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Safe public user object (no password) */
function safeUser(u) {
    return {
        name:      u.name,
        email:     u.email,
        customId:  u.customId,
        createdAt: u.createdAt,
        lastSeen:  u.lastSeen
    };
}

// ═══════════════════════════════════════════
//  SOCKET.IO
// ═══════════════════════════════════════════
io.on('connection', (socket) => {
    console.log(`[+] Socket connected: ${socket.id}`);

    // ──────────────────────────────────────
    //  REGISTER
    // ──────────────────────────────────────
    socket.on('register', ({ name, email, password }) => {
        // Validation
        if (!name || !email || !password) {
            socket.emit('auth-error', 'All fields are required.');
            return;
        }
        if (password.length < 6) {
            socket.emit('auth-error', 'Password must be at least 6 characters.');
            return;
        }
        const emailRx = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRx.test(email)) {
            socket.emit('auth-error', 'Please enter a valid email address.');
            return;
        }
        if (users.find(u => u.email.toLowerCase() === email.toLowerCase())) {
            socket.emit('auth-error', 'This email is already registered.');
            return;
        }

        const user = {
            name:      name.trim(),
            email:     email.toLowerCase().trim(),
            password,
            customId:  genId(),
            socketId:  socket.id,
            createdAt: new Date().toISOString(),
            lastSeen:  new Date().toISOString(),
            online:    true
        };

        users.push(user);
        console.log(`[register] ${user.name} (${user.customId})`);
        socket.emit('auth-success', safeUser(user));
    });

    // ──────────────────────────────────────
    //  LOGIN
    // ──────────────────────────────────────
    socket.on('login', ({ email, password }) => {
        if (!email || !password) {
            socket.emit('auth-error', 'All fields are required.');
            return;
        }

        const user = users.find(
            u => u.email.toLowerCase() === email.toLowerCase() && u.password === password
        );

        if (!user) {
            socket.emit('auth-error', 'Wrong email or password.');
            return;
        }

        user.socketId = socket.id;
        user.online   = true;
        user.lastSeen = new Date().toISOString();

        // Deliver any pending contact requests aimed at this user
        const myPending = pending.filter(r => r.toId === user.customId);
        if (myPending.length > 0) {
            socket.emit('pending-requests', myPending);
        }

        console.log(`[login] ${user.name} (${user.customId})`);
        socket.emit('auth-success', safeUser(user));

        // Notify contacts that this user came online
        broadcastOnlineStatus(user.customId, true);
    });

    // ──────────────────────────────────────
    //  CONTACT REQUEST
    // ──────────────────────────────────────
    socket.on('contact-request', ({ fromId, fromName, toId, displayName }) => {
        if (!fromId || !toId) return;
        if (fromId === toId) {
            socket.emit('auth-error', "You can't send a request to yourself.");
            return;
        }

        const target = byId(toId);
        if (!target) {
            socket.emit('request-not-found');
            return;
        }

        // Prevent duplicate requests
        const already = pending.find(r => r.fromId === fromId && r.toId === toId);
        if (already) {
            socket.emit('request-already-sent');
            return;
        }

        // Block check: if target has blocked sender, silently fail
        if (isBlocked(toId, fromId)) {
            socket.emit('request-not-found'); // don't reveal block
            return;
        }

        const req = {
            fromId,
            fromName,
            toId,
            displayName: displayName || fromName,
            sentAt: new Date().toISOString()
        };

        pending.push(req);

        // If target is online, deliver immediately
        if (target.socketId) {
            io.to(target.socketId).emit('incoming-request', req);
        }

        socket.emit('request-sent', { toId, displayName: displayName || fromName });
        console.log(`[request] ${fromId} -> ${toId}`);
    });

    // ──────────────────────────────────────
    //  ACCEPT REQUEST
    // ──────────────────────────────────────
    socket.on('accept-request', ({ fromId, fromName, toId, toName }) => {
        // Remove from pending
        const idx = pending.findIndex(r => r.fromId === fromId && r.toId === toId);
        if (idx !== -1) pending.splice(idx, 1);

        const sender   = byId(fromId);
        const receiver = byId(toId);

        if (!sender || !receiver) return;

        // Notify the original requester
        if (sender.socketId) {
            io.to(sender.socketId).emit('request-accepted', {
                fromId:   toId,
                fromName: toName
            });
        }

        console.log(`[accept] ${toId} accepted request from ${fromId}`);
    });

    // ──────────────────────────────────────
    //  DECLINE REQUEST
    // ──────────────────────────────────────
    socket.on('decline-request', ({ fromId, toId }) => {
        const idx = pending.findIndex(r => r.fromId === fromId && r.toId === toId);
        if (idx !== -1) pending.splice(idx, 1);
        console.log(`[decline] ${toId} declined request from ${fromId}`);
    });

    // ──────────────────────────────────────
    //  BLOCK / UNBLOCK
    // ──────────────────────────────────────
    socket.on('block-user', ({ blockerId, blockedId }) => {
        if (!blocked.has(blockerId)) blocked.set(blockerId, new Set());
        blocked.get(blockerId).add(blockedId);
        console.log(`[block] ${blockerId} blocked ${blockedId}`);
    });

    socket.on('unblock-user', ({ unblockerId, unblockedId }) => {
        const set = blocked.get(unblockerId);
        if (set) set.delete(unblockedId);
        console.log(`[unblock] ${unblockerId} unblocked ${unblockedId}`);
    });

    // ──────────────────────────────────────
    //  TYPING
    // ──────────────────────────────────────
    socket.on('typing', ({ fromId, toId }) => {
        const target = byId(toId);
        if (!target || !target.socketId) return;
        // Don't relay if receiver has blocked sender
        if (isBlocked(toId, fromId)) return;
        io.to(target.socketId).emit('user-typing', { fromId });
    });

    // ──────────────────────────────────────
    //  SEND MESSAGE
    // ──────────────────────────────────────
    socket.on('send-message', ({ senderId, senderName, receiverId, text }) => {
        if (!senderId || !receiverId || !text || !text.trim()) return;

        const sender   = byId(senderId);
        const receiver = byId(receiverId);

        if (!sender || !receiver) return;

        // Block checks (both directions)
        if (isBlocked(receiverId, senderId)) return;  // receiver blocked sender
        if (isBlocked(senderId, receiverId)) return;  // sender blocked receiver

        const msgId = crypto.randomBytes(8).toString('hex');
        const msg = {
            id:         msgId,
            senderId,
            senderName,
            receiverId,
            text:       text.trim(),
            time:       fmtTime(),
            timestamp:  Date.now(),
            status:     'delivered'
        };

        // Persist message
        const key = convKey(senderId, receiverId);
        if (!messages.has(key)) messages.set(key, []);
        messages.get(key).push(msg);

        // Deliver to receiver (if online)
        if (receiver.socketId) {
            io.to(receiver.socketId).emit('receive-message', msg);
        }

        // Echo back to sender with confirmed delivery
        socket.emit('receive-message', { ...msg, status: receiver.socketId ? 'delivered' : 'sent' });

        console.log(`[msg] ${senderId} -> ${receiverId}: "${text.trim().substring(0,30)}"`);
    });

    // ──────────────────────────────────────
    //  READ RECEIPT
    // ──────────────────────────────────────
    socket.on('message-read', ({ readerId, senderId }) => {
        const sender = byId(senderId);
        if (!sender || !sender.socketId) return;
        io.to(sender.socketId).emit('message-status', { senderId: readerId, status: 'read' });
    });

    // ──────────────────────────────────────
    //  FETCH CONVERSATION HISTORY
    // ──────────────────────────────────────
    socket.on('fetch-history', ({ userId, contactId }) => {
        const key  = convKey(userId, contactId);
        const hist = messages.get(key) || [];
        socket.emit('chat-history', { contactId, messages: hist });
    });

    // ──────────────────────────────────────
    //  DELETE MESSAGE
    // ──────────────────────────────────────
    socket.on('delete-message', ({ msgId, senderId, receiverId }) => {
        const key  = convKey(senderId, receiverId);
        const hist = messages.get(key);
        if (!hist) return;

        const idx = hist.findIndex(m => m.id === msgId && m.senderId === senderId);
        if (idx === -1) return;

        hist.splice(idx, 1);

        // Notify both parties
        const receiver = byId(receiverId);
        if (receiver && receiver.socketId) {
            io.to(receiver.socketId).emit('message-deleted', { msgId });
        }
        socket.emit('message-deleted', { msgId });
    });

    // ──────────────────────────────────────
    //  PROFILE LOOKUP
    // ──────────────────────────────────────
    socket.on('lookup-user', ({ targetId, requesterId }) => {
        const target = byId(targetId);
        if (!target) {
            socket.emit('lookup-result', { found: false, targetId });
            return;
        }
        // Don't reveal if blocked
        if (isBlocked(targetId, requesterId)) {
            socket.emit('lookup-result', { found: false, targetId });
            return;
        }
        socket.emit('lookup-result', {
            found:    true,
            targetId,
            name:     target.name,
            online:   !!target.socketId,
            lastSeen: target.lastSeen
        });
    });

    // ──────────────────────────────────────
    //  DISCONNECT
    // ──────────────────────────────────────
    socket.on('disconnect', () => {
        const user = users.find(u => u.socketId === socket.id);
        if (user) {
            user.socketId = null;
            user.online   = false;
            user.lastSeen = new Date().toISOString();
            broadcastOnlineStatus(user.customId, false);
            console.log(`[-] ${user.name} (${user.customId}) disconnected`);
        } else {
            console.log(`[-] Socket disconnected: ${socket.id}`);
        }
    });
});

// ═══════════════════════════════════════════
//  BROADCAST ONLINE STATUS
// ═══════════════════════════════════════════
/**
 * Broadcast a user's online/offline status to all other connected users
 * who would realistically be in contact with them.
 * (In a real app you'd only notify contacts — here we notify everyone online.)
 */
function broadcastOnlineStatus(userId, isOnline) {
    const user = byId(userId);
    if (!user) return;
    // Emit to every connected socket except this user's own socket
    users.forEach(u => {
        if (u.socketId && u.customId !== userId) {
            io.to(u.socketId).emit('user-status', {
                userId,
                online:   isOnline,
                lastSeen: user.lastSeen
            });
        }
    });
}

// ═══════════════════════════════════════════
//  OPTIONAL: Simple REST health endpoint
// ═══════════════════════════════════════════
app.get('/health', (req, res) => {
    res.json({
        status:  'ok',
        users:   users.length,
        online:  users.filter(u => u.socketId).length,
        uptime:  process.uptime()
    });
});

// ═══════════════════════════════════════════
//  START
// ═══════════════════════════════════════════
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`\n🌐  Connectify server running on port ${PORT}\n`);
});
