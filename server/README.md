# 教师助手 · 云端同步服务

> **不装它也能用。** 应用本身完全离线可用，数据存在各自设备的浏览器里。
> 这个服务只是多给一个选项：**把数据集中存到一个地方，换手机换电脑登录就能找回。**

---

## 先选一条路

| 你的需求 | 用哪种 |
|---|---|
| 手机和电脑同步，都在**同一个 Wi-Fi** 下 | ✅ **局域网模式**（最简单，不用买服务器、不用域名） |
| 同事在外网/不同网络也要访问 | 买云服务器走公网，继续往下看本文档 |

### 局域网模式（自己电脑当服务器）

```bash
node server/start.mjs --lan --static-dir www --data-dir data
```

它会自动：监听局域网、**生成并记住邀请码**、托管前端、打开浏览器、打印手机该访问的地址。

限制只有一条：**电脑关机、睡眠或合盖，手机就打不开了。**

发给老师的成品包见 `launcher/` 目录（含双击启动脚本与图文说明）。

---

## 它到底做什么

```
老师 A 手机 ──┐
老师 B 手机 ──┼──HTTPS──→ 你的服务器 ──→ 每人一个 JSON 文件
老师 C 电脑 ──┘              （账号隔离）
```

- 每位老师一个账号，**只能读写自己那一份**，互相看不到
- 数据是整包搬运：上传 = 送一份完整备份过去，拉取 = 取回来
- 你自己（第一个注册的账号）是**管理员**，可以列出所有老师的数据概览，也能导出他们的完整数据做汇总
- 服务端不做业务解析，只负责**存**和**按账号隔离**

**成本**：一台 2核2G 的轻量云服务器就够（几十位老师、纯文本数据）。新用户首年常见价 ¥38~99。

**合规提醒（请认真看）**：学生真实姓名属于个人信息。放到公网服务器上，**必须配 HTTPS、必须有账号鉴权、绝不能开着匿名注册**。下面每一步都是按这个标准写的。

---

## 目录里都有什么

| 文件 | 作用 |
|---|---|
| `index.mjs` | 服务主体：路由、鉴权、静态托管。**被 import 不会自动启动** |
| `store.mjs` | 持久化与密码哈希（scrypt 加盐） |
| `start.mjs` | 命令行入口：`node server/start.mjs`（`--help` 看全部参数） |
| `test.mjs` | 42 项端到端测试：`node server/test.mjs` |
| `config.example.json` | 配置模板，复制成 `config.json` 改一改 |
| `launcher/` | 发给老师的「自己电脑当服务器」成品：双击启动脚本 + 图文说明 |
| `data/` | 运行时生成：账号、会话、各人的数据包 |

零 npm 依赖，只用 Node 内置模块。

---

## 一、准备服务器

买一台轻量应用服务器，镜像选 **Ubuntu 22.04 / 24.04**（或 Debian 12）。

安全组 / 防火墙**只需要放行 22、80、443**。注意：**8787 端口不要对外开放** —— 我们让它只听 `127.0.0.1`，由反向代理转发进来，这样应用端口不直接暴露在公网。

SSH 登进去以后：

```bash
# 装 Node.js 22（NodeSource 官方源）
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v      # 应显示 v22.x
```

---

## 二、把服务传上去

在你**本机**执行（把 `你的服务器IP` 换掉）：

```bash
cd /Users/apple/Downloads/OKComputer_请假条功能优化/app

ssh root@你的服务器IP "mkdir -p /opt/teacher-cloud"

# 只传服务端代码，不用传 node_modules（本来也没有依赖）
scp server/index.mjs server/store.mjs server/start.mjs \
    server/config.example.json \
    root@你的服务器IP:/opt/teacher-cloud/
```

> 顺带把前端产物也传上去，让同一个服务既提供页面又提供接口（省掉跨域麻烦）：
> ```bash
> scp -r dist-v25/* root@你的服务器IP:/opt/teacher-cloud/www/
> ```
> 目录名必须是 `www`（下面配置里会用到）。

