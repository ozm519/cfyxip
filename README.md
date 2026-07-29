# CF 优选 IP 同步面板 (Cloudflare Worker)

> 一个文件搞定:每 15 分钟从 vps789 拉取 Cloudflare 优选 IP,自动筛选综合评分最低的 2 个,同步到华为云 DNS;IAM Token 在面板里一键登录自动获取并写入 KV,到期前自动续期。

零本地构建,零命令行,完全鼠标操作即可在 Cloudflare Dashboard 完成部署。

---

## 欢迎提出意见

本项目以"小白也能 5 分钟部署"为设计目标,但 Cloudflare Workers / 华为云 IAM / DNS API / vps789 数据源等任何一环都可能变化,实际使用中难免遇到 README 没覆盖到的情况。

**非常欢迎在 [GitHub Issues](../../issues) 提 issue**,包括但不限于:

- 部署过程中卡在哪一步、报错截图
- 面板某个按钮/弹窗不好用、文案看不懂
- 想加的新功能(比如多主机记录、Telegram 通知、自定义评分公式等)
- 文档里没说清楚的细节

反馈越具体越好(贴日志/截图/你的 region 之类),我会尽量逐条回复。**嫌开 issue 麻烦的话,提 PR 直接改 README 也完全 OK。**

---

## 项目简介

这是一个部署在 Cloudflare Workers 上的自托管工具,用于解决以下问题:

- Cloudflare 官方 IP 在国内/国际部分网络环境下速度不佳
- 第三方维护的"优选 IP"列表(本项目使用 vps789 公开 API)会随时间漂移,需要定期更新
- DNS 记录分散在多个面板(华为云、Cloudflare、阿里云...),手动维护容易出错

将本项目部署到 Cloudflare Workers 后,你会得到:

1. 一个 Web 管理面板,可视化查看当前优选 IP 候选、DNS 同步状态、Token 有效期
2. 一个定时任务(Cron Triggers),按设定频率自动拉取并同步优选 IP 到华为云 DNS
3. 一个 IAM Token 自动续期机制,在 Token 即将过期前自动用保存的账号密码换新

---

## 核心特性

| 特性 | 说明 |
| --- | --- |
| 零本地构建 | 整个项目只有一个 `worker.js` 文件,直接复制粘贴到 Cloudflare Dashboard 即可部署 |
| 单文件全栈 | HTML + CSS + React (前端) + Workers 脚本 (后端) + 华为云 DNS 客户端全部内联在一个 Worker 文件里 |
| 自动同步 | Cron Trigger 每 15 分钟自动执行一次(UTC 时区),无需人工介入 |
| 一键配置 IAM | 面板内置"自动化配置"按钮,弹窗填入华为云账号/IAM 用户/密码/region 即可自动获取 Token 并写入 KV |
| Token 自动续期 | 每次同步前检查 Token 剩余有效期,小于 1 小时时自动重新换新 |
| 可视化管理 | 面板内可手动触发同步、查看候选 IP 列表、查看 DNS A 记录、查看执行日志、清空 A 记录 |
| 数据可观测 | 执行日志保存到 KV,面板刷新即可看到历史任务输出 |
| 自带错误捕获 | 任何 import 失败、render 报错都会以红色错误条显示在页面顶部,避免白屏;正常启动日志只输出到浏览器控制台,不打扰 UI |
| 华为云国际站兼容 | API 路径与认证方式与国内站完全一致,只换 region 即可 |

---

## 工作原理

```
[Cloudflare Workers] --每 15 分钟 (Cron Trigger, UTC)--> runJob(env)
        |
        |--- 1. fetch vps789.com/openApi/cfIpApi  获取优选 IP 列表
        |--- 2. scoreIp 评分, pickBestIps 选出最低的 2 个
        |--- 3. ensureFreshToken  检查 IAM Token, 不足 1h 则自动换新
        |--- 4. listHuaWeiRecordsets  列出 zone 下所有 A 记录
        |--- 5. deleteHuaWeiRecordset  逐条删除(整个 zone 下所有 A 记录)
        |--- 6. createHuaWeiRecordset  创建 2 条新 A 记录(各 1 个新 IP)
        |
        v
[华为云 DNS] --TTL 60s--> 全球生效
```

面板内部:

