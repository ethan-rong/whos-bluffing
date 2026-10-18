# 明早 launch 清单（2026-10-04 周日，按先后做，每步 ≤ 5 分钟）

今晚我已做完、你不用碰的：新 logo 全套素材在 `brand/`（两张扇开的牌，正面镂空一颗转 45° 的方块）；预注册冻结为 v1（tag `prereg-v1`）；Slack 和 Discord 两个 Worker 已部署到你的 Cloudflare，数据库、`BOT_KEY`、`SALT` 都已设好，Slack 清单 `slack/manifest.yaml` 里的地址已填好；增长打法在 `docs/GROWTH_PLAYBOOK.md`，各平台上架文案在 `posts/`。

建议节奏：**周日**把账号类的事做完、装进自己的工作区和服务器试一局；**周一 09:00（纽约）**发帖。

## A. 把代码推上去（2 分钟）
1. 打开 `~/.claude/settings.json`，在 Bash 的 deny 列表里删掉含 `push` 的那一条（它拦住了我，昨晚一条 `git push` 也没推成）。
2. 终端：
   ```bash
   cd ~/howsure && git push -u origin main --tags
   ```
   推上去后 GitHub Actions 自动跑 `scripts/check.sh`。
3. 仓库改公开（建议发帖前做，不是现在也行）：
   ```bash
   gh repo edit ethan-rong/whos-bluffing --visibility public --accept-visibility-change-consequences
   ```

## B. GitHub 形象（5 分钟）
1. 用户名改成 `ethanrong`：https://github.com/settings/admin （旧链接会自动跳转）。
2. 头像：https://github.com/settings/profile → 上传 `~/Documents/Claude/2026-10-03/github-rebrand/avatar.png`（新 logo：两张扇开的牌加镂空方块，1024×1024）。
3. 个人主页 README 和项目名整理：`bash ~/Documents/Claude/2026-10-03/github-rebrand/rebrand.sh`（步骤说明在同目录 `STEPS.md`）。
4. 仓库社交预览图：仓库 Settings → Social preview → 上传 `web/public/og.png`。

## C. Slack 应用（10 分钟）
1. https://api.slack.com/apps → **Create New App** → **From an app manifest** → 选你的工作区 → 粘贴 `slack/manifest.yaml` 全文 → Next → Create。
2. **Basic Information** 里复制三样：Client ID、Client Secret、Signing Secret。
3. 终端，每条粘一个值（`SALT` 和 `BOT_KEY` 我已设好，别动）：
   ```bash
   cd ~/howsure/slack && npx wrangler secret put SLACK_CLIENT_ID
   ```
   ```bash
   cd ~/howsure/slack && npx wrangler secret put SLACK_CLIENT_SECRET
   ```
   ```bash
   cd ~/howsure/slack && npx wrangler secret put SLACK_SIGNING_SECRET
   ```
4. 同页 **Display Information**：上传图标 `brand/png/icon-512.png`，短描述粘 `posts/slack-directory.md` 的第一段。
5. **Manage Distribution** → 走完清单 → **Activate Public Distribution**。
6. 装进你的工作区：打开 https://whosbluffing-slack.rongaijun41.workers.dev/slack/oauth/start → Allow。这个地址就是 "Add to Slack" 链接。
7. 在 Slack 里试一局：
   ```
   /bluff setup #general 14
   /bluff
   ```

## D. Discord 应用（15 分钟，顺序不能乱）
1. https://discord.com/developers/applications → **New Application** → 名字 `Who's Bluffing?` → 上传图标 `brand/png/icon-512.png`，描述粘 `posts/discord-app-directory.md` 的 App description。
2. **General Information**：复制 **Application ID** 和 **Public Key**。
3. **Bot** 页：**Reset Token** → 复制 Token；打开 **Server Members Intent**。
4. 终端：先把 `discord/wrangler.toml` 里 `DISCORD_APP_ID = "REPLACE_WITH_APPLICATION_ID"` 换成 Application ID，然后：
   ```bash
   cd ~/howsure/discord && npx wrangler secret put DISCORD_PUBLIC_KEY
   ```
   ```bash
   cd ~/howsure/discord && npx wrangler secret put DISCORD_BOT_TOKEN
   ```
   ```bash
   cd ~/howsure/discord && npx wrangler deploy
   ```
5. 回到 **General Information** → **Interactions Endpoint URL** 填 `https://whosbluffing-discord.rongaijun41.workers.dev/interactions` → Save Changes（Discord 当场发两条请求验签，所以第 4 步必须先做完）。
   然后左侧 **Webhooks** 页：Endpoint URL 填 `https://whosbluffing-discord.rongaijun41.workers.dev/events`，打开 Events，勾 `APPLICATION_AUTHORIZED`（有 `APPLICATION_DEAUTHORIZED` 也勾）→ Save Changes（Discord 同样会先发一条验签请求）。作用：服务器一装 bot 就登记并发一条欢迎语，不用等有人先敲命令（细节 `discord/README.md` 第 7 步）。这一步没在真实 Discord 上验过：如果 Save 报错，跳过它照常往下做，告诉我一声，其余功能不受影响。
