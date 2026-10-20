// 轻小说作家的人生 —— 联机后端（Cloudflare Worker + Durable Object）
// 房间与消息中继：房主浏览器运行游戏引擎并广播状态，其余玩家只发送指令、接收状态。

const ROOM_TTL = 24 * 60 * 60 * 1000;
const MAX_MEMBERS = 8;

const defaultSettings = () => ({
  tileCount: 24,
  target: 100,
  victoryMode: 'instant',
  turnLimitEnabled: true,
  turnLimit: 25,
  allowNegative: false,
});

const rid = (n = 8) => {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
};

const clampInt = (v, min, max, fallback = min) => {
  const n = Number(v);
  return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

const cleanName = (v) => String(v ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 14);

const cleanSettings = (input) => {
  const s = defaultSettings();
  if (!input || typeof input !== 'object') return s;
  return {
    tileCount: clampInt(input.tileCount, 12, 36, 24),
    target: Number.isFinite(Number(input.target)) && Number(input.target) > 0 ? Number(input.target) : 100,
    victoryMode: input.victoryMode === 'goal' ? 'goal' : 'instant',
    turnLimitEnabled: input.turnLimitEnabled !== false,
    turnLimit: clampInt(input.turnLimit, 1, 9999, 25),
    allowNegative: input.allowNegative === true,
  };
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/ws') return openSocket(request, env, url);
    return env.ASSETS.fetch(request);
  },
};

function openSocket(request, env, url) {
  if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
    return new Response('需要 WebSocket 连接', { status: 426 });
  }
  let id = (url.searchParams.get('room') || '').trim().toLowerCase();
  if (!id || id === 'new') id = rid(6);
  if (!/^[a-f0-9]{4,32}$/.test(id)) return new Response('房间代码无效', { status: 400 });
  const stub = env.ROOM.get(env.ROOM.idFromName(id));
  return stub.fetch(new Request(`https://room/${id}`, request));
}