```
[浏览器]
   |
   |--- 动态 import() 加载 React (esm.sh 主源 + jsdelivr 备用)
   |--- fetch /api/config       拉取当前配置(Token 状态、区域、项目、有效期)
   |--- fetch /api/ips          拉取 vps789 优选 IP 数据,只读不写
   |--- fetch /api/records      拉取 zone 下当前 A 记录
   |--- fetch /api/sync         手动触发一次同步
   |--- POST /api/auto-config   一键配置 IAM(账号+用户+密码+region)
   |--- POST /api/refresh-token 强制刷新 Token
   |--- POST /api/clear-records 清空 A 记录(按主机或整个 zone)
   |--- GET  /api/version       部署指纹自检 (FNV-1a 32-bit)
   |
   v
[Cloudflare Workers] --KV 读写--> [CF_IP_SYNC_KV]
                                       |
                                       |  存储: 华为云账号/IAM 用户/密码/region
                                       |        IAM Token 及剩余有效期
                                       |        最近一次执行日志
```

---

## 部署方法

### 前置条件

- 一个 Cloudflare 账号(免费版即可)
- 一个华为云账号,需要先在 IAM 里创建一个子用户(拥有 DNS Administrator 或 Tenant Administrator 权限)
- 知道你的域名对应的 `HUAWEI_ZONE_ID` 和要绑定优选 IP 的主机记录名 `RECORD_NAME`

### 第 1 步:创建 Worker

1. 打开 https://dash.cloudflare.com/ 并登录
2. 左侧菜单 **Workers & Pages** -> **Create application** -> **Create Worker**
3. 给项目起个名字(例如 `cf-ip-sync`),点 **Deploy**(先用默认代码部署)
4. 部署完成后点 **Edit code** 进入代码编辑器

### 第 2 步:粘贴代码

1. 在编辑器里 **Ctrl/Cmd + A** 全选、Delete 清空默认代码
2. 打开本仓库的 `worker.js`,**Ctrl/Cmd + A** 全选、**Ctrl/Cmd + C** 复制
3. 回到编辑器 **Ctrl/Cmd + V** 粘贴
4. 点右上角 **Save and Deploy**

出现 **Successfully deployed** 即可继续。

### 第 3 步:绑定 Cloudflare KV

KV 用于保存自动获取的 Token,以及最近一次执行日志。

1. 回到 Worker 详情页(不要停在代码编辑器)
2. 左侧点 **KV** -> 顶部 **Create a namespace** -> 名字填 `CF_IP_SYNC_KV` -> **Add**
3. 回到 Worker 详情 -> 左侧 **Settings** -> 顶部标签 **Bindings** -> **Add binding**
   - Variable name: `KV`
   - KV Namespace: 选择刚创建的 `CF_IP_SYNC_KV`
   - 点 **Save** 确认
4. 绑定后回到 **Code** 标签 -> 顶部 **Deploy** 按钮再部署一次(让新绑定生效)

> 没有绑定 KV 也可部署运行,但面板会一直显示"未绑定 KV"并拒绝保存自动配置。

### 第 4 步:填写基础环境变量

Worker 详情 -> **Settings** -> **Variables and Secrets** -> **Add variable**:

| Variable name | 类型 | 是否必填 | 取值示例 | 说明 |
| --- | --- | --- | --- | --- |
| `HUAWEI_ZONE_ID` | Text | 必填 | `2c9eb15...` | 域名 zone_id |
| `RECORD_NAME` | Text | 必填 | `cf.example.com.` | 主机记录 FQDN,末尾必须带点 |
| `HUAWEI_REGION` | Text | 可选 | `ap-southeast-1` | 留空时面板默认 `ap-southeast-1`(新加坡,国际站) |
| `ADMIN_KEY` | Secret | 可选 | `MySecret123` | HTTP 鉴权 key,留空则不鉴权 |
| `HUAWEI_AUTH_TOKEN` | Secret | 不填 | (留空) | 旧版手填 Token 兼容项;推荐用"自动化配置"自动管理 |
| `HUAWEI_PROJECT_ID` | Text | 不填 | (留空) | 自动化配置会自动获取并写入 KV |

> 推荐做法:只填上面 3 个必填 + 可选,其余交给面板"自动化配置"自动写入 KV。

### 第 5 步:开启每 15 分钟自动同步

1. 仍停在 **Settings** 页面
2. 左侧 **Triggers** -> **Cron Triggers** -> **Add Cron Trigger**
3. **Cron** 字段填: `*/15 * * * *`