6. 注册命令（App ID 和 Token 只在这一条命令里用，不会存盘）：
   ```bash
   cd ~/howsure/discord && DISCORD_APP_ID=<application id> DISCORD_BOT_TOKEN=<bot token> npm run register
   ```
7. **Installation** 页：Install Link 选 **Discord Provided Link**，勾 Guild Install，scopes `bot` + `applications.commands`，权限按 `discord/README.md` 的表；用这个链接先装进你自己的测试服务器，试一下 `/bluff`。
8. 网站上的 "Add to Discord" 按钮已经指向 Worker 的 `/install`（它会跳到 Discord 的安装页），第 4 步做完它就通了，不用发我链接。

## E. 社区 Discord 服务器（10 分钟）
discord.com → 新建服务器 `Who's Bluffing? Community` → 频道按 `docs/GROWTH_PLAYBOOK.md` 的 "Support-server structure"（至少 `#announcements`、`#daily-reveal`、`#play`、`#feedback`）→ 把上面的 bot 装进去，`/bluff setup #daily-reveal 14` → 打开服务器的 Onboarding 和 Community 功能（Truth or Dare 的社区服就是靠 Server Discovery 当"找人一起玩"的入口，2.2 万人）→ 生成永久邀请链接发给我（我填进 `COMMUNITY_INVITE_URL`）。

## F. 邮箱 hello@whosbluffing.com（3 分钟）
Cloudflare 控制台 → whosbluffing.com → **Email** → **Email Routing** → 启用 → Custom addresses 新建 `hello` → 转发到你的 Gmail → 去 Gmail 点确认邮件。网站页脚已经写的是这个地址，所以这步做完邮件就通了。

## F2. 关掉 Cloudflare 自动注入的统计脚本（1 分钟）
Cloudflare 控制台 → **Analytics & Logs** → **Web Analytics** → 找到 whosbluffing.com → 关闭 automatic setup（或直接移除该站点）。原因：我们承诺无第三方脚本，页面的 CSP 本来就拦着它，留着只会在控制台报错。

## G. 上架 + 发帖（都是你发；文案在 `posts/`，改成自己的话）
研究结论先说一句：Truth or Dare Bot 不是靠发帖火的，是靠 Discord 内部的发现机制（bot 列表、App Directory、社区服、每个服务器里的自然扩散），而且它接手时已有 15.7 万个服务器。所以我们的重心是 D/E 两步做扎实、列表尽早提交、每个服务器里的体验好到有人愿意拉朋友；发帖是加分项。全文 `docs/GROWTH_PLAYBOOK.md`（(b) 16 条机制、(d) 30 天日程、(e) 可直接粘贴的英文清单）。
- **周日**：top.gg 提交（`posts/topgg-listing.md`；我们的 bot 是纯 HTTP、不显示在线，审核备注里已写明让审核员直接敲 `/bluff`；审核约一周）、discordbotlist.com 和 discords.com（`posts/discordbotlist.md`）；Discord App Directory 要等 bot 进了 75+ 个服务器通过验证后再提（`posts/discord-app-directory.md`）。
- 里程碑仪式（抄他们的）：到 100 / 1,000 / 10,000 个服务器时先发预告、再发里程碑帖并捐一笔小钱给慈善；模板在 playbook 的 "Milestone posts"。
- **周一 09:00 纽约**：Show HN（`posts/show-hn.md`）→ r/InternetIsBeautiful + r/samplesize（`posts/reddit-samplesize.md`）→ X 线程（`posts/x-launch-thread.md`）→ r/Discord_Bots（`posts/reddit-discordbots.md`）→ LessWrong / EA Forum 短帖（`posts/lesswrong.md`）→ 给 newsletter 发邮件（`posts/newsletter-email.md`）。前 6 小时每条评论都回。
- **周二**：r/Professors（`posts/reddit-professors.md`）+ 发给你认识的 3 位老师（`posts/instructor-pitch.txt`）。
- 之后 30 天按 `docs/GROWTH_PLAYBOOK.md` 的日程走；11 月 Product Hunt（`posts/producthunt.md`）。
- 规矩：只说 "source published"，不说 open source；不说 first/largest；不提 AI；只用英文。

## H. 每晚 2 分钟（上线后天天做）
```bash
cd ~/howsure/web && npm run tomorrow
```
打印明天的 10 道题和来源；有问题的题改 `daily/schedule.json` 里那一天的 id（从 `items/pool.json` 挑同类别、未排期的替换），提交。上线头两周的题逐条审查表在 `daily/LAUNCH_REVIEW.md`。

## I. 以后
- **Anki**：插件已装好（`addons21/whosbluffing`），导入 `anki/dist/WhosBluffing-Calibration-Deck-en.apkg`，每天背点东西；上传 AnkiWeb 那天：https://ankiweb.net/shared/addons/ → `anki/dist/whosbluffing.ankiaddon`。
- **iOS App**（第二阶段）：你有 Apple Developer 账号时告诉我。
- 项目的 X 或 Bluesky 账号（可选）：建好把链接给我。