export class Room {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.room = null;
    this.roomId = '';
    this.savedAt = 0;
  }

  async fetch(request) {
    this.roomId = new URL(request.url).pathname.slice(1) || 'room';
    await this.load();
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async load() {
    if (this.room) return this.room;
    this.room = (await this.ctx.storage.get('room')) || {
      id: this.roomId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: 'lobby',
      capacity: MAX_MEMBERS,
      hostId: null,
      settings: defaultSettings(),
      members: [],
      seq: 0,
      lastState: null,
    };
    return this.room;
  }

  async save(force = true) {
    this.room.updatedAt = Date.now();
    if (!force && Date.now() - this.savedAt < 2000) return;
    this.savedAt = Date.now();
    await this.ctx.storage.put('room', this.room);
    await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL);
  }

  pub() {
    const r = this.room;
    return {
      id: r.id,
      status: r.status,
      capacity: r.capacity,
      hostId: r.hostId,
      settings: r.settings,
      seq: r.seq,
      members: r.members.map((m) => ({
        id: m.id,
        name: m.name,
        piece: m.piece,
        cpu: !!m.cpu,
        ready: !!m.ready,
        online: m.online !== false,
      })),
    };
  }

  send(ws, payload) {
    try {
      ws.send(JSON.stringify(payload));
    } catch {}
  }

  broadcast(payload, except) {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      this.send(ws, payload);
    }
  }

  memberOf(ws) {
    const attachment = ws.deserializeAttachment?.();
    if (!attachment?.memberId) return null;
    return this.room.members.find((m) => m.id === attachment.memberId) || null;
  }

  socketOf(memberId) {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.deserializeAttachment?.()?.memberId === memberId) return ws;
    }
    return null;
  }

  isHost(ws) {
    const member = this.memberOf(ws);
    return !!member && member.id === this.room.hostId;
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== 'string' || raw.length > 512 * 1024) return;
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    await this.load();
    try {
      switch (msg.t) {
        case 'hello':
          return await this.onHello(ws, msg);
        case 'ready':
          return await this.onReady(ws, msg);
        case 'settings':
          return await this.onSettings(ws, msg);
        case 'cpu':
          return await this.onCpu(ws);
        case 'remove':
          return await this.onRemove(ws, msg);
        case 'start':
          return await this.onStart(ws);
        case 'restart':
          return await this.onRestart(ws);
        case 'leave':
          return await this.onLeave(ws);
        case 'cmd':
          return this.onCommand(ws, msg);
        case 'state':
          return await this.onState(ws, msg);
        case 'ping':
          return this.send(ws, { t: 'pong' });
      }
    } catch {
      this.send(ws, { t: 'error', message: '服务器处理失败，请重试。' });
    }
  }

  async onHello(ws, msg) {
    const room = this.room;
    const uid = String(msg.uid || '').slice(0, 64);
    const name = cleanName(msg.name) || '作家';
    const piece = clampInt(msg.piece, 0, 5, 0);
    const existing = uid ? room.members.find((m) => !m.cpu && m.uid === uid) : null;

    if (room.status !== 'lobby') {
      if (!existing) return this.send(ws, { t: 'error', message: '该游戏已经开始，无法加入。', code: 'started' });
      existing.name = name;
      existing.piece = piece;
      existing.online = true;
      ws.serializeAttachment({ memberId: existing.id });
      await this.save();
      this.send(ws, { t: 'welcome', memberId: existing.id, room: this.pub() });
      this.broadcast({ t: 'room', room: this.pub() });
      if (room.status === 'playing' && room.lastState) {
        this.send(ws, { t: 'state', state: room.lastState, seq: room.seq });
      }
      return;
    }

    let member = existing;
    if (member) {
      member.name = name;
      member.piece = piece;
      member.online = true;
    } else {
      if (room.members.length === 0) room.capacity = clampInt(msg.capacity, 2, MAX_MEMBERS, 8);
      if (room.members.length >= room.capacity) return this.send(ws, { t: 'error', message: '房间已满。' });
      member = { id: rid(8), uid, name, piece, cpu: false, ready: false, online: true };
      room.members.push(member);
      if (!room.hostId) room.hostId = member.id;
    }
    ws.serializeAttachment({ memberId: member.id });
    await this.save();
    this.send(ws, { t: 'welcome', memberId: member.id, room: this.pub() });
    this.broadcast({ t: 'room', room: this.pub() });
  }

  async onReady(ws, msg) {
    if (this.room.status !== 'lobby') return;
    const member = this.memberOf(ws);
    if (!member || member.cpu) return;
    member.ready = !!msg.ready;
    await this.save();
    this.broadcast({ t: 'room', room: this.pub() });
  }

  async onSettings(ws, msg) {
    if (!this.isHost(ws) || this.room.status !== 'lobby') return;
    this.room.settings = cleanSettings(msg.settings);
    await this.save();
    this.broadcast({ t: 'room', room: this.pub() });
  }

  async onCpu(ws) {
    if (!this.isHost(ws) || this.room.status !== 'lobby') return;
    const room = this.room;
    if (room.members.length >= room.capacity) return;
    const used = new Set(room.members.map((m) => m.piece));
    let piece = 0;
    while (used.has(piece) && piece < 5) piece++;
    const count = room.members.filter((m) => m.cpu).length + 1;
    room.members.push({ id: rid(8), uid: null, name: `CPU ${count}`, piece, cpu: true, ready: true, online: true });
    await this.save();
    this.broadcast({ t: 'room', room: this.pub() });
  }

  async onRemove(ws, msg) {
    if (!this.isHost(ws) || this.room.status !== 'lobby') return;
    const target = this.room.members.find((m) => m.id === msg.memberId);
    if (!target || target.id === this.room.hostId) return;
    this.room.members = this.room.members.filter((m) => m !== target);
    const socket = this.socketOf(target.id);
    if (socket) {
      this.send(socket, { t: 'kicked' });
      try {
        socket.close(4000, 'removed');
      } catch {}
    }
    await this.save();
    this.broadcast({ t: 'room', room: this.pub() });
  }

  async onStart(ws) {
    if (!this.isHost(ws)) return;
    const room = this.room;
    if (room.status === 'playing') return;
    if (room.members.length < 2) return this.send(ws, { t: 'error', message: '至少需要2名玩家。' });
    if (room.members.some((m) => !m.cpu && m.id !== room.hostId && !m.ready)) {
      return this.send(ws, { t: 'error', message: '还有玩家没有准备完成。' });
    }
    room.status = 'playing';
    room.seq = 0;
    room.lastState = null;
    room.members.forEach((m) => {
      if (!m.cpu) m.ready = false;
    });
    await this.save();
    this.broadcast({ t: 'start', room: this.pub(), settings: room.settings });
  }

  async onRestart(ws) {
    if (!this.isHost(ws)) return;
    const room = this.room;
    room.status = 'lobby';
    room.seq = 0;
    room.lastState = null;
    room.members.forEach((m) => {
      m.ready = !!m.cpu;
    });
    await this.save();
    this.broadcast({ t: 'restart', room: this.pub() });
    this.broadcast({ t: 'room', room: this.pub() });
  }

  async onLeave(ws) {
    const member = this.memberOf(ws);
    if (!member) return;
    this.room.members = this.room.members.filter((m) => m !== member);
    ws.serializeAttachment({});
    this.send(ws, { t: 'left' });
    if (this.room.members.length === 0) {
      await this.ctx.storage.deleteAll();
      this.room = null;
      this.roomId = '';
      try {
        ws.close(4000, 'left');
      } catch {}
      return;
    }
    if (this.room.hostId === member.id) {
      const next = this.room.members.find((m) => !m.cpu);
      this.room.hostId = next ? next.id : null;
    }
    await this.save();
    this.broadcast({ t: 'room', room: this.pub() });
  }

  onCommand(ws, msg) {
    const room = this.room;
    if (room.status !== 'playing') return;
    const member = this.memberOf(ws);
    if (!member || member.cpu) return;
    const hostWs = this.socketOf(room.hostId);
    if (!hostWs) return this.send(ws, { t: 'error', message: '房主不在线，游戏已暂停。' });
    this.send(hostWs, { t: 'cmd', cmd: msg.cmd, from: member.id, seq: room.seq });
  }

  async onState(ws, msg) {
    const room = this.room;
    if (!this.isHost(ws) || room.status !== 'playing') return;
    if (!msg.state || typeof msg.state !== 'object') return;
    room.seq += 1;
    room.lastState = msg.state;
    this.broadcast({ t: 'state', state: msg.state, seq: room.seq }, ws);
    await this.save(false);
  }

  async webSocketClose(ws) {
    await this.load();
    const member = this.memberOf(ws);
    if (!member) return;
    member.online = false;
    if (this.room.status === 'lobby' && this.room.hostId === member.id) {
      const next = this.room.members.find((m) => !m.cpu && m.online && m.id !== member.id);
      if (next) this.room.hostId = next.id;
    }
    await this.save();
    this.broadcast({ t: 'room', room: this.pub() });
  }

  async webSocketError(ws) {
    return this.webSocketClose(ws);
  }

  async alarm() {
    await this.load();
    const online = this.ctx.getWebSockets().length > 0;
    if (online) return this.ctx.storage.setAlarm(Date.now() + ROOM_TTL);
    if (Date.now() - (this.room?.updatedAt ?? 0) < ROOM_TTL) {
      return this.ctx.storage.setAlarm(Date.now() + ROOM_TTL);
    }
    await this.ctx.storage.deleteAll();
    this.room = null;
  }
}
