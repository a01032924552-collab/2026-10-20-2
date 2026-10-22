'use strict';
// 联机对战：房主浏览器运行游戏引擎并广播状态，其余玩家发送指令、接收状态。
// 传输层为 Cloudflare Worker + Durable Object 的 WebSocket 房间。

let netRoom = null;
let netMember = null;
let netWs = null;
let netSeq = 0;
let netError = '';
let netBusy = false;
let netDraft = null;
let netGeneration = 0;
let netPublishTimer = null;
let netRemoteBusy = false;

const netLocal = { render, schedule, roll, next, useCard, discardCard };

const netStore = {
  get(key, fallback = '') {
    try {
      return localStorage.getItem(key) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {}
  },
};

function netUid() {
  let uid = netStore.get('nl-uid');
  if (!uid) {
    uid = crypto.randomUUID();
    netStore.set('nl-uid', uid);
  }
  return uid;
}

function netIsHost() {
  return !!(netRoom && netMember && netRoom.hostId === netMember.id);
}

function netActor() {
  return state ? state.players[controlIndex(state)] : null;
}

function netMine() {
  if (!netRoom || netRoom.status !== 'playing' || !netMember || !state) return false;
  const actor = netActor();
  return !!actor && !actor.cpu && actor.memberId === netMember.id;
}

function netSend(payload) {
  if (netWs && netWs.readyState === 1) {
    try {
      netWs.send(JSON.stringify(payload));
    } catch {}
  }
}

function netInvite() {
  const url = new URL(location.pathname, location.origin);
  url.search = '';
  url.searchParams.set('room', netRoom.id);
  return url.href;
}

function netShowError(message) {
  netError = message || '';
  const box = $('onlineError');
  if (box) box.textContent = netError;
  netRenderBar();
}

// ---------- 场景 1：进入房间 ----------
function netEntry(code = '') {
  const name = netStore.get('nl-name', '作家');
  const piece = Number(netStore.get('nl-piece', '0')) || 0;
  $('onlineContent').innerHTML = `<small>ONLINE TABLE</small><h2>即使相隔千里，也共享同一个故事。</h2><p>2～8人。CPU也可参加。最先创建房间的人担任房主，由房主的浏览器推进游戏。</p><label>作家名字<input id="netName" value="${esc(name)}" maxlength="14" autocomplete="nickname"></label><label>国际象棋棋子<select id="netPiece">${pieces
    .map((p, i) => `<option value="${i}" ${i === piece ? 'selected' : ''}>${p.name}</option>`)
    .join('')}</select></label><label>招募人数（含自己・CPU）<select id="netCapacity">${[2, 3, 4, 5, 6, 7, 8]
    .map((n) => `<option value="${n}" ${n === 8 ? 'selected' : ''}>${n}名</option>`)
    .join('')}</select></label><div class="net-entry-actions"><button class="primary" id="netCreate">创建房间</button></div><label>邀请链接或房间代码<input id="netCode" value="${esc(code)}" placeholder="粘贴邀请链接" autocomplete="off"></label><button id="netJoin">加入此房间</button><p class="muted">房间在最后更新24小时后过期。刷新页面时，同一浏览器可用原身份回到房间。</p>`;
  $('netCreate').onclick = () => netEnter(true);
  $('netJoin').onclick = () => netEnter(false);
}

function netEnter(create) {
  const name = ($('netName').value || '').trim().slice(0, 14) || '作家';
  const piece = Number($('netPiece').value) || 0;
  const capacity = Number($('netCapacity')?.value) || 8;
  let code = '';
  if (!create) {
    let raw = $('netCode').value.trim();
    try {
      raw = new URL(raw).searchParams.get('room') || raw;
    } catch {}
    code = raw.toLowerCase();
    if (!/^[a-f0-9]{6,32}$/.test(code)) return netShowError('请输入邀请链接或房间代码。');
  }
  netStore.set('nl-name', name);
  netStore.set('nl-piece', String(piece));
  netConnect(create ? 'new' : code, { t: 'hello', name, piece, capacity, uid: netUid() });
}

function netConnect(roomCode, hello) {
  netCloseSocket();
  netError = '';
  if (location.protocol !== 'https:' && location.protocol !== 'http:') {
    netShowError('联机需要通过部署后的 https 网址访问；直接双击打开本地文件无法联机（单机模式不受影响）。');
    return;
  }
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  let ws;
  try {
    ws = new WebSocket(`${scheme}//${location.host}/api/ws?room=${encodeURIComponent(roomCode)}`);
  } catch {
    netShowError('无法创建联机连接，请确认是通过部署后的网址访问。');
    return;
  }
  netWs = ws;
  netShowError('');
  const timeout = setTimeout(() => {
    if (ws.readyState !== 1) {
      try {
        ws.close();
      } catch {}
      netShowError('连接超时，请检查网络后重试。');
    }
  }, 12000);
  ws.onopen = () => {
    clearTimeout(timeout);
    if (netWs !== ws) return;
    try {
      ws.send(JSON.stringify(hello));
    } catch {}
  };
  ws.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    netOnMessage(msg);
  };
  ws.onclose = () => {
    clearTimeout(timeout);
    if (netWs !== ws) return;
    netWs = null;
    if (netRoom) {
      netError = '连接已断开，刷新页面可重连';
      netRenderBar();
    }
  };
  ws.onerror = () => netShowError('无法连接到联机服务器。请确认项目是以 Cloudflare Workers（不是 Pages）部署，且 Durable Object 绑定已生效。');
}