> **时区提醒**:Cloudflare 的 Cron 表达式按 **UTC** 解析。上面这行 UTC `*/15 * * * *` 表示全天每 15 分钟一次,在北京时间(UTC+8)下其实就是每小时 8:00、8:15、8:30、8:45... 这种"看着像每 15 分钟但实际偏移 8 小时"的节奏。如果你想"**北京时间整点 8、9、10...**",Cron 表达式要改成 `0 0,8,16 * * *`(对照表见"进阶配置")。
>
> `*/15 * * * *` 与列表写法 `0,15,30,45 * * * *` 等价,Cloudflare 官方推荐前者。

4. 点 **Add**

### 第 6 步:访问面板并完成自动化配置

1. 回到 Worker 详情,点顶部 **Visit**,打开面板
2. 顶部会看到红色提示:"尚未配置"
3. 点右上角 **自动化配置** 按钮 -> 弹出华为云 IAM 登录框
4. 填入:
   - **账号名(domain)**: 你的华为云账号名(即"我的凭证"页面顶部"账号名")
   - **IAM 用户名**: 子账号的 IAM 用户名(不是主账号邮箱)
   - **IAM 密码**: 该 IAM 用户的登录密码
   - **区域 region**: 下拉选择,例如 `ap-southeast-1 (新加坡)`
5. 点 **登录并自动配置** -> 后台自动调 `iam.myhuaweicloud.com` 换 Token 并写入 KV
6. 成功后顶部出现绿色提示,账号条上会显示账号、区域、项目、Token 剩余有效期

> 之后 Worker 每 15 分钟执行同步前,若 Token 剩余小于 1 小时会自动用你保存的账号密码重新换 Token,整个流程无需人工介入。

---

## 使用办法

部署完成后,打开面板 URL(Worker 详情页顶部 **Visit**)即可开始使用。下面按"第一次使用"和"日常使用"两个阶段说明。

### 第一次使用(部署后第一次访问)

1. 打开面板,顶部会看到黄色提示条:`尚未配置:请点击右上角 "自动化配置" 填写华为云账号/IAM 用户/密码...`
2. 点击右上角 **自动化配置** 按钮,弹出 IAM 登录对话框
3. 按下表填入四项信息:

   | 字段 | 怎么填 | 示例 |
   | --- | --- | --- |
   | 账号名(domain) | 华为云控制台 -> 右上角"我的凭证" -> "账号名" 字段 | `hw1234567` |
   | IAM 用户名 | 你在 IAM 里创建的子用户名(不是主账号邮箱) | `cf-sync-bot` |
   | IAM 密码 | 该 IAM 用户的登录密码 | `YourPassword123!` |
   | 区域 region | 下拉选择,推荐 `ap-southeast-1 (新加坡)` | `ap-southeast-1` |

4. 点击 **登录并自动配置**,等待 2~5 秒。成功后:
   - 顶部出现绿色提示:`已保存 IAM 配置,Token 有效期约 23 小时 50 分`
   - 账号条上显示:`账号: cf-sync-bot@hw1234567  区域: ap-southeast-1  项目: <项目名>  Token 有效 23 小时 50 分`
   - KV 中已自动写入 Token,后续不再需要填

5. 点击面板上的 **立即同步** 按钮,触发第一次手动同步:
   - 弹出对话框显示"同步中..."
   - 几秒后右下角日志面板会逐行打印执行过程,例如:
     ```
     [开始执行优选 IP 同步任务...]
     筛选出 2 个最优 IP: 104.16.x.1, 104.16.x.2 (评分: 85.3, 92.1)
     该 zone 共 2 条 A 记录: 同名(cf.example.com.) 2 条, 其它主机 0 条
     计划删除 zone 下全部 A 记录 2 条; 计划新增 2 个 IP
     已创建 A 记录 cf.example.com. -> 104.16.x.1
     已创建 A 记录 cf.example.com. -> 104.16.x.2
     已删除 zone 下全部 A 记录 2 条
     任务完成
     ```
   - 同时面板 **当前 DNS A 记录** 表格自动刷新,显示刚写入的 2 条记录

6. 在终端用 `dig cf.example.com` 或 `nslookup cf.example.com` 验证,应能解析到刚写入的 2 个优选 IP(全球 TTL 60 秒生效)

