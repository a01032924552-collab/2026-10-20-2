# 轻小说作家的人生 · 中文版

一款 2〜8 人的圆形棋盘双六游戏：当作家、掷骰子、踩格子、抢道具，比谁先攒够幸福点数。

原站为日文版，本仓库是完整中文化的源码，并附带一套可部署到 Cloudflare 的联机后端。

## 目录结构

```
.
├── wrangler.toml       Cloudflare Workers 配置（静态资源 + Durable Object）
├── package.json
├── src/
│   └── worker.js       联机后端：WebSocket 房间、消息中继、房间回收
└── public/
    ├── index.html      游戏页面
    ├── game.js         游戏引擎（全中文）
    ├── online.js       联机界面与状态同步
    ├── style.css
    ├── art/            格子卡与道具卡插画
    └── audio/          BGM
```

## 部署到 Cloudflare（从 GitHub）

必须部署为 **Worker**，不能部署为 Pages —— Pages 不支持 Durable Objects，联机会不可用。

1. 把本目录**全部内容**推到 GitHub 仓库根目录（`wrangler.toml` 要在最外层，不要再套一层文件夹）。
2. Cloudflare Dashboard → **Workers & Pages** → **Create** → **Workers** → **Connect to Git**，选择该仓库。
3. 构建设置：
   - Build command：`npm install`
   - Deploy command：`npx wrangler deploy`
4. 保存并部署。首次部署会自动创建 Durable Object 命名空间，无需手动操作。
5. 之后每次 push 都会自动重新部署。

部署完成后得到 `https://<项目名>.<子域>.workers.dev`，直接打开即可游玩。

## 本地开发

```bash
npm install
npm run dev
```

`wrangler dev` 会同时提供静态资源与 `/api/ws` 联机接口，可完整测试联机。

> 直接双击 `public/index.html` 也能玩单机，但没有后端，联机会提示无法连接。

## 联机怎么玩

1. 打开页面 → 设置 → 点「在线创建或加入房间」。
2. 房主点「创建房间」，把邀请链接发给朋友；朋友打开链接后点「加入此房间」。
3. 房主可以添加 CPU、修改设置，等所有人准备后开始游戏。
4. 房主的浏览器运行游戏引擎并广播状态，其他玩家只发送操作指令。
5. 房间在最后活动 24 小时后自动过期。

## 玩法摘要

- 掷骰前进，踩到的格子会触发事件：重版、动画化、被网暴、生病、失踪等。
- 目标点数默认 100P，先达标者获胜；也可切换为「必须到达终点」模式。
- 道具卡可以改骰子点数、设陷阱、偷卡、重排地图等。
- 可选特殊 CPU 角色，各有独特特性（如白川京骰子为 2〜7、铃切章手牌上限 7 张）。

## 说明

- 游戏设计与美术版权归原作者所有，本仓库仅作中文化学习与个人部署使用。
- 原站的在线对战依赖其自有服务器；本仓库的联机为独立实现。