function netCloseSocket() {
  if (netWs) {
    const ws = netWs;
    netWs = null;
    try {
      ws.close();
    } catch {}
  }
}

// ---------- 场景 2：等候室 ----------
function netSettingsHTML(config, disabled = false) {
  return `<fieldset class="victory-settings" id="netSettings"><legend>游戏设置</legend><label>棋盘格数<input id="netTiles" type="number" min="12" max="36" step="1" value="${config.tileCount ?? 24}" ${disabled ? 'disabled' : ''}></label><label>目标幸福点数<input id="netTarget" type="number" min="0" step="any" value="${config.target}" ${disabled ? 'disabled' : ''}></label><label>胜利时机<select id="netVictory" ${disabled ? 'disabled' : ''}><option value="instant" ${config.victoryMode === 'instant' ? 'selected' : ''}>达成目标即获胜</option><option value="goal" ${config.victoryMode === 'goal' ? 'selected' : ''}>达成目标后到达终点</option></select></label><label>回合数限制<select id="netCap" ${disabled ? 'disabled' : ''}><option value="yes" ${config.turnLimitEnabled ? 'selected' : ''}>有</option><option value="no" ${!config.turnLimitEnabled ? 'selected' : ''}>无</option></select></label><label>限制回合数<input id="netLimit" type="number" min="1" max="10000" step="1" value="${config.turnLimit}" ${disabled ? 'disabled' : ''}></label><label>幸福点数允许负分<select id="netNegative" ${disabled ? 'disabled' : ''}><option value="no" ${!config.allowNegative ? 'selected' : ''}>无</option><option value="yes" ${config.allowNegative ? 'selected' : ''}>有</option></select></label></fieldset>`;
}

function netReadSettings() {
  return {
    tileCount: Number($('netTiles').value),
    target: Number($('netTarget').value),
    victoryMode: $('netVictory').value,
    turnLimitEnabled: $('netCap').value === 'yes',
    turnLimit: Number($('netLimit').value),
    allowNegative: $('netNegative').value === 'yes',
  };
}