### 日常使用

部署完成后,你**通常不需要再做任何操作**,因为:

- Cron Trigger 每 15 分钟自动跑一次,自动续期 Token、自动同步 IP
- 日志会自动追加,面板刷新即可看到

但如果你想主动干预,以下是常用操作:

| 操作 | 怎么用 | 用途 |
| --- | --- | --- |
| 手动立即同步 | 点击面板 **立即同步** 按钮 | 想立刻生效,不等下一个 15 分钟 |
| 强制刷新 Token | 点击面板 **重新获取 Token** 按钮 | 怀疑 Token 失效或刚改过 IAM 密码 |
| 查看当前 A 记录 | 点击 **刷新 DNS** | 确认华为云上当前生效的记录 |
| 查看执行日志 | 面板右下角日志面板 | 排查同步失败原因 |
| 清空 A 记录 | 顶部 **清空 A 记录** 按钮 -> 选范围 -> 输入 `CLEAR` | 出错时快速重置,或想换其它策略 |
| 修改配置 | 点击 **自动化配置** 按钮 | 改了 IAM 密码 / 切换 region / 换账号 |
| 查看使用说明 | 点击 **使用说明** 按钮 | 弹窗速查 region / 字段说明 |

### 排错流程(同步失败时)

1. 打开面板,看顶部是否有**红色错误条** -> 直接看错误信息
2. 看右下角日志面板,定位失败步骤:
   - `vps789 接口失败` -> 等 15 分钟重试,或浏览器直接访问 `https://vps789.com/openApi/cfIpApi` 验证
   - `获取 IAM Token 失败` -> 重新点 **自动化配置** 提交
   - `删除/创建 A 记录失败` -> 检查 `HUAWEI_ZONE_ID` 和 `RECORD_NAME` 是否正确,IAM 用户是否有 DNS 权限
3. 日志看不出来的话,点 **重新获取 Token** 强制换新再试
4. 还不行就到 GitHub 提 issue,把面板顶部的红色错误条截图和日志原文贴上来

### 监控建议

- 重要:在 Cloudflare Dashboard -> Workers -> 你的 Worker -> **Logs** 标签,可以看到每次 Cron 触发和 API 调用的完整日志
- 可选:用一个外部 Uptime 监控(例如 UptimeRobot)每 5 分钟访问一次 `https://<your-worker>.workers.dev/api/config?key=xxx`,若返回非 200 就告警

---

## 环境变量完整说明

### 必填项

| 变量名 | 说明 | 取值示例 |
| --- | --- | --- |
| `HUAWEI_ZONE_ID` | 华为云 DNS 中要管理的域名对应的 zone_id | `2c9eb15db3ac43a4a5d9a7f3b5a1c2d3` |

`RECORD_NAME` 在面板里通过"自动化配置"间接管理(见上),但也可以直接在环境变量里手填,只要 FQDN 末尾带点即可。

### 可选项

| 变量名 | 默认值 | 说明 |
| --- | --- | --- |
| `HUAWEI_REGION` | `ap-southeast-1` | 华为云 DNS 服务所在的 region,影响 API 端点域名 |
| `ADMIN_KEY` | (空) | 若设置,所有 `/api/*` 接口必须带 `?key=xxx` 参数,用于保护管理接口不被未授权访问 |

### 自动化配置管理的项(无需手填)

| 字段 | 存储位置 | 说明 |
| --- | --- | --- |
| `domain` | KV | 华为云账号名 |
| `username` | KV | IAM 用户名 |
| `password` | KV | IAM 密码(明文,仅保存在绑定的 KV 里) |
| `region` | KV | IAM 登录时使用的 region |
| `HUAWEI_AUTH_TOKEN` | KV | IAM 自动获取的 Token(明文 X-Auth-Token) |
| `HUAWEI_PROJECT_ID` | KV | IAM 自动获取的项目 ID |
| `expiresAt` | KV | Token 过期时间(提前 10 分钟续期) |

> 注意: 上述账号、密码、Token 全部明文保存在 Cloudflare KV 中。KV 是你的私有存储,Cloudflare 不会读取;但仍建议定期更换 IAM 密码,以及只为该 IAM 用户授予 DNS 相关权限。

### 环境变量与 KV 优先级

代码中读取配置时的优先级(高到低):

1. KV 中保存的(通过"自动化配置"写入)
2. 环境变量中的(手填的)
3. 代码中的硬编码默认值