---

## 三、写配置

在服务器上：

```bash
cd /opt/teacher-cloud
cp config.example.json config.json
nano config.json      # 或用 vi
```

必改的两项：

```json
{
  "port": 8787,
  "host": "127.0.0.1",
  "dataDir": "./data",
  "staticDir": "./www",
  "inviteCode": "换成一串只有你和同事知道的暗号",
  "maxBlobMB": 24
}
```

| 字段 | 说明 |
|---|---|
| `inviteCode` | **注册邀请码**。只有知道它的人能注册。留空则**完全关闭注册**（老账号仍可登录）—— 同事都注册完之后，建议直接清空它 |
| `staticDir` | 顺带托管前端页面的目录；不需要的话留空 |
| `maxBlobMB` | 单个数据包上限。24 MB 相当于几十个班，够用 |
| `allowedOrigins` | 前后端不同源时才需要（如 `https://a.com,https://b.com`）。同源托管就不用填 |

---

## 四、跑起来

```bash
cd /opt/teacher-cloud
node server/start.mjs
```

看到这样的输出就成了：

```
  📚 教师助手 · 本机服务（只给这台电脑用）
  ─────────────────────────────────────────
  本机访问  http://127.0.0.1:8787
  数据目录  /opt/teacher-cloud/data
  静态托管  /opt/teacher-cloud/www
  注册状态  开启（需邀请码）
  邀请码    js-xxxxxxxx
  单包上限  24 MB
```

（加了 `--lan` 时会多出「局域网」一行，并提示手机怎么连。）

另开一个终端验证：

```bash
curl http://127.0.0.1:8787/api/health
# {"ok":true,"app":"teacher-assistant-cloud","version":"1.1.0","registrationOpen":true,...}
```

### 让它常驻（关机重启后自动拉起）

```bash
sudo tee /etc/systemd/system/teacher-cloud.service > /dev/null <<'EOF'
[Unit]
Description=Teacher Assistant Cloud Sync
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/teacher-cloud
ExecStart=/usr/bin/node server/start.mjs
Restart=always
RestartSec=5
User=root

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now teacher-cloud
sudo systemctl status teacher-cloud      # 应显示 active (running)
sudo journalctl -u teacher-cloud -f      # 看实时日志，Ctrl+C 退出
```

---

## 五、配 HTTPS（**这步不能省**）

不配 HTTPS 的话，老师的密码和数据会以**明文**在网络上传输。用 Caddy 两条命令搞定，证书自动申请、自动续期。

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

编辑 `/etc/caddy/Caddyfile`，把内容换成（域名换成你自己的）：

```
jiaoshi.你的域名.com {
    encode gzip
    reverse_proxy 127.0.0.1:8787
}
```

```bash
sudo systemctl reload caddy
```

Caddy 会自动签证书、自动跳转 https。**前提：域名已解析到这台服务器。**

> **关于备案**：如果服务器在中国大陆，绑定自己的域名需要先完成 ICP 备案，否则会被拦截。
> 想跳过备案有两个办法：用中国香港或境外机房（访问稍慢），或者暂时用 `http://服务器IP:端口` 直接访问
> —— 但后者没有 HTTPS，**不适合承载学生姓名，不建议长期这么用**。

---

## 六、让老师们开始用

1. 把地址发到群里：`https://jiaoshi.你的域名.com`
2. 老师在应用里打开 **个人设置 → ☁️ 云端同步**
3. 填服务器地址 → 点「测试连接」
4. 切到「注册新账号」→ 填账号、密码、**邀请码** → 注册
5. 点「☁️ 上传当前数据到云端」

**你自己是第一个注册的账号，自动就是管理员**，可以看所有人的数据概览。

### 换设备怎么用

新手机打开同一个网址 → 云端同步 → 登录 → 选「合并」→ 点「⬇️ 从云端拉取」→ 数据就回来了。

---