function netRenderLobby() {
  if (!netRoom || !$('onlineDialog').open) return;
  const r = netRoom;
  const lobby = r.status === 'lobby';
  const isHost = netIsHost();
  const me = r.members.find((m) => m.id === netMember.id);
  const finished = !!state?.winner;
  $('onlineContent').innerHTML = `<small>ONLINE TABLE · ${r.members.length}/${r.capacity}</small><h2>${lobby ? '作家们的等候室' : finished ? '故事的，之后' : '在线对战中'}</h2>${
    lobby
      ? `<div class="invite-row"><input id="netInvite" readonly value="${esc(netInvite())}" aria-label="邀请链接"><button id="netCopy">复制邀请链接</button></div><p class="net-room-code">房间代码：${r.id}</p>`
      : ''
  }<div class="net-members">${r.members
    .map(
      (m, i) =>
        `<div>${pieceIcon(m.piece, colors[i % colors.length])}<strong>${esc(m.name)}</strong><small>${m.cpu ? 'CPU' : m.id === netMember.id ? '你' : ''}${m.id === r.hostId ? '・房主' : ''}${
          !m.cpu && m.online === false ? '・离线' : ''
        }</small><span>${lobby ? (m.cpu || m.ready ? '✓ 已准备' : '准备中') : ''}</span>${
          lobby && isHost && m.id !== r.hostId
            ? `<button data-net-remove="${m.id}" aria-label="将${esc(m.name)}移出房间">移出</button>`
            : ''
        }</div>`,
    )
    .join('')}</div>${lobby ? netSettingsHTML(netDraft || r.settings, !isHost) : ''}<div class="net-lobby-actions">${
    lobby
      ? isHost
        ? '<button id="netSave">保存设置</button><button id="netCPU">添加CPU</button><button class="primary" id="netStart">用这些成员开始</button>'
        : `<button id="netReady" class="primary">${me?.ready ? '取消准备' : '准备完成'}</button>`
      : isHost && finished
        ? '<button class="primary" id="netRestart">原班人马再来一局</button>'
        : ''
  }<button id="netLeave">退出房间</button></div><p class="muted">${
    lobby
      ? '全员准备后由房主开始。手牌对全员公开，但陷阱的设置位置保密。'
      : '回合、骰点、卡片、得分与全员共享。房主负责推进游戏并自动代打CPU。房主关闭页面时游戏暂停。'
  }</p>`;
  $('netCopy').onclick = async () => {
    try {
      await navigator.clipboard.writeText(netInvite());
      $('netCopy').textContent = '已复制';
    } catch {
      $('netInvite').select();
      $('netCopy').textContent = '已选中链接';
    }
  };
  $('netLeave').onclick = () => netSend({ t: 'leave' });
  if ($('netCPU')) $('netCPU').onclick = () => netSend({ t: 'cpu' });
  if ($('netStart')) $('netStart').onclick = () => netSend({ t: 'start' });
  if ($('netReady')) $('netReady').onclick = () => netSend({ t: 'ready', ready: !me?.ready });
  if ($('netRestart')) $('netRestart').onclick = () => netSend({ t: 'restart' });
  if ($('netSave')) {
    $('netSave').onclick = () => {
      netDraft = null;
      netSend({ t: 'settings', settings: netReadSettings() });
    };
    $('netSettings').oninput = () => {
      netDraft = netReadSettings();
    };
  }
  $('onlineContent').querySelectorAll('[data-net-remove]').forEach((b) => {
    b.onclick = () => netSend({ t: 'remove', memberId: b.dataset.netRemove });
  });
}

// ---------- 场景 3：对局中 ----------
function netRenderBar() {
  const bar = $('onlineBar');
  if (!bar) return;
  bar.hidden = !netRoom;
  if (!netRoom) return;
  const mine = netMine();
  const actor = netActor();
  bar.innerHTML = `<span>● ONLINE <strong>${netRoom.members.length}/${netRoom.capacity}人的牌桌</strong> ${
    netRoom.status === 'lobby'
      ? '等待玩家加入'
      : state?.winner
        ? '对局结束'
        : mine
          ? '你的回合'
          : actor
            ? '其他作家的回合'
            : '同步中…'
  }</span><span class="net-connection">${esc(netError || '已连接')}</span><button id="netManage">房间・邀请链接</button>`;
  $('netManage').onclick = () => netOpen();
}

function netAdjust() {
  if (!netRoom) return;
  const control = netMine() && !netBusy && !netRemoteBusy;
  $('next').disabled = !control || state?.phase !== 'end';
  $('roll').disabled = !control || state?.phase !== 'pre';
  if (state?.phase === 'pre') {
    $('roll').textContent = netRoom.status !== 'playing' ? '掷骰子' : control ? '掷骰子' : netBusy ? '正在播放动画…' : netMine() ? '等待同步…' : '其他作家正在写作…';
  }
  const hand = state ? handOwner().hand : [];
  $('hand').querySelectorAll('[data-use],[data-discard]').forEach((b) => {
    const discard = b.dataset.discard !== undefined;
    const index = Number(discard ? b.dataset.discard : b.dataset.use);
    const it = items[hand[index]];
    const valid = discard ? state?.phase === 'discard' : canUseItems() && it && itemPlayable(it);
    b.disabled = !control || !valid;
  });
  netRenderBar();
}

function netSnapshot() {
  const copy = JSON.parse(JSON.stringify(state));
  ['motion', 'landingCard', 'itemGain', 'itemUse', 'reshuffling', 'cardFlights', 'relocation', 'mapSelection', 'mapPlan', 'discardAnimation'].forEach((key) => {
    delete copy[key];
  });
  return copy;
}

function netQueuePublish() {
  if (!netIsHost() || !state) return;
  clearTimeout(netPublishTimer);
  netPublishTimer = setTimeout(netPublishNow, 150);
}

function netPublishNow() {
  clearTimeout(netPublishTimer);
  if (!netIsHost() || !state || !netWs) return;
  if (!['pre', 'end', 'discard', 'won'].includes(state.phase)) {
    netPublishTimer = setTimeout(netPublishNow, 300);
    return;
  }
  netSend({ t: 'state', state: netSnapshot() });
}

