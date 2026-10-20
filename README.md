# 轻小说作家的人生 · 中文版（含联机后端）

日式双六棋盘游戏《轻小说作家的人生》（原「ラノベ作家の人生」）的中文版，附一套部署在 Cloudflare 上的联机后端。

## 架构

```
浏览器（房主）                      Cloudflare Worker + Durable Object
  ├─ game.js 跑完整游戏引擎  ──state──▶  Room（房间）
  │   广播状态快照                      ├─ 成员/准备/设置
  └─ 接收其他玩家的指令      ◀──cmd────  └─ WebSocket 中继
浏览器（其他玩家）
  └─ online.js 只负责渲染快照 + 发指令
```

- **房主权威**：房主的浏览器运行真正的游戏逻辑，其他人只是「遥控器 + 显示器」。这样不需要把 5 万行的游戏引擎搬到服务端。
- **Durable Object** 负责房间成员、准备状态、设置、回合序号与消息中继，并保存最近一份状态快照，刷新页面后可续上。
- 房间 24 小时无更新自动回收；断线可用同一浏览器（localStorage 里的 uid）重新回到原座位。

## 目录

```
wrangler.toml         Worker + 静态资源 + Durable Object 绑定
package.json          wrangler 依赖与脚本
src/worker.js         后端：路由 /api/ws → Durable Object Room
public/index.html     游戏页面（中文）
public/game.js        游戏引擎（中文）
public/online.js      联机层：房间 UI + 引擎入口接管
public/style.css      样式
public/art、audio     插画与 BGM
public/_headers       静态资源缓存策略
```

## 部署（GitHub → Cloudflare Workers）

> 注意：这是 **Workers** 项目（带 Durable Object），不是 Pages。Pages 不支持 Durable Object。

1. 把本目录**全部内容**推到 GitHub 仓库根目录（`wrangler.toml` 必须在根目录）。
2. Cloudflare Dashboard → **Workers & Pages** → **Create** → **Workers** → **Connect to Git**，选择该仓库。
3. 构建设置：
   - Build command：`npm install`
   - Deploy command：`npx wrangler deploy`
4. Deploy。首次部署会自动创建 Durable Object 命名空间（迁移 `v1`）。
5. 打开 `https://<worker名>.<子域>.workers.dev` 即可。

之后每次 push 会自动重新构建部署。

### 命令行部署（可选）

```bash
npm install
npx wrangler login
npx wrangler deploy
```

本地调试：`npx wrangler dev`，然后访问 http://localhost:8787 。

## 使用

- 点「在线对战」→「创建房间」，把邀请链接发给朋友；或用房间代码加入。
- 房主可「添加CPU」「保存设置」，全员「准备完成」后由房主「用这些成员开始」。
- 点击顶部 ONLINE 状态条的「房间・邀请链接」随时查看房间与邀请链接。
- 手牌对全员公开（与原作一致），但陷阱设置位置不显示给其他玩家。

## 限制

- 房主关闭页面时对局暂停，其余玩家会看到「房主不在线」；房主回来即可继续。
- 免费计划即可运行（Durable Object 使用 SQLite 存储）；WebSocket 数量与 CPU 时间受免费额度限制。
- 联机时其他玩家的动画由各自浏览器本地补间，房主每帧广播的是逻辑状态。

## 本地已验证

- 单机模式：2〜8 人（含 CPU）完整对局、掷骰、道具、陷阱、悬停详情、结算，无控制台报错。
- 联机前端：创建房间 → 等候室 → 添加 CPU → 开始 → 棋盘同步 → 重开房间面板，全流程通过（用浏览器内模拟服务端验证）。