## 七、数据在哪里 / 怎么备份

```
/opt/teacher-cloud/data/
├── users.json          账号（只存 scrypt 哈希，没有明文密码）
├── sessions.json       登录会话（只存令牌的 sha256 指纹）
└── blobs/
    ├── <用户ID>.json     ← 每位老师一整包数据
    └── ...
```

定期打包备份，**并且拉到别的地方存一份**：

```bash
# 在服务器上打包
tar -czf ~/teacher-cloud-$(date +%F).tar.gz -C /opt/teacher-cloud data

# 从本机拉回来
scp root@你的服务器IP:~/teacher-cloud-*.tar.gz ./
```

想省事就写个定时任务，每周自动打包：

```bash
( crontab -l 2>/dev/null; echo "0 3 * * 1 tar -czf /root/teacher-cloud-\$(date +%F).tar.gz -C /opt/teacher-cloud data" ) | crontab -
```

---

## 八、运维速查

```bash
sudo systemctl restart teacher-cloud        # 重启
sudo journalctl -u teacher-cloud -n 100     # 看最近 100 行日志
node server/test.mjs                        # 跑一遍自检（42 项）
du -sh /opt/teacher-cloud/data              # 看数据占用
```

**改数据目录**：改 `config.json` 里的 `dataDir`，重启服务。

**踢掉所有登录**：停服务，删 `data/sessions.json`，再启动。所有人需要重新登录（数据不受影响）。

**加新老师**：如果他注册时你已经清空了 `inviteCode`，就临时把它填回去、重启、让他注册、再清空重启。

---

## 九、接口一览（想自己接别的客户端时看）

除 `/api/health`、`/api/register`、`/api/login` 外，其余都需要请求头 `Authorization: Bearer <token>`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查，返回版本与是否开放注册 |
| POST | `/api/register` | `{username, password, invite}` → `{token, user}` |
| POST | `/api/login` | `{username, password}` → `{token, user}` |
| POST | `/api/logout` | 吊销当前令牌 |
| GET | `/api/me` | 账号信息 + 云端数据概览 |
| PUT | `/api/blob` | 上传数据包：`{payload}`（payload 即应用导出的备份对象） |
| GET | `/api/blob` | 取回自己的数据包 |
| GET | `/api/admin/users` | 管理员：所有账号 + 每人数据概览 |
| GET | `/api/admin/blob/:userId` | 管理员：取某位老师的完整数据包 |
| GET | `/api/admin/stats` | 管理员：账号数、数据包数、磁盘占用 |

---

## 十、安全上做了哪些

| 项 | 做法 |
|---|---|
| 密码 | scrypt（N=16384）加盐哈希，**明文永不落盘** |
| 会话 | 令牌 64 位随机十六进制，服务端只存 sha256 指纹，有效期 60 天 |
| 账号探测 | 账号不存在时也照样跑一次 scrypt，响应耗时一致，无法用来枚举账号 |
| 暴力破解 | 登录/注册按 IP 限流（15 分钟 30 次） |
| 越权 | 数据包只用会话里的用户 ID 取，不接受客户端传的用户 ID；目录穿越已拦截 |
| 超大请求 | 超过 `maxBlobMB` 直接拒（413），不会打爆内存 |
| 注册 | 必须邀请码；可随时整体关闭 |
| 传输 | 由 Caddy 终结 TLS，Caddy 到应用是本机回环 |

**你需要自己承担的部分**：服务器系统本身要及时打补丁，SSH 建议改端口 + 禁用密码登录改密钥，别把 `data/` 目录设成公网可读。

---

## 附：本机试跑

想先不花一分钱在本地验证一遍：

```bash
cd /Users/apple/Downloads/OKComputer_请假条功能优化/app
INVITE_CODE=test123 node server/start.mjs --port 8787
```

然后在设置页里把服务器地址填成 `http://127.0.0.1:8787` 就能跑通全流程。
（本机地址会自动按 http 连接，不会强上 https。）