function netApplyState(snapshot, seq) {
  if (netIsHost()) return;
  if (!Number.isInteger(seq) || seq <= netSeq) return;
  netSeq = seq;
  netGeneration += 1;
  epoch += 1;
  clearTimeout(timer);
  netBusy = false;
  ['motion', 'landingCard', 'itemGain', 'itemUse', 'reshuffling', 'cardFlights', 'relocation', 'mapSelection', 'mapPlan', 'discardAnimation'].forEach((key) => {
    delete snapshot[key];
  });
  state = snapshot;
  netSetMusic(state.bgmIndex);
  if (state.winner) stopBgm();
  $('setup').close();
  if ($('onlineDialog').open) $('onlineDialog').close();
  render();
}

async function netApplyRemote(cmd, from) {
  if (!netIsHost() || !state || !cmd) return;
  const actor = state.players[controlIndex(state)];
  if (!actor || actor.memberId !== from) return;
  netRemoteBusy = true;
  try {
    if (cmd.type === 'roll') await netLocal.roll();
    else if (cmd.type === 'next') netLocal.next();
    else if (cmd.type === 'item') netLocal.useCard(cmd.index, cmd.target, true, cmd.value, cmd.destination);
    else if (cmd.type === 'discard') netLocal.discardCard(cmd.index, true);
  } finally {
    netRemoteBusy = false;
    netPublishNow();
  }
}

async function netStartHost() {
  const settings = netRoom.settings;
  const members = netRoom.members;
  epoch += 1;
  clearTimeout(timer);
  const players = shuffled(
    members.map((m, i) => ({
      name: m.name,
      cpu: !!m.cpu,
      piece: Number(m.piece) || 0,
      score: 0,
      pos: 0,
      hand: [],
      forced: null,
      nextDice: 1,
      skip: false,
      laps: 0,
      character: null,
      illnessTurns: 0,
      illnessFresh: false,
      color: colors[i % colors.length],
      memberId: m.id,
    })),
  );
  state = {
    tileCount: settings.tileCount,
    revealItems: false,
    turnLimitEnabled: !!settings.turnLimitEnabled,
    target: settings.target,
    turnLimit: settings.turnLimit,
    allowNegative: !!settings.allowNegative,
    victoryMode: settings.victoryMode,
    players,
    tiles: [],
    turn: 0,
    round: 1,
    phase: 'pre',
    log: [],
    winner: null,
  };
  course();
  bgmBag = [];
  nextBgm();
  $('setup').close();
  $('onlineDialog').close();
  log(`行动顺序：${players.map((p) => p.name).join(' → ')}`);
  log('新的作家人生开始了。');
  await startTurn();
  netPublishNow();
}

function netSetMusic(index) {
  if (!Number.isInteger(index) || index < 0) return;
  if (index === bgmIndex) {
    playBgm();
    return;
  }
  stopBgm();
  bgmIndex = index;
  if (globalThis.Audio) {
    bgmAudio = new Audio(`audio/bgm-${String(index + 1).padStart(2, '0')}.wav`);
    bgmAudio.loop = true;
    bgmAudio.volume = 0.42;
    bgmAudio.preload = 'auto';
  }
  updateBgmDisplay();
  playBgm();
}

// ---------- 消息分发 ----------
function netOnMessage(msg) {
  switch (msg.t) {
    case 'welcome': {
      netMember = { id: msg.memberId };
      netRoom = msg.room;
      netSeq = 0;
      netError = '';
      netShowError('');
      try {
        sessionStorage.setItem('nl-room', netRoom.id);
        const url = new URL(location.href);
        url.searchParams.set('room', netRoom.id);
        history.replaceState(null, '', url);
      } catch {}
      if ($('onlineDialog').open) netRenderLobby();
      netRenderBar();
      break;
    }
    case 'room': {
      const wasHost = netIsHost();
      netRoom = msg.room;
      if ($('onlineDialog').open) netRenderLobby();
      netRenderBar();
      if (wasHost !== netIsHost()) netAdjust();
      break;
    }
    case 'start': {
      netRoom = msg.room;
      netSeq = 0;
      netRenderBar();
      if (netIsHost()) netStartHost();
      else {
        $('onlineDialog').close();
        $('setup').close();
      }
      break;
    }
    case 'restart': {
      netRoom = msg.room;
      netSeq = 0;
      state = null;
      epoch += 1;
      clearTimeout(timer);
      stopBgm();
      $('gameResults').hidden = true;
      $('hand').innerHTML = '';
      if ($('onlineDialog').open) netRenderLobby();
      netRenderBar();
      break;
    }
    case 'state':
      netApplyState(msg.state, msg.seq);
      break;
    case 'cmd':
      netApplyRemote(msg.cmd, msg.from);
      break;
    case 'kicked':
      netDetach();
      $('setup').showModal();
      netShowError('你已被移出房间。');
      break;
    case 'left':
      netDetach();
      break;
    case 'error':
      netShowError(msg.message || '发生错误。');
      break;
  }
}