也就是说,只要 KV 里有"自动化配置"保存的账号密码,就**完全不需要**在环境变量里手填 Token 和 Project ID。

---

## API 接口一览

所有 API 路径均以 `/api/` 开头。若设置了 `ADMIN_KEY`,所有接口必须带 `?key=xxx` 参数。

| 方法 | 路径 | 用途 | 鉴权 |
| --- | --- | --- | --- |
| GET | `/` | 返回管理面板 HTML | 否 |
| GET | `/api/config` | 查看当前生效配置(账号、区域、项目、Token 剩余有效期) | 是 |
| GET | `/api/ips` | 拉取 vps789 优选 IP 原始数据 | 是 |
| GET | `/api/records` | 查询当前 zone 下所有 A 记录 | 是 |
| GET | `/api/sync` | 立即执行一次同步 | 是 |
| POST | `/api/auto-config` | 提交华为云账号/IAM/密码/region,自动换 Token 并写 KV | 是 |
| POST | `/api/refresh-token` | 强制刷新 Token(忽略剩余有效期) | 是 |
| POST | `/api/clear-records` | 清空 A 记录(`scope` 可选 `hostname` / `zone`) | 是 |
| GET | `/api/version` | 部署指纹自检 (FNV-1a 32-bit hash + 关键标识) | 否 |
| - | Cron Trigger | 定时自动执行同步(由 Cloudflare 平台触发) | - |

### `POST /api/auto-config` 请求示例

```bash
curl -X POST "https://<your-worker>.workers.dev/api/auto-config?key=xxx" \
     -H "Content-Type: application/json" \
     -d '{
       "domain": "hw1234567",
       "username": "cf-sync-bot",
       "password": "YourIamPassword",
       "region": "ap-southeast-1"
     }'
```

返回示例:

```json
{
  "ok": true,
  "config": {
    "domain": "hw1234567",
    "username": "cf-sync-bot",
    "region": "ap-southeast-1",
    "projectId": "...",
    "projectName": "ap-southeast-1",
    "tokenExpiresAt": 1754067890123,
    "tokenRemainLabel": "23 小时 50 分"
  }
}
```

### `POST /api/clear-records` 请求示例

```bash
# 仅清当前主机记录
curl -X POST "https://<your-worker>.workers.dev/api/clear-records?key=xxx" \
     -H "Content-Type: application/json" \
     -d '{"scope":"hostname","confirm":"CLEAR"}'

# 清空整个 zone 的所有 A 记录
curl -X POST "https://<your-worker>.workers.dev/api/clear-records?key=xxx" \
     -H "Content-Type: application/json" \
     -d '{"scope":"zone","confirm":"CLEAR"}'
```

返回示例:

```json
{
  "ok": true,
  "scope": "zone",
  "count": 4,
  "deleted": [
    { "id": "rs-xxx1", "name": "cf.example.com.", "records": ["104.16.x.1"] },
    { "id": "rs-xxx2", "name": "cf.example.com.", "records": ["104.16.x.2"] },
    { "id": "rs-xxx3", "name": "www.example.com.", "records": ["1.2.3.4"] }
  ],
  "failed": [],
  "message": "已清空 4 条 A 记录(整个 zone)"
}
```

---

## 关键参数怎么查

### `HUAWEI_ZONE_ID`

- 国内站:浏览器登录后访问 `https://dns.cn-north-4.myhuaweicloud.com/v2/zones`(替换 region),搜索你的域名,记下 `id`
- 国际站:用 `https://dns.ap-southeast-1.myhuaweicloud.com/v2/zones`
- 或用 curl(替换 token/region):

```bash
curl -H "X-Auth-Token: <你的token>" \
  "https://dns.ap-southeast-1.myhuaweicloud.com/v2/zones"
```

### `RECORD_NAME`

要更新的主机记录完整域名(FQDN),末尾必须带点 `.`。例如要让 `cf.example.com` 指向优选 IP,就填 `cf.example.com.`

### 华为云账号名 / IAM 用户名

打开 https://console.huaweicloud.com/iam/#/mine/access-token 页面顶部"账号名"是 domain,登录用的"用户名"(不是邮箱)是 IAM 用户名。

