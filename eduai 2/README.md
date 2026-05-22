# 学习坊 · Studio

学生与 AI 协作研读案例的教学平台。

## 功能

**学生端 (`/`)**
- 输入姓名即可使用（无需注册）
- 浏览教师上传的案例
- 与 Gemini AI 围绕案例对话讨论
- 也可以自由提问（无案例上下文）
- AI 被设定为"启发引导"角色，不直接给答案

**教师后台 (`/admin`)**
- 密码访问
- 概览：学生总数、消息数、案例数、案例使用频率
- 学生：每个学生的使用时长、prompt 总数、最近活跃时间
- 点击学生查看其完整对话记录（按时间排序，区分案例）
- 案例管理：上传/删除案例，支持附件（PDF/图片等）

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 复制并填写环境变量
cp .env.example .env
# 编辑 .env，填入你的 GEMINI_API_KEY 和 ADMIN_PASSWORD

# 3. 启动
npm start
```

服务器默认在 `http://localhost:3000` 启动。

- 学生端：`http://localhost:3000/`
- 教师后台：`http://localhost:3000/admin`

## 获取 Gemini API Key

在 https://aistudio.google.com/apikey 获取免费 API key，粘贴到 `.env` 的 `GEMINI_API_KEY`。

默认使用 `gemini-2.5-flash` 模型（速度快，免费额度大）。如需更强能力可在 `.env` 改为 `gemini-2.5-pro`。

## 部署

### 方式一：直接在服务器跑

任何支持 Node.js 20+ 的服务器：

```bash
# 用 PM2 管理进程
npm install -g pm2
pm2 start server/index.js --name studio
pm2 save
pm2 startup
```

配 Nginx 反向代理：

```nginx
server {
    listen 80;
    server_name your-domain.com;
    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

### 方式二：Docker

```bash
docker build -t studio .
docker run -d -p 3000:3000 \
  -e GEMINI_API_KEY=xxx \
  -e ADMIN_PASSWORD=xxx \
  -v $(pwd)/data:/app/server \
  studio
```

### 方式三：免费平台

- **Railway** / **Render** / **Fly.io**：直接连 GitHub 仓库部署，注意把 `.env` 配成平台的环境变量
- 数据库 (`server/data.db`) 和上传文件 (`server/uploads/`) 在持久卷上

## 数据

- 数据库：`server/data.db`（SQLite，自动创建）
- 上传文件：`server/uploads/`
- 备份：直接复制这两个就行

## 学生使用流程

1. 学生打开网址，输入姓名 → 直接进入主界面
2. 左侧选一个案例（或选"自由提问"）
3. 阅读案例内容，向 AI 提问
4. 关闭浏览器后，下次打开会保留登录状态（localStorage）
   - 如想换人，清浏览器数据即可

## 教师使用流程

1. 打开 `/admin`，输入 `.env` 中设置的密码
2. **上传案例**：填写标题、简介、正文、可选附件 → 发布
3. **概览**：看课堂整体数据
4. **学生**：点任一学生看完整对话记录

## 自定义 AI 教学风格

修改 `server/index.js` 中 `systemPrompt` 那段文字，可以调整 AI 的语气、引导方式、回答深度等。

## 安全提示

- `ADMIN_PASSWORD` 一定要改默认值
- 部署到公网建议加 HTTPS（用 Caddy 或 Nginx + Certbot）
- API key 只放在服务器 `.env` 里，不会暴露给学生