// ---------- 入口与退出 ----------
function netOpen(code = '') {
  if (netRoom) {
    netRenderLobby();
    netRenderBar();
  } else {
    netEntry(code);
  }
  $('onlineError').textContent = netError;
  if (!$('onlineDialog').open) $('onlineDialog').showModal();
}

function netDetach() {
  netCloseSocket();
  netRoom = null;
  netMember = null;
  netSeq = 0;
  netError = '';
  netDraft = null;
  netBusy = false;
  netGeneration += 1;
  epoch += 1;
  clearTimeout(timer);
  clearTimeout(netPublishTimer);
  state = null;
  stopBgm();
  $('onlineBar').hidden = true;
  $('onlineDialog').close();
  $('gameResults').hidden = true;
  $('onlineContent').innerHTML = '';
  $('hand').innerHTML = '';
  try {
    sessionStorage.removeItem('nl-room');
    const url = new URL(location.href);
    url.searchParams.delete('room');
    history.replaceState(null, '', url);
  } catch {}
}

// ---------- 接管引擎入口 ----------
render = () => {
  netLocal.render();
  if (netIsHost()) netQueuePublish();
  netAdjust();
};

schedule = () => {
  if (!netRoom) return netLocal.schedule();
  if (netIsHost()) return netLocal.schedule();
};

next = () => {
  if (!netRoom) return netLocal.next();
  if (netIsHost()) {
    if (!netMine() && !netActor()?.cpu) return;
    netLocal.next();
    netPublishNow();
  } else if (netMine() && !netBusy) {
    netSend({ t: 'cmd', cmd: { type: 'next' } });
  }
};

roll = async () => {
  if (!netRoom) return netLocal.roll();
  if (netIsHost()) {
    if (!netMine() && !netActor()?.cpu) return;
    await netLocal.roll();
    netPublishNow();
  } else if (netMine() && !netBusy) {
    netSend({ t: 'cmd', cmd: { type: 'roll' } });
  }
};

useCard = (index, target, auto = false, chosenValue = 6, destination = null) => {
  if (!netRoom) return netLocal.useCard(index, target, auto, chosenValue, destination);
  if (netIsHost()) {
    if (!auto && !netMine() && !netActor()?.cpu) return;
    netLocal.useCard(index, target, true, chosenValue, destination);
    netPublishNow();
    return;
  }
  if (auto || !netMine() || netBusy) return;
  netSend({ t: 'cmd', cmd: { type: 'item', index, target, value: chosenValue, destination } });
};

discardCard = (index, auto = false) => {
  if (!netRoom) return netLocal.discardCard(index, auto);
  if (netIsHost()) {
    if (!auto && !netMine() && !netActor()?.cpu) return;
    netLocal.discardCard(index, true);
    netPublishNow();
    return;
  }
  if (auto || !netMine() || netBusy) return;
  netSend({ t: 'cmd', cmd: { type: 'discard', index } });
};

// ---------- 页面初始化 ----------
(function netBoot() {
  const localNew = $('newBtn').onclick;
  $('newBtn').onclick = () => {
    if (netRoom) netOpen();
    else if (localNew) localNew();
  };
  $('onlineBtn').onclick = () => netOpen();
  $('setupOnline').onclick = () => netOpen();
  $('onlineClose').onclick = () => $('onlineDialog').close();
  const params = new URL(location.href).searchParams;
  const code = params.get('room');
  if (code) {
    let saved = '';
    try {
      saved = sessionStorage.getItem('nl-room') || '';
    } catch {}
    netOpen(code);
    if (saved === code) {
      netConnect(code, { t: 'hello', name: netStore.get('nl-name', '作家'), piece: Number(netStore.get('nl-piece', '0')) || 0, capacity: 8, uid: netUid() });
    }
  }
  document.addEventListener(
    'click',
    (event) => {
      if (!netRoom || event.target.id !== 'resultReplay') return;
      event.preventDefault();
      event.stopPropagation();
      state.resultVisible = false;
      render();
      netOpen();
    },
    true,
  );
})();