> 如果只有主账号、没创建过子账号,可在华为云控制台 -> 统一身份认证 -> 左侧"用户" -> 创建用户(类型:管理控制台访问),勾上"加入用户组"并赋 DNS Administrator 或 Tenant Administrator 权限。

### Region 速查表

| 站点 | 常用 region | 备注 |
| --- | --- | --- |
| 国内站 | `cn-north-4` | 北京 |
| 国内站 | `cn-east-3` | 上海 |
| 国内站 | `cn-south-1` | 深圳 |
| 国际站 | `ap-southeast-1` | 新加坡(国际站默认) |
| 国际站 | `ap-southeast-2` | 曼谷 |
| 国际站 | `ap-southeast-3` | 马来西亚 |
| 国际站 | `ap-northeast-1` | 香港 |

> 国内站与国际站的 API 路径和认证方式完全一致,只有 region 名称不同。Token 在哪个 region 换的,`HUAWEI_PROJECT_ID` / `HUAWEI_AUTH_TOKEN` 就属于那个 region,DNS API 调用也要用同一个 region。

---

## 进阶配置

### 修改同步频率

**Settings** -> **Triggers** -> **Cron Triggers**,把 Cron 表达式改成:

> **重要:Cloudflare Cron Triggers 的 Cron 表达式统一按 UTC 解析**(不是浏览器/面板的本地时区)。下面表格里所有"UTC 时间"列就是 Cloudflare 实际执行时间,如果你在 Asia/Shanghai(UTC+8),把它对应的北京时间想清楚再设。

| 频率 | UTC Cron 表达式 | 对应北京时间(UTC+8) |
| --- | --- | --- |
| 每 5 分钟 | `*/5 * * * *` | 每 5 分钟一次,与分钟数无关(任意小时) |
| 每 15 分钟(默认) | `*/15 * * * *` | 每个小时的 8:00、8:15、8:30、8:45、9:00、9:15...(全天每 15 分钟) |
| 每 30 分钟 | `*/30 * * * *` | 每个小时的 8:00、8:30、9:00、9:30... |
| 每小时 | `0 * * * *` | 每个小时的 8:00 整(全天) |
| **北京时间每小时整点(8、9、10...)** | `0 0,8,16 * * *` | 8:00、9:00、10:00、11:00... 整点 |
| **北京时间每 15 分钟整点** | `0,15,30,45 0,8,16 * * *` | 8:00、8:15、8:30、8:45、9:00、9:15... |
| 每天北京时间 8:00 | `0 0 * * *` | 每天 8:00 整 |

> **写法说明**:`*/N` 是标准 cron 步长语法(Cloudflare 官方推荐),等价于列表写法 `0,N,2N,...`。例:`*/15 * * * *` 等价于 `0,15,30,45 * * * *`。步长语法只适用于"等间隔"的场景,跨多个不连续小时时(如上表"北京时间每小时整点")只能用列表或范围语法。

> **怎么算"北京时间"对应的 UTC Cron**:`UTC 小时 = 北京小时 - 8`,把北京时间里的每个小时都减 8(若结果 < 0 或 > 23 就拆到前/后一天)。
> 例:北京时间 8:00 ~ 23:00 整点 → UTC 0:00 ~ 15:00 整点 → `0 0-15 * * *`。
> 例:北京时间 1:00 整点 → UTC 17:00 → `0 17 * * *`。
>
> 免费版 Cron Triggers 最低间隔是 5 分钟(`*/1` 不会被执行,会被警告为太频繁)。

### 修改评分规则

打开 `worker.js` 搜 `function scoreIp`,当前是 `延迟 + 丢包率 × 100`,想更看重零丢包可把丢包权重改成 200、300。

### 手动切换为手填 Token 模式(不推荐)

如果不希望使用"自动化配置",可以跳过部署第 6 步的弹窗,直接在 Variables 添加:

- `HUAWEI_AUTH_TOKEN`(Secret) - IAM X-Auth-Token
- `HUAWEI_PROJECT_ID`(Text) - 项目 ID
- `HUAWEI_REGION`(Text) - 如 `cn-north-4`

注意 Token 默认 24 小时过期,过期后任务会失败,需要手动换新。

---

## 常见问题

**Q: 访问面板提示"未绑定 KV"。**

A: 按"部署方法"第 3 步创建并绑定 KV;绑定后回到 **Code** 标签再 Deploy 一次。

**Q: 点"自动化配置"提交后报错"获取 IAM Token 失败: ... "。**

A: 常见原因:
- domain 填错(不是账号 ID,是"我的凭证"页面顶部"账号名"字段)
- IAM 用户名密码错
- 该 IAM 用户在所选 region 没有权限
- 该 IAM 用户开启了登录保护(需要先在华为云控制台临时关闭)

可在 https://console.huaweicloud.com/iam/#/mine/access-token 手动登录能确认 domain/username 是否正确。

**Q: Token 显示"已过期",点"重新获取 Token"仍失败。**

A: 通常是账号密码在 KV 中被改过或 IAM 用户被停用。点"自动化配置"重新提交一次即可。

**Q: 怎么从国内站切到国际站(intl)?**

A: API 路径完全一致(`dns.<region>.myhuaweicloud.com`),只把 region 改成国际站对应代码(如 `ap-southeast-1`),并确保 IAM 账号在那个 region 有权限即可。

**Q: 多久之后能看到优选 IP 生效?**

A: DNS TTL 默认 60 秒,约 1 分钟后全球生效。

**Q: vps789 接口请求失败。**

A: 少数情况下 vps789 临时不可用,等下一次 15 分钟重试即可。也可浏览器直接打开 https://vps789.com/openApi/cfIpApi 看是否能返回 JSON。

**Q: 面板白屏/加载不出来。**

A: 排查步骤:

1. 访问 `https://<your-worker>.workers.dev/api/version`,应该返回 JSON 包含 `scriptFnv32`、`hasDynamicReactImport: true`、`hasCreateRootImport: true`、`buildId: 2026-07-29-fix-475`。如果 `scriptFnv32` 与最新源码不一致,说明 Cloudflare 部署的是旧版本,请重新粘贴 `worker.js` 后点 **Save and Deploy**。
2. 浏览器打开 **DevTools -> Console**,启动进度日志会出现在 `[boot] ...` 前缀下;**红色错误条**只在真正异常时才显示,正常加载时不会有。
3. 常见原因:
   - esm.sh 改版:已通过 `?pin=v135` 锁定,主源失败会自动回退到 jsdelivr;如仍有问题请检查网络是否能访问 `https://esm.sh` 和 `https://cdn.jsdelivr.net`
   - 浏览器禁用了 ES module:升级到现代浏览器(Chrome 89+ / Firefox 108+ / Safari 15+)
   - 部署了旧版本:见步骤 1,用 `/api/version` 对比指纹

**Q: 担心账号密码明文存在 KV 里。**

A: KV 是你的私有命名空间,Cloudflare 不会读取;但仍建议:
- 只为该 IAM 用户授予 DNS Administrator(而不是 Tenant Administrator)最小权限
- 定期更换 IAM 密码
- 若不再使用,删除 Worker 和 KV 即可清除

---

## 文件结构

```
cf-ip-sync-huawei/
├── worker.js     唯一需要部署的文件(HTML + React + 同步逻辑 + IAM + DNS API)
├── README.md     本文档
├── LICENSE       MIT 开源协议
└── .gitignore    Git 忽略规则
```

整个项目只有一个核心文件,已通过 ESM + 浏览器模块语法校验,可直接复制使用。

---

## 技术栈

| 组件 | 选型 | 说明 |
| --- | --- | --- |
| 运行环境 | Cloudflare Workers | 免费额度:每日 10 万次请求,足够个人使用 |
| 前端 | React 18 + 原生 CSS | 通过 esm.sh CDN 加载,不需打包工具 |
| 后端 | Cloudflare Workers (JavaScript) | 单文件全栈 |
| 持久化 | Cloudflare KV | 存 IAM 配置、Token、执行日志 |
| 定时任务 | Cron Triggers | Workers 原生定时能力 |
| 数据源 | vps789 公开 API | 拉取 Cloudflare 优选 IP 候选 |
| DNS 服务 | 华为云 DNS | 国内/国际站均可,API 路径一致 |

---

## 致谢

- [vps789.com](https://vps789.com) 提供 Cloudflare 优选 IP 数据
- [Cloudflare Workers](https://workers.cloudflare.com/) 提供免费运行环境与 KV 存储
- [华为云 DNS](https://support.huaweicloud.com/productdns/index.html) 提供稳定的权威 DNS 服务
- [esm.sh](https://esm.sh) 提供按需加载的 ESM CDN

---

## License

MIT
