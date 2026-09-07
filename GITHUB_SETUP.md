# 🚀 推送到 GitHub + Cloudflare Pages 部署指南

> 本地代码已经初始化并提交到 git,但**还需要您手动在 GitHub 创建仓库**(因为我没有您的 GitHub 账号凭证)。

## 第一步:在 GitHub 创建仓库(2 分钟)

1. 打开 https://github.com/new
2. 填写:
   - **Repository name**: `teacher-assistant`(或任何您喜欢的名字,英文)
   - **Description**: 教师个人助手 PWA 应用
   - **Public / Private**: 选 **Public**(公开)
   - **不要勾选** "Add a README file"(我们已经有本地代码了)
   - **不要勾选** "Add .gitignore"(我们已经有本地 .gitignore 了)
3. 点 **Create repository**
4. 创建成功后,GitHub 会显示一个**仓库 URL**,类似:
   - `https://github.com/您的用户名/teacher-assistant.git`

## 第二步:把 URL 告诉我

把那个 `.git` 结尾的 URL **发给我**,我会帮您运行推送命令。

或者您可以自己运行(把 `YOUR_USERNAME` 换成您的 GitHub 用户名):

```bash
cd ~/Documents/个人文件/网站部署/teacher-assistant

git remote add origin https://github.com/YOUR_USERNAME/teacher-assistant.git

git push -u origin main
```

推送时会要求您输入 GitHub 用户名和密码(或 Personal Access Token)。

## 第三步:绑定 Cloudflare Pages(5 分钟,完全免费)

1. 打开 https://dash.cloudflare.com/sign-up(没账号先注册,免费)
2. 登录后,左侧菜单选 **Workers & Pages**
3. 点 **Create application** → 选 **Pages** 标签 → 点 **Connect to Git**
4. 选择 **GitHub**,授权 Cloudflare 访问您的 GitHub
5. 选 **Select repository** → 选 `teacher-assistant` 仓库 → **Begin setup**
6. 配置构建设置:
   - **Project name**:`teacher-assistant`(这会成为您的子域名前缀)
   - **Production branch**:`main`
   - **Framework preset**:选 **Vite**(或 None 手动填)
   - **Build command**:`npm run build`
   - **Build output directory**:`dist`
7. 点 **Save and Deploy**
8. 等 1-2 分钟,Cloudflare 会给您一个永久链接:
   - `https://teacher-assistant.pages.dev`(或类似)

## 之后怎么改代码?

任何时候改代码后:

```bash
cd ~/Documents/个人文件/网站部署/teacher-assistant
git add .
git commit -m "改了啥"
git push
```

Cloudflare 会**自动检测** push 事件,1-2 分钟内自动重新部署,无需手动操作。

## 🎁 您会得到

- ✅ 代码永久存在 GitHub(不怕丢)
- ✅ 永久免费的部署链接(无限流量)
- ✅ 每次改代码自动部署
- ✅ 国内访问速度还可以
- ✅ 自动 HTTPS

---

如果中途遇到问题(比如推送失败、Cloudflare 配置错误等),把错误信息截图发给我,我帮您排错。