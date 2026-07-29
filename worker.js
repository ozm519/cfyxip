/* =========================================================================
 * CF 优选 IP 同步管理面板 - 一站式 Cloudflare Worker
 * -------------------------------------------------------------------------
 * 部署方法（纯鼠标操作，无需本地构建）：
 *   1. 打开 https://dash.cloudflare.com/ 并登录
 *   2. 左侧菜单点击 "Workers & Pages" -> "Create application"
 *   3. 选择 "Create Worker" -> 给项目起个名字（例如 cf-ip-sync）-> Deploy
 *   4. 点击 "Edit code" 进入编辑器
 *   5. 全选并删除默认代码 -> 把本文件全部内容粘贴进去 -> 点 "Save and Deploy"
 *   6. 回到 Worker 详情页 -> 左侧 "KV" -> Create a namespace 命名为 CF_IP_SYNC_KV
 *      然后回到 Worker 详情 -> Settings -> Bindings -> Add binding
 *      Variable name: KV,  KV Namespace: CF_IP_SYNC_KV  -> Deploy
 *   7. Worker 详情 -> Settings -> Variables and Secrets 至少添加：
 *        HUAWEI_ZONE_ID      域名 zone_id
 *        RECORD_NAME         cf.example.com.    (FQDN 末尾带点)
 *        ADMIN_KEY           任意字符串         (Secret, 可选, 留空则不鉴权)
 *      其它三个 (HUAWEI_AUTH_TOKEN / HUAWEI_PROJECT_ID / HUAWEI_REGION)
 *      不必手填，面板里点"自动化配置"即可一键填入
 *   8. "Settings" -> "Triggers" -> "Cron Triggers" -> Add Cron Trigger
 *        Cron 字段填  0,15,30,45 * * * *   (每 15 分钟整点)
 *   9. 打开 Worker 顶部 "Visit" 链接 -> 弹窗中点"自动化配置" -> 输入
 *      华为云账号名 / IAM 用户名 / 密码 / region -> 提交后自动获取并保存
 *      后续每次同步任务前会自动续期 Token（24h 有效，提前 1h 自动换新）
 *
 * 提供接口：
 *   GET  /                管理面板（HTML）
 *   POST /api/auto-config 一键配置（传入账号/IAM用户/密码/region）
 *   GET  /api/config      查看当前生效的配置（Token 仅显示剩余有效期）
 *   GET  /api/sync        立即执行一次同步
 *   GET  /api/records     查询当前 zone 下的 A 记录
 *   GET  /api/ips         拉取 vps789 优选 IP 数据
 *   Cron 15min            自动同步
 * ========================================================================= */

/* ============================================================
 * 1. 同步任务核心逻辑
 * ============================================================ */

const CF_IP_API = "https://vps789.com/openApi/cfIpApi";

/* ============================================================
 * 1.1 IAM Token 自动获取与续期
 *     通过账号+IAM 用户名+密码 调用 iam.myhuaweicloud.com 拿 Token
 *     持久化到 Cloudflare KV 中，runJob 执行前自动续期
 * ============================================================ */

const IAM_GLOBAL_ENDPOINT = "https://iam.myhuaweicloud.com";
const KV_KEY_CONFIG = "huawei_config"; // KV 中存储的 key

/**
 * 调用 IAM 用账号/用户/密码 拿 Token
 * 返回 { token, expiresAt, projectId, projectName, accountId }
 */
async function fetchIamTokenByPassword({ domain, username, password, region }) {
  const url = `${IAM_GLOBAL_ENDPOINT}/v3/auth/tokens?nocatalog=true`;
  const body = {
    auth: {
      identity: {
        methods: ["password"],
        password: {
          user: {
            domain: { name: domain },
            name: username,
            password: password,
          },
        },
      },
      scope: {
        project: { name: region },
      },
    },
  };
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json;charset=utf8" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const txt = await resp.text();
    let errMsg = `HTTP ${resp.status}`;
    try {
      const j = JSON.parse(txt);
      errMsg = j.error?.message || j.error?.code || j.error_msg || errMsg;
    } catch {
      errMsg = txt.slice(0, 200) || errMsg;
    }
    throw new Error(`获取 IAM Token 失败: ${errMsg}`);
  }
  const token = resp.headers.get("X-Subject-Token");
  if (!token) {
    throw new Error("获取 IAM Token 失败: 响应头中没有 X-Subject-Token");
  }
  const data = await resp.json();
  const projectId = data?.token?.project?.id || "";
  const projectName = data?.token?.project?.name || region;
  const accountId = data?.token?.user?.domain?.id || data?.token?.domain?.id || "";
  // 提前 10 分钟续期（保险起见）
  const expiresAtMs = Date.parse(data?.token?.expires_at || "") - 10 * 60 * 1000;
  return {
    token,
    expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : Date.now() + 23 * 3600 * 1000,
    projectId,
    projectName,
    accountId,
  };
}

/**
 * 加载并合并 KV/env 中的 Token
 *   1. 优先用 KV 中的（用户通过"自动化配置"写入的）
 *   2. 其次用 env.HUAWEI_AUTH_TOKEN（用户手填的旧方式）
 */
async function loadAuth(env) {
  let cfg = null;
  if (env.KV) {
    try {
      const raw = await env.KV.get(KV_KEY_CONFIG);
      if (raw) cfg = JSON.parse(raw);
    } catch (e) {
      // 忽略 KV 读取失败
    }
  }
  // 合并：env 优先级低于 KV（KV 是用户主动配置的）
  const merged = {
    domain: cfg?.domain || "",
    username: cfg?.username || "",
    password: cfg?.password || "",
    region: cfg?.region || env.HUAWEI_REGION || "cn-north-4",
    token: cfg?.token || env.HUAWEI_AUTH_TOKEN || "",
    tokenExpiresAt: cfg?.tokenExpiresAt || 0,
    projectId: cfg?.projectId || env.HUAWEI_PROJECT_ID || "",
    projectName: cfg?.projectName || "",
    accountId: cfg?.accountId || "",
  };
  return merged;
}

/**
 * 持久化到 KV
 */
async function saveAuth(env, cfg) {
  if (!env.KV) throw new Error("未绑定 Cloudflare KV (变量名 KV)，无法持久化配置");
  await env.KV.put(KV_KEY_CONFIG, JSON.stringify(cfg));
}

/**
 * 必要时刷新 Token；返回当前有效的 auth（含新 token）
 *   - 若没有账号密码（用户手填 Token 模式）：仅返回原 cfg
 *   - 若 Token 有效：直接返回
 *   - 若 Token 即将过期（剩 < 1h）：重新获取
 */
async function ensureFreshToken(env) {
  const cfg = await loadAuth(env);
  // 缺少账号/密码：用户手填 Token 模式，不自动续期
  if (!cfg.domain || !cfg.username || !cfg.password) return cfg;
  const now = Date.now();
  // Token 还有 >= 1h 有效期
  if (cfg.token && cfg.tokenExpiresAt && cfg.tokenExpiresAt - now > 3600 * 1000) {
    return cfg;
  }
  // 续期
  const fresh = await fetchIamTokenByPassword({
    domain: cfg.domain,
    username: cfg.username,
    password: cfg.password,
    region: cfg.region,
  });
  const next = { ...cfg, ...fresh };
  await saveAuth(env, next);
  return next;
}

/**
 * 计算单条 IP 在三网中"延迟 + 丢包率 × 100" 的最小值，越小越好
 */
function scoreIp(entry) {
  const candidates = [
    entry.dxLatencyAvg + entry.dxPkgLostRateAvg * 100,
    entry.ydLatencyAvg + entry.ydPkgLostRateAvg * 100,
    entry.ltLatencyAvg + entry.ltPkgLostRateAvg * 100,
  ].filter((v) => Number.isFinite(v));
  return candidates.length ? Math.min(...candidates) : Infinity;
}

/**
 * 从多网数据中筛选综合最优的 N 个 IP
 */
function pickBestIps(data, count = 2) {
  let pool = [];
  if (Array.isArray(data.AllAvg) && data.AllAvg.length > 0) {
    pool = data.AllAvg.slice();
  } else {
    pool = [...(data.CT || []), ...(data.CU || []), ...(data.CM || [])];
  }
  const seen = new Set();
  pool = pool.filter((it) => {
    if (!it || !it.ip || seen.has(it.ip)) return false;
    seen.add(it.ip);
    return true;
  });
  return pool
    .map((it) => ({ it, s: scoreIp(it) }))
    .sort((a, b) => a.s - b.s)
    .slice(0, count)
    .map((x) => x.it);
}

/* ---------- 华为云 DNS API ---------- */
function huaweiEndpointFromRegion(region) {
  return `https://dns.${region}.myhuaweicloud.com`;
}

function huaweiHeaders(token) {
  return {
    "Content-Type": "application/json; charset=utf-8",
    "X-Auth-Token": token,
  };
}

/**
 * 列出 zone 下所有记录集（v2.1 接口不支持 type 过滤，所以拉到客户端再过滤）
 *   关键：华为云返回的 r.name 可能是 "wxp.l2.ink." 也可能是 "wxp.l2.ink"，
 *   因此调用方需要做尾点归一化
 */
async function listHuaWeiRecordsets(auth, region, zoneId) {
  const url = `${huaweiEndpointFromRegion(region)}/v2.1/zones/${zoneId}/recordsets?limit=500`;
  const resp = await fetch(url, { headers: huaweiHeaders(auth.token) });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`查询记录集失败: HTTP ${resp.status}, body=${txt}`);
  }
  const data = await resp.json();
  return data.recordsets || [];
}

/**
 * 把 "wxp.l2.ink." / "wxp.l2.ink" 统一成 "wxp.l2.ink"（去掉末尾的点）
 *   这样 r.name 和 env.RECORD_NAME 比较时不会因为尾点漏掉
 */
function normalizeDnsName(n) {
  if (!n) return "";
  return String(n).trim().replace(/\.+$/, "");
}

async function createHuaWeiRecordset(auth, region, zoneId, name, ip, ttl) {
  const url = `${huaweiEndpointFromRegion(region)}/v2.1/zones/${zoneId}/recordsets`;
  const body = {
    name,
    type: "A",
    ttl: ttl || 60,
    records: [ip],
    status: "ENABLE",
  };
  const resp = await fetch(url, {
    method: "POST",
    headers: huaweiHeaders(auth.token),
    body: JSON.stringify(body),
  });
  if (!resp.ok && resp.status !== 202) {
    const txt = await resp.text();
    throw new Error(`创建记录集失败: HTTP ${resp.status}, body=${txt}`);
  }
}

async function updateHuaWeiRecordset(auth, region, zoneId, recordsetId, records, ttl) {
  const url = `${huaweiEndpointFromRegion(region)}/v2/zones/${zoneId}/recordsets/${recordsetId}`;
  const body = { records, ttl: ttl || 60 };
  const resp = await fetch(url, {
    method: "PUT",
    headers: huaweiHeaders(auth.token),
    body: JSON.stringify(body),
  });
  if (!resp.ok && resp.status !== 202) {
    const txt = await resp.text();
    throw new Error(`修改记录集失败: HTTP ${resp.status}, body=${txt}`);
  }
}

async function deleteHuaWeiRecordset(auth, region, zoneId, recordsetId) {
  const url = `${huaweiEndpointFromRegion(region)}/v2/zones/${zoneId}/recordsets/${recordsetId}`;
  const resp = await fetch(url, {
    method: "DELETE",
    headers: huaweiHeaders(auth.token),
  });
  if (!resp.ok && resp.status !== 202 && resp.status !== 204) {
    const txt = await resp.text();
    throw new Error(`删除记录集失败: HTTP ${resp.status}, body=${txt}`);
  }
}

/**
 * 主任务：拉取 -> 筛选 -> 同步到华为云 DNS
 */
async function runJob(env) {
  const log = [];
  const push = (msg) => {
    log.push(`[${new Date().toISOString()}] ${msg}`);
  };
  try {
    push("开始执行优选 IP 同步任务");

    // 1. 参数校验
    if (!env.HUAWEI_ZONE_ID) throw new Error("缺少必要环境变量: HUAWEI_ZONE_ID");
    if (!env.RECORD_NAME) throw new Error("缺少必要环境变量: RECORD_NAME");

    // 2. 自动续期 Token（从 KV 读取账号密码，调 IAM 拿新 Token）
    const auth = await ensureFreshToken(env);
    if (!auth.token) {
      throw new Error(
        "缺少 IAM Token。请在管理面板点 ‘自动化配置’ 填写华为云账号/IAM用户/密码，" +
          "或手工在 Worker 的 Variables 中填 HUAWEI_AUTH_TOKEN。"
      );
    }
    if (!auth.projectId) {
      throw new Error("缺少 project_id。请通过 ‘自动化配置’ 一键获取。");
    }
    const region = auth.region || "cn-north-4";
    push(`区域: ${region}; Token 有效期剩余: ${formatRemain(auth.tokenExpiresAt)}`);

    // 3. 拉取优选 IP
    const ipApiResp = await fetch(CF_IP_API, {
      headers: { "User-Agent": "cf-workers-cfip-sync/2.0" },
    });
    if (!ipApiResp.ok) {
      throw new Error(`优选 IP 接口请求失败: HTTP ${ipApiResp.status}`);
    }
    const ipJson = await ipApiResp.json();
    if (ipJson.code !== 0) {
      throw new Error(`优选 IP 接口返回错误: code=${ipJson.code}`);
    }
    push(
      `成功拉取优选 IP 数据, code=${ipJson.code}, count=${ipJson.count}`
    );

    // 4. 筛选
    const bestTwo = pickBestIps(ipJson.data, 2);
    if (bestTwo.length < 2) throw new Error("未筛选到足够的优选 IP");
    const newIps = bestTwo.map((x) => x.ip);
    const newIpSet = new Set(newIps);
    push(
      `筛选出 ${bestTwo.length} 个最优 IP: ${newIps.join(", ")} (评分: ${bestTwo
        .map((x) => scoreIp(x).toFixed(1))
        .join(", ")})`
    );

    // 5. 查询当前 DNS(列出整个 zone 下的所有 A 记录,同步时会全删全建)
    const existing = await listHuaWeiRecordsets(auth, region, env.HUAWEI_ZONE_ID);
    const targetName = normalizeDnsName(env.RECORD_NAME);
    // 调试 log:列出 zone 内所有 A 记录(原值,带尾点)
    const allA = existing.filter((r) => r.type === "A");
    const allAUnderTarget = allA.filter((r) => normalizeDnsName(r.name) === targetName);
    const allAOtherHosts  = allA.filter((r) => normalizeDnsName(r.name) !== targetName);
    push(
      `该 zone 共 ${allA.length} 条 A 记录: 同名(${env.RECORD_NAME}, 归一化=${targetName}) ${allAUnderTarget.length} 条, ` +
      `其它主机 ${allAOtherHosts.length} 条 ` +
      `[${allAOtherHosts.map((r)=>JSON.stringify(r.name)).join(", ")}]`
    );

    // 6. 策略:同步时直接删除整个 zone 下所有 A 记录,然后只创建 RECORD_NAME 的 2 个新 IP
    //    这样无论旧的 A 记录挂在哪个主机名下都会被清掉,避免残留
    // 第 1 步:把 zone 下所有 A 记录全部标记为待删
    const toDelete = allA.map((r) => r.id);
    // 第 2 步:要新增的就是本次选出的 2 个新 IP(全部都新建)
    const toCreate = newIps.slice();
    push(
      `计划删除 zone 下全部 A 记录 ${toDelete.length} 条` +
        (allAOtherHosts.length ? ` (含其它主机: ${allAOtherHosts.map((r)=>r.name).join(", ")})` : "") +
        `; 计划新增 ${toCreate.length} 个 IP: ${toCreate.join(",") || "无"}`
    );

    // 7. 先创建缺失的新 IP(保证解析不中断)
    for (const ip of toCreate) {
      await createHuaWeiRecordset(auth, region, env.HUAWEI_ZONE_ID, env.RECORD_NAME, ip, 60);
      push(`已创建 A 记录 ${env.RECORD_NAME} -> ${ip}`);
    }

    // 8. 删除整个 zone 下所有 A 记录(包括其它主机的)
    for (const id of toDelete) {
      await deleteHuaWeiRecordset(auth, region, env.HUAWEI_ZONE_ID, id);
    }
    push(`已删除 zone 下全部 A 记录 ${toDelete.length} 条`);

    push("任务完成");
    return { ok: true, log, bestTwo, newIps };
  } catch (err) {
    const msg = `任务执行失败: ${err && err.message ? err.message : err}`;
    push(`[ERROR] ${msg}`);
    return { ok: false, log, error: msg };
  }
}

function formatRemain(ms) {
  if (!ms || !Number.isFinite(ms)) return "未知";
  const diff = ms - Date.now();
  if (diff <= 0) return "已过期";
  const m = Math.floor(diff / 60000);
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h} 小时 ${mm} 分`;
}

/* ============================================================
 * 2. 内嵌的 React 管理面板（HTML + 全部 JS + CSS）
 *    使用 esm.sh 在线加载 React 18（无需任何打包）
 * ============================================================ */

const HTML_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>CF 优选 IP 同步面板</title>
<link rel="icon" href="data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' rx='12' fill='%23f48120'/><text x='50%25' y='58%25' text-anchor='middle' font-size='28' font-family='sans-serif' font-weight='700' fill='white'>CF</text></svg>" />
<style>
  :root{
    --bg:#f6f7f9;--bg2:#fff;--bg3:#f0f2f5;
    --ink:#1f2328;--ink2:#57606a;--muted:#8b949e;
    --rule:#e5e7eb;--rule-strong:#d1d5db;
    --accent:#f48120;--accent-hover:#e0731a;--accent2:#faae40;
    --good:#16a34a;--good-bg:#dcfce7;
    --warn:#d97706;--warn-bg:#fef3c7;
    --bad:#dc2626;--bad-bg:#fee2e2;
    --shadow:0 2px 6px rgba(0,0,0,.06);
    --radius:10px;--radius-sm:6px;
  }
  *{box-sizing:border-box}
  html,body{margin:0;padding:0;min-height:100%;}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;color:var(--ink);background:var(--bg);-webkit-font-smoothing:antialiased}
  h1,h2,h3,h4{margin:0;color:var(--ink);font-weight:600}
  h1{font-size:1.25rem}
  h3{font-size:1rem}
  p{margin:0}
  .muted{color:var(--muted)}
  .small{font-size:.8125rem}
  .mono{font-family:"JetBrains Mono","SF Mono",Menlo,Consolas,monospace}
  .app{min-height:100vh;display:flex;flex-direction:column}
  .topbar{display:flex;align-items:center;justify-content:space-between;padding:16px 24px;background:var(--bg2);border-bottom:1px solid var(--rule);position:sticky;top:0;z-index:10;gap:12px;flex-wrap:wrap}
  .brand{display:flex;align-items:center;gap:12px}
  .brand-logo{width:40px;height:40px;border-radius:8px;background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;font-weight:700;display:flex;align-items:center;justify-content:center;font-size:.95rem;box-shadow:0 2px 6px rgba(244,129,32,.3)}
  .top-actions{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
  main{padding:20px 24px;max-width:1480px;width:100%;margin:0 auto;display:flex;flex-direction:column;gap:20px;flex:1}
  .footer{padding:16px 24px;text-align:center;border-top:1px solid var(--rule);background:var(--bg2)}
  .stats-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:16px}
  .stat-card{background:var(--bg2);border:1px solid var(--rule);border-radius:var(--radius);padding:18px 20px;box-shadow:var(--shadow);display:flex;flex-direction:column;gap:6px;min-height:120px}
  .stat-label{font-size:.8125rem;color:var(--muted);font-weight:500}
  .stat-value{font-size:1.5rem;font-weight:700;color:var(--ink);word-break:break-all}
  .stat-sub{font-size:.8125rem;color:var(--ink2)}
  .stat-card.actions{gap:10px;justify-content:space-between}
  .btn-row{display:flex;gap:8px;flex-wrap:wrap}
  .btn{appearance:none;border:1px solid transparent;background:transparent;cursor:pointer;padding:8px 16px;border-radius:var(--radius-sm);font-size:.875rem;font-weight:500;transition:all .15s ease;display:inline-flex;align-items:center;justify-content:center;gap:6px;line-height:1.2}
  .btn.primary{background:var(--accent);color:#fff;border-color:var(--accent)}
  .btn.primary:hover:not(:disabled){background:var(--accent-hover);border-color:var(--accent-hover)}
  .btn.primary:disabled{opacity:.6;cursor:not-allowed}
  .btn.ghost{background:var(--bg2);border-color:var(--rule-strong);color:var(--ink)}
  .btn.ghost:hover:not(:disabled){background:var(--bg3);border-color:var(--ink2)}
  .btn.ghost:disabled{opacity:.6;cursor:not-allowed}
  .btn.small{padding:4px 10px;font-size:.8125rem}
  .card{background:var(--bg2);border:1px solid var(--rule);border-radius:var(--radius);box-shadow:var(--shadow);overflow:hidden;display:flex;flex-direction:column}
  .card-head{display:flex;justify-content:space-between;align-items:flex-start;padding:14px 18px;border-bottom:1px solid var(--rule);background:var(--bg3);gap:12px}
  .badge{background:var(--bg2);border:1px solid var(--rule-strong);color:var(--ink2);font-size:.75rem;padding:2px 8px;border-radius:999px;white-space:nowrap}
  .grid-2{display:grid;grid-template-columns:1fr 1fr;gap:20px}
  .table-wrap{overflow-x:auto;overflow-y:auto;max-height:460px}
  .data-table{width:100%;border-collapse:collapse;font-size:.8125rem;min-width:760px}
  .data-table th{text-align:left;font-weight:600;color:var(--ink2);background:var(--bg3);padding:8px 12px;border-bottom:1px solid var(--rule);position:sticky;top:0;z-index:1;white-space:nowrap}
  .data-table td{padding:8px 12px;border-bottom:1px solid var(--rule);white-space:nowrap}
  .data-table tr:hover td{background:var(--bg3)}
  .data-table tr.top-row td{background:rgba(244,129,32,.04)}
  .data-table tr.highlight td{background:rgba(22,163,74,.08);font-weight:500}
  .data-table td.idx{color:var(--muted);font-weight:600;width:36px}
  .data-table td.empty{text-align:center;color:var(--muted);padding:24px}
  .pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:.75rem;font-weight:600;background:var(--bg3);color:var(--ink2);white-space:nowrap}
  .pill.good{background:var(--good-bg);color:var(--good)}
  .pill.warn{background:var(--warn-bg);color:var(--warn)}
  .pill.bad{background:var(--bad-bg);color:var(--bad)}
  tr.good .pill{background:var(--good-bg);color:var(--good)}
  tr.warn .pill{background:var(--warn-bg);color:var(--warn)}
  tr.bad .pill{background:var(--bad-bg);color:var(--bad)}
  .record-ip{display:inline-block;margin:2px 4px 2px 0;padding:2px 8px;border-radius:4px;background:var(--bg3);border:1px solid var(--rule);font-size:.75rem}
  .record-ip.highlight{background:rgba(22,163,74,.1);border-color:var(--good);color:var(--good);font-weight:600}
  .log-box{padding:12px 16px;font-family:"JetBrains Mono","SF Mono",Menlo,Consolas,monospace;font-size:.75rem;line-height:1.7;max-height:460px;overflow-y:auto;background:#0d1117;color:#c9d1d9}
  .log-line{display:flex;gap:12px;padding:1px 0}
  .log-line .log-idx{color:#6e7681;flex-shrink:0;user-select:none}
  .log-line .log-text{flex:1;word-break:break-all;white-space:pre-wrap}
  .log-line.ok .log-text{color:#7ee787}
  .log-line.err .log-text{color:#ff7b72;font-weight:600}
  .alert{margin:0 24px;padding:12px 16px;background:var(--bad-bg);border:1px solid #fca5a5;border-radius:var(--radius-sm);color:var(--bad);font-size:.875rem}
  .alert.info{background:var(--good-bg);border-color:#86efac;color:var(--good)}
  .modal-mask{position:fixed;inset:0;background:rgba(15,23,42,.4);backdrop-filter:blur(2px);display:flex;align-items:center;justify-content:center;z-index:100}
  .modal-card{background:var(--bg2);border-radius:var(--radius);width:min(520px,92vw);padding:24px;box-shadow:0 20px 50px rgba(0,0,0,.2)}
  .modal-card label{display:flex;flex-direction:column;gap:4px;margin:14px 0 0 0;font-size:.8125rem;color:var(--ink2)}
  .modal-card input{border:1px solid var(--rule-strong);border-radius:var(--radius-sm);padding:8px 10px;font-size:.875rem;font-family:inherit;color:var(--ink);background:var(--bg)}
  .modal-card input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px rgba(244,129,32,.15)}
  .modal-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:22px}
  .loading{opacity:.6;pointer-events:none}
  @media (max-width:1100px){.stats-grid{grid-template-columns:repeat(2,1fr)}.grid-2{grid-template-columns:1fr}}
  @media (max-width:640px){.topbar{flex-direction:column;align-items:flex-start;gap:8px}main{padding:16px}.stats-grid{grid-template-columns:1fr}.stat-value{font-size:1.25rem}}
</style>
</head>
<body>
<div id="root"></div>
<script type="module">
// ==================== 自检 + 全局错误捕获 ====================
// 任何 import / 渲染错误都会写到 #__boot_err,避免白屏看不到原因
function __bootErr(msg){
  let el=document.getElementById("__boot_err");
  if(!el){
    el=document.createElement("div");
    el.id="__boot_err";
    el.style.cssText="position:fixed;top:0;left:0;right:0;z-index:99999;background:#fee;border:2px solid #dc2626;color:#7f1d1d;padding:14px 18px;font:13px/1.5 -apple-system,Segoe UI,sans-serif;white-space:pre-wrap;word-break:break-all;";
    document.body && document.body.appendChild(el);
  }
  el.textContent+=(el.textContent?"\n\n":"")+msg;
}
window.addEventListener("error",(e)=>__bootErr("[window.error] "+(e.message||e.error)+"\n"+(e.error?.stack||"")));
window.addEventListener("unhandledrejection",(e)=>__bootErr("[unhandledrejection] "+(e.reason?.message||e.reason)));
__bootErr("[boot] 正在加载 React...");

// 通过 esm.sh 在浏览器中加载 React。?dev=false&pin=v135 锁定缓存,避免 esm.sh 改版导致 import 失败
import React, { useState, useEffect, useMemo } from "https://esm.sh/react@18.3.1?dev=false&pin=v135";
import { createRoot } from "https://esm.sh/react-dom@18.3.1/client?dev=false&pin=v135&deps=react@18.3.1";
__bootErr("[boot] React 加载完成,准备渲染...");

const h = React.createElement;
// useState/useEffect/useMemo 已通过 import 引入

/* ---------------- 工具函数 ---------------- */
function scoreIp(entry){
  const c=[
    entry.dxLatencyAvg+entry.dxPkgLostRateAvg*100,
    entry.ydLatencyAvg+entry.ydPkgLostRateAvg*100,
    entry.ltLatencyAvg+entry.ltPkgLostRateAvg*100,
  ].filter(v=>Number.isFinite(v));
  return c.length?Math.min(...c):Infinity;
}
function pickBestIps(data,count=2){
  let pool=[];
  if(Array.isArray(data.AllAvg)&&data.AllAvg.length>0){pool=data.AllAvg.slice();}
  else{pool=[...(data.CT||[]),...(data.CU||[]),...(data.CM||[])];}
  const seen=new Set();
  pool=pool.filter(it=>{if(!it?.ip||seen.has(it.ip))return false;seen.add(it.ip);return true;});
  return pool.map(it=>({it,s:scoreIp(it)})).sort((a,b)=>a.s-b.s).slice(0,count).map(x=>x.it);
}
function scoreLevel(s){if(!Number.isFinite(s))return"bad";if(s<120)return"good";if(s<250)return"warn";return"bad";}

async function api(path){
  const r=await fetch(path);
  if(!r.ok){const t=await r.text();throw new Error("HTTP "+r.status+": "+t);}
  return r.json();
}

/* ---------------- 子组件 ---------------- */
function StatsHeader({bestTwo,loading,onRefresh,onSync,syncing,lastSyncAt}){
  return h("div",{className:"stats-grid"},
    h("div",{className:"stat-card"},
      h("div",{className:"stat-label"},"综合最优 IP #1"),
      h("div",{className:"stat-value mono"},bestTwo[0]?.ip||"—"),
      h("div",{className:"stat-sub"},"评分 ",h("strong",null,bestTwo[0]?scoreIp(bestTwo[0]).toFixed(1):"—"))
    ),
    h("div",{className:"stat-card"},
      h("div",{className:"stat-label"},"综合最优 IP #2"),
      h("div",{className:"stat-value mono"},bestTwo[1]?.ip||"—"),
      h("div",{className:"stat-sub"},"评分 ",h("strong",null,bestTwo[1]?scoreIp(bestTwo[1]).toFixed(1):"—"))
    ),
    h("div",{className:"stat-card"},
      h("div",{className:"stat-label"},"当前优选 IP 数"),
      h("div",{className:"stat-value"},"2"),
      h("div",{className:"stat-sub"},"由 Worker 维护中")
    ),
    h("div",{className:"stat-card actions"},
      h("div",{className:"stat-label"},"操作"),
      h("div",{className:"btn-row"},
        h("button",{className:"btn primary",onClick:onSync,disabled:syncing},syncing?"同步中...":"立即同步"),
        h("button",{className:"btn ghost",onClick:onRefresh,disabled:loading},loading?"拉取中...":"刷新数据")
      ),
      h("div",{className:"stat-sub"},"上次执行: ",lastSyncAt?new Date(lastSyncAt).toLocaleString("zh-CN"):"—")
    )
  );
}

function IpListPanel({title,subtitle,entries,highlightIps}){
  const sorted=[...entries].map(it=>({it,s:scoreIp(it)})).sort((a,b)=>a.s-b.s).map(x=>x.it);
  return h("div",{className:"card"},
    h("div",{className:"card-head"},
      h("div",null,
        h("h3",null,title),
        h("p",{className:"muted small"},subtitle)
      ),
      h("span",{className:"badge"},sorted.length+" 条")
    ),
    h("div",{className:"table-wrap"},
      h("table",{className:"data-table"},
        h("thead",null,
          h("tr",null,
            h("th",{style:{width:36}},"#"),
            h("th",null,"IP"),
            h("th",null,"综合"),
            h("th",null,"电信延迟"),
            h("th",null,"电信丢包"),
            h("th",null,"联通延迟"),
            h("th",null,"联通丢包"),
            h("th",null,"移动延迟"),
            h("th",null,"移动丢包"),
            h("th",null,"更新时间")
          )
        ),
        h("tbody",null,
          sorted.length===0
            ? h("tr",null,h("td",{colSpan:10,className:"empty"},"暂无数据"))
            : sorted.map((it,idx)=>{
                const s=scoreIp(it);
                const lv=scoreLevel(s);
                const isTop=idx<2;
                const isHighlight=highlightIps.includes(it.ip);
                return h("tr",{key:it.ip,className:[lv,isTop?"top-row":"",isHighlight?"highlight":""].join(" ").trim()},
                  h("td",{className:"idx"},idx+1),
                  h("td",{className:"mono"},it.ip),
                  h("td",null,h("span",{className:"pill "+lv},s.toFixed(1))),
                  h("td",null,it.dxLatencyAvg.toFixed(1)+" ms"),
                  h("td",null,it.dxPkgLostRateAvg.toFixed(2)+"%"),
                  h("td",null,it.ltLatencyAvg.toFixed(1)+" ms"),
                  h("td",null,it.ltPkgLostRateAvg.toFixed(2)+"%"),
                  h("td",null,it.ydLatencyAvg.toFixed(1)+" ms"),
                  h("td",null,it.ydPkgLostRateAvg.toFixed(2)+"%"),
                  h("td",{className:"muted small"},it.createdTime)
                );
              })
        )
      )
    )
  );
}

function LogPanel({log}){
  return h("div",{className:"card"},
    h("div",{className:"card-head"},
      h("div",null,
        h("h3",null,"执行日志"),
        h("p",{className:"muted small"},"展示最近一次同步任务的执行日志")
      ),
      h("span",{className:"badge"},log.length+" 行")
    ),
    h("div",{className:"log-box"},
      log.length===0
        ? h("div",{className:"muted small"},"暂无日志，点上方 “立即同步” 开始")
        : log.map((line,idx)=>
            h("div",{
              key:idx,
              className:"log-line"+(line.includes("[ERROR]")?" err":line.includes("成功")||line.includes("已")?" ok":"")
            },
              h("span",{className:"log-idx"},String(idx+1).padStart(3,"0")),
              h("span",{className:"log-text"},line)
            )
          )
    )
  );
}

function DnsRecordsPanel({records,loading,highlightIps,onRefresh}){
  return h("div",{className:"card"},
    h("div",{className:"card-head"},
      h("div",null,
        h("h3",null,"当前 DNS 记录"),
        h("p",{className:"muted small"},"华为云 DNS 中本主机记录下的所有 A 记录")
      ),
      h("button",{className:"btn ghost small",onClick:onRefresh,disabled:loading},loading?"查询中...":"刷新")
    ),
    h("div",{className:"table-wrap"},
      h("table",{className:"data-table"},
        h("thead",null,
          h("tr",null,
            h("th",null,"主机记录"),
            h("th",null,"类型"),
            h("th",null,"TTL"),
            h("th",null,"解析值"),
            h("th",null,"状态")
          )
        ),
        h("tbody",null,
          records.length===0
            ? h("tr",null,h("td",{colSpan:5,className:"empty"},loading?"查询中...":"暂无 A 记录"))
            : records.map(r=>
                h("tr",{key:r.id},
                  h("td",{className:"mono"},r.name),
                  h("td",null,h("span",{className:"pill"},r.type)),
                  h("td",null,r.ttl+"s"),
                  h("td",{className:"mono"},
                    (r.records||[]).map(ip=>
                      h("span",{key:ip,className:"record-ip"+(highlightIps.includes(ip)?" highlight":"")},ip)
                    )
                  ),
                  h("td",null,
                    h("span",{className:"pill "+(r.status==="ACTIVE"||r.status==="ENABLE"?"good":r.status==="DISABLE"?"bad":"warn")},r.status)
                  )
                )
              )
        )
      )
    )
  );
}

function AutoConfigDialog({open,onClose,onSaved,currentConfig}){
  const [domain,setDomain]=useState(currentConfig?.domain||"");
  const [username,setUsername]=useState(currentConfig?.username||"");
  const [password,setPassword]=useState("");
  const [region,setRegion]=useState(currentConfig?.region||"ap-southeast-1");
  const [submitting,setSubmitting]=useState(false);
  const [error,setError]=useState(null);
  const [showPwd,setShowPwd]=useState(false);

  // 切换 open 时重置表单（保留 region/domain/username）
  useEffect(()=>{
    if(open){
      setDomain(currentConfig?.domain||"");
      setUsername(currentConfig?.username||"");
      setPassword("");
      setRegion(currentConfig?.region||"ap-southeast-1");
      setError(null);
      setShowPwd(false);
    }
  },[open,currentConfig]);

  if(!open)return null;

  async function handleSubmit(){
    if(submitting)return;
    setError(null);
    if(!domain.trim())return setError("请输入华为云账号名（domain）");
    if(!username.trim())return setError("请输入 IAM 用户名");
    if(!password)return setError("请输入 IAM 密码（不会在前端持久化，只用于换取 Token）");
    if(!region.trim())return setError("请选择 region");
    setSubmitting(true);
    try{
      const r=await fetch("/api/auto-config",{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({domain,username,password,region})
      });
      const j=await r.json();
      if(!j.ok)throw new Error(j.error||"提交失败");
      onSaved(j.config);
      onClose();
    }catch(e){
      setError(e.message);
    }finally{
      setSubmitting(false);
    }
  }

  return h("div",{className:"modal-mask",onClick:onClose},
    h("div",{className:"modal-card",onClick:e=>e.stopPropagation(),style:{maxWidth:560}},
      h("div",{style:{display:"flex",alignItems:"center",gap:10,marginBottom:4}},
        h("div",{style:{width:32,height:32,borderRadius:6,background:"linear-gradient(135deg,#f48120,#faae40)",color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",fontWeight:700,fontSize:".9rem"}},"IAM"),
        h("h3",null,"华为云 IAM 一键配置")
      ),
      h("p",{className:"muted small",style:{marginTop:6,lineHeight:1.7}},
        "填入华为云账号名 + IAM 用户名 + 密码，Worker 会自动调用 ",
        h("span",{className:"mono"},"iam.myhuaweicloud.com"),
        " 换取 Token 并写入 KV。后续每次执行同步任务前，若 Token 剩余有效期小于 1 小时将自动续期（默认 24h）。"),
      h("label",null,
        h("span",null,h("b",null,"账号名（domain）")),
        h("input",{type:"text",placeholder:"例如 huaweicloud-account-name",value:domain,onChange:e=>setDomain(e.target.value),autoComplete:"off"})
      ),
      h("label",null,
        h("span",null,h("b",null,"IAM 用户名（username）")),
        h("input",{type:"text",placeholder:"例如 zhangsan",value:username,onChange:e=>setUsername(e.target.value),autoComplete:"off"})
      ),
      h("label",null,
        h("span",null,h("b",null,"IAM 密码")),
        h("div",{style:{display:"flex",gap:6}},
          h("input",{type:showPwd?"text":"password",placeholder:"IAM 用户的登录密码（仅本次提交，不会回显）",value:password,onChange:e=>setPassword(e.target.value),autoComplete:"new-password",style:{flex:1}}),
          h("button",{type:"button",className:"btn ghost small",onClick:()=>setShowPwd(v=>!v)},showPwd?"隐藏":"显示")
        )
      ),
      h("label",null,
        h("span",null,h("b",null,"区域 region")),
        h("select",{value:region,onChange:e=>setRegion(e.target.value),style:{border:"1px solid var(--rule-strong)",borderRadius:6,padding:"8px 10px",fontSize:".875rem",background:"var(--bg)",color:"var(--ink)"}},
          h("optgroup",{label:"🌏 国际站 (myhuaweicloud.com)"},
            h("option",{value:"ap-southeast-1"},"ap-southeast-1  新加坡 (推荐)"),
            h("option",{value:"ap-southeast-2"},"ap-southeast-2  悉尼"),
            h("option",{value:"ap-southeast-3"},"ap-southeast-3  吉隆坡"),
            h("option",{value:"ap-southeast-4"},"ap-southeast-4  雅加达"),
            h("option",{value:"ap-east-1"},"ap-east-1  香港"),
            h("option",{value:"af-south-1"},"af-south-1  约翰内斯堡"),
            h("option",{value:"sa-brazil-1"},"sa-brazil-1  圣保罗一")
          ),
          h("optgroup",{label:"🇨🇳 国内站 (huaweicloud.com)"},
            h("option",{value:"cn-north-1"},"cn-north-1  北京一"),
            h("option",{value:"cn-north-4"},"cn-north-4  北京四"),
            h("option",{value:"cn-north-9"},"cn-north-9  乌兰察布二零一"),
            h("option",{value:"cn-east-2"},"cn-east-2  华东二"),
            h("option",{value:"cn-east-3"},"cn-east-3  上海一"),
            h("option",{value:"cn-south-1"},"cn-south-1  广州"),
            h("option",{value:"cn-southwest-2"},"cn-southwest-2  贵阳一")
          )
        )
      ),
      h("p",{className:"muted small",style:{marginTop:10,lineHeight:1.7}},
        "⚠️ 必读：需先在 Worker 的 ",
        h("b",null,"Settings → Bindings"),
        " 中创建并绑定 KV 命名空间（变量名 ",
        h("span",{className:"mono"},"KV"),
        "），否则保存会提示 “未绑定 KV”。"),
      error && h("div",{className:"alert",style:{margin:0,padding:"8px 12px",fontSize:".8125rem"}},error),
      h("div",{className:"modal-actions"},
        h("button",{className:"btn ghost",onClick:onClose,disabled:submitting},"取消"),
        h("button",{className:"btn primary",onClick:handleSubmit,disabled:submitting},submitting?"正在登录…":"登录并自动配置")
      )
    )
  );
}

function ClearDialog({open,onClose,recordName,onCleared,zoneARecordCount,hostnameARecordCount}){
  const [scope,setScope]=useState("hostname");
  const [confirmText,setConfirmText]=useState("");
  const [submitting,setSubmitting]=useState(false);
  const [err,setErr]=useState(null);
  // 打开时主动拉一次最新 DNS（不依赖父组件缓存），用后端真实数据填充
  const [liveZoneA,setLiveZoneA]=useState(null);   // [{name,id,records}], null = 还没拉
  const [liveHostnameA,setLiveHostnameA]=useState(null);

  useEffect(()=>{
    if(open){
      setScope("hostname");
      setConfirmText("");
      setErr(null);
      setSubmitting(false);
      setLiveZoneA(null);
      setLiveHostnameA(null);
      // 主动拉一次
      (async()=>{
        try{
          const r=await fetch("/api/records");
          const j=await r.json();
          if(j.ok){
            const target=(recordName||"").trim().replace(/\.+$/,"");
            const allA=(j.records||[]).filter((r)=>r.type==="A");
            setLiveZoneA(allA);
            setLiveHostnameA(allA.filter((r)=>(r.name||"").trim().replace(/\.+$/,"")===target));
          }else{
            setErr("无法拉取最新 DNS: " + (j.error||"未知错误"));
          }
        }catch(e){
          setErr("无法拉取最新 DNS: " + e.message);
        }
      })();
    }
  },[open,recordName]);

  if(!open)return null;

  // 优先用 live 数据；live 还没回来用 props 兜底
  const liveZoneCount = liveZoneA ? liveZoneA.length : zoneARecordCount;
  const liveHostnameCount = liveHostnameA ? liveHostnameA.length : hostnameARecordCount;
  const expectedCount = scope === "hostname" ? liveHostnameCount : liveZoneCount;
  const needConfirm = expectedCount > 0;

  async function handleSubmit(){
    if(submitting)return;
    setErr(null);
    if(confirmText !== "CLEAR"){
      setErr("请在确认框里输入 CLEAR（区分大小写）");
      return;
    }
    setSubmitting(true);
    try{
      const r=await fetch("/api/clear-records",{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({scope,confirm:"CLEAR"}),
      });
      const j=await r.json();
      // 0 删的情况（count=0）也要展示后端返回的 allZoneANames / normalizedMatchedName
      if(j.count === 0){
        setErr(
          (j.message||"无可清空的记录") +
          (j.allZoneANames && j.allZoneANames.length
            ? "\n\n该 zone 下全部 A 记录的 name: " + j.allZoneANames.map((n)=>JSON.stringify(n)).join(", ")
            : "") +
          (j.normalizedMatchedName
            ? "\n我查找的主机名（归一化）: " + JSON.stringify(j.normalizedMatchedName) +
              "\n如果上面对应不上，多半是 RECORD_NAME 环境变量配错（少主机名/写成了别的子域名）"
            : "")
        );
        setSubmitting(false);
        return;
      }
      onCleared(j);
      onClose();
    }catch(e){
      setErr(e.message);
    }finally{
      setSubmitting(false);
    }
  }

  return h("div",{className:"modal-mask",onClick:onClose},
    h("div",{className:"modal-card",onClick:e=>e.stopPropagation(),style:{maxWidth:540}},
      h("div",{style:{display:"flex",alignItems:"center",gap:10,marginBottom:4}},
        h("div",{style:{width:32,height:32,borderRadius:6,background:"#dc2626",color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",fontWeight:700,fontSize:"1rem"}},"⚠"),
        h("h3",null,"清空 A 记录")
      ),
      h("p",{className:"muted small",style:{marginTop:6,lineHeight:1.7}},
        "该操作会 ",h("b",{style:{color:"#dc2626"}},"永久删除"),
        " 华为云 DNS 中的 A 记录，无法恢复。请谨慎选择范围："),
      h("label",null,
        h("span",null,h("b",null,"清空范围")),
        h("div",{style:{display:"flex",flexDirection:"column",gap:6,marginTop:4}},
          h("label",{style:{display:"flex",alignItems:"flex-start",gap:8,padding:"8px 10px",border:scope==="hostname"?"1px solid var(--accent)":"1px solid var(--rule-strong)",borderRadius:6,cursor:"pointer",background:scope==="hostname"?"rgba(244,129,32,.05)":"var(--bg)"}},
            h("input",{type:"radio",name:"clearScope",value:"hostname",checked:scope==="hostname",onChange:e=>setScope(e.target.value),style:{marginTop:2}}),
            h("div",{style:{flex:1}},
              h("div", null,
                h("b",null,"仅当前主机记录"),
                " ",
                h("span",{className:"pill",style:{marginLeft:6}},liveZoneA==null?"…":(liveHostnameCount + " 条"))
              ),
              h("div",{className:"muted small",style:{marginTop:2,lineHeight:1.5}},
                h("span",{className:"mono"},recordName||"(未配置 RECORD_NAME)"),
                " 下的 A 记录，",
                h("b",null,"不影响"),
                " 其他主机记录（如 www、mail 等）")
            )
          ),
          h("label",{style:{display:"flex",alignItems:"flex-start",gap:8,padding:"8px 10px",border:scope==="zone"?"1px solid #dc2626":"1px solid var(--rule-strong)",borderRadius:6,cursor:"pointer",background:scope==="zone"?"rgba(220,38,38,.04)":"var(--bg)"}},
            h("input",{type:"radio",name:"clearScope",value:"zone",checked:scope==="zone",onChange:e=>setScope(e.target.value),style:{marginTop:2}}),
            h("div",{style:{flex:1}},
              h("div", null,
                h("b",{style:{color:"#dc2626"}},"整个 zone 的所有 A 记录"),
                " ",
                h("span",{className:"pill bad",style:{marginLeft:6}},liveZoneA==null?"…":(liveZoneCount + " 条"))
              ),
              h("div",{className:"muted small",style:{marginTop:2,lineHeight:1.5}},
                "会 ",h("b",null,"同时清空"),
                " 同一域名下所有主机记录（www、mail、api 等）的 A 记录，仅适用于 “我要重新规划 DNS” 的场景")
            )
          )
        )
      ),
      h("label",{style:{marginTop:14}},
        h("span",null,
          "二次确认：在下方输入 ",
          h("span",{className:"mono",style:{background:"#fef3c7",padding:"1px 6px",borderRadius:3,color:"#92400e"}},"CLEAR"),
          " 后才能继续"
        ),
        h("input",{type:"text",placeholder:"CLEAR",value:confirmText,onChange:e=>setConfirmText(e.target.value),autoComplete:"off",style:{marginTop:4,fontFamily:"JetBrains Mono, Menlo, Consolas, monospace",fontWeight:600}})
      ),
      !needConfirm && h("p",{className:"muted small",style:{marginTop:10,lineHeight:1.7}},
        "ℹ 当前范围内没有 A 记录可清空，提交按钮将灰显。"),
      err && h("div",{className:"alert",style:{marginTop:10,padding:"8px 12px",fontSize:".8125rem"}},err),
      h("div",{className:"modal-actions"},
        h("button",{className:"btn ghost",onClick:onClose,disabled:submitting},"取消"),
        h("button",{className:"btn primary",onClick:handleSubmit,
          disabled:submitting||!needConfirm||confirmText!=="CLEAR",
          style:!submitting&&needConfirm&&confirmText==="CLEAR"?{background:"#dc2626",borderColor:"#dc2626"}:null},
          submitting?"正在清空…":
          needConfirm?("清空 " + expectedCount + " 条 A 记录"):"无可清空的记录")
      )
    )
  );
}

function HelpDialog({open,onClose}){
  if(!open)return null;
  return h("div",{className:"modal-mask",onClick:onClose},
    h("div",{className:"modal-card",onClick:e=>e.stopPropagation(),style:{maxWidth:760}},
      h("h3",null,"部署完成后请配置以下环境变量"),
      h("p",{className:"muted small",style:{marginTop:8}},
        "回到 Cloudflare Dashboard -> 当前 Worker -> Settings -> Variables and Secrets，依次添加："),
      h("ul",{className:"small",style:{paddingLeft:20,lineHeight:1.9,marginTop:8}},
        h("li",null,h("b",null,"HUAWEI_AUTH_TOKEN")," — 华为云 IAM Token (X-Auth-Token)"),
        h("li",null,h("b",null,"HUAWEI_PROJECT_ID")," — 华为云项目 ID"),
        h("li",null,h("b",null,"HUAWEI_ZONE_ID")," — 域名对应的 zone_id"),
        h("li",null,h("b",null,"HUAWEI_REGION")," — 区域代码，下方列表中选一个"),
        h("li",null,h("b",null,"RECORD_NAME")," — 主机记录 FQDN，例如 cf.example.com."),
        h("li",null,h("b",null,"ADMIN_KEY")," — (可选) HTTP 鉴权 key")
      ),
      h("p",{className:"muted small",style:{marginTop:14,marginBottom:4}},
        h("b",null,"常用 HUAWEI_REGION 速查（按账号所在的站点选）：")),
      h("div",{style:{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginTop:6}},
        h("div",{className:"small",style:{background:"#f0f2f5",borderRadius:6,padding:"10px 12px"}},
          h("div",{style:{fontWeight:600,marginBottom:6}},"🇨🇳 国内站"),
          h("div",{className:"mono",style:{lineHeight:1.8}},
            "cn-north-1  北京一",h("br",null),
            "cn-north-4  北京四",h("br",null),
            "cn-north-9  乌兰察布二零一",h("br",null),
            "cn-east-2   华东二",h("br",null),
            "cn-east-3   上海一",h("br",null),
            "cn-south-1  广州",h("br",null),
            "cn-southwest-2  贵阳一")
        ),
        h("div",{className:"small",style:{background:"#f0f2f5",borderRadius:6,padding:"10px 12px"}},
          h("div",{style:{fontWeight:600,marginBottom:6}},"🌏 国际站"),
          h("div",{className:"mono",style:{lineHeight:1.8}},
            "ap-southeast-1  新加坡",h("br",null),
            "ap-southeast-2  悉尼",h("br",null),
            "ap-southeast-3  吉隆坡",h("br",null),
            "ap-southeast-4  雅加达",h("br",null),
            "ap-east-1       香港",h("br",null),
            "af-south-1      约翰内斯堡",h("br",null),
            "sa-brazil-1     圣保罗一")
        )
      ),
      h("p",{className:"muted small",style:{marginTop:14,lineHeight:1.7}},
        h("b",null,"说明："),
        "国际站与国内站的 DNS API 完全一致（域名都是 ",h("span",{className:"mono"},"dns.<region>.myhuaweicloud.com"),"），",
        "只要选择你账号对应的 region 即可正常使用。" ),
      h("p",{className:"muted small",style:{marginTop:8,lineHeight:1.7}},
        h("b",null,"Token 提醒："),
        "Token 默认 24h 过期，过期后任务会失败。建议另起一个 Worker 定时任务用 AK/SK 换 Token 后写入 KV 存储（高级用法，本面板暂未集成）。" ),
      h("p",{className:"muted small",style:{marginTop:8,lineHeight:1.7}},
        "保存变量后点 “立即同步” 即可看到效果。" ),
      h("div",{className:"modal-actions"},
        h("button",{className:"btn primary",onClick:onClose},"知道了")
      )
    )
  );
}

/* ---------------- 主页面 ---------------- */
function Dashboard(){
  const [ipData,setIpData]=useState(null);
  const [loadingIps,setLoadingIps]=useState(false);
  const [syncing,setSyncing]=useState(false);
  const [log,setLog]=useState([]);
  const [lastSyncAt,setLastSyncAt]=useState(null);
  const [dnsRecords,setDnsRecords]=useState([]);
  const [loadingDns,setLoadingDns]=useState(false);
  const [helpOpen,setHelpOpen]=useState(false);
  const [autoOpen,setAutoOpen]=useState(false);
  const [clearOpen,setClearOpen]=useState(false);
  const [refreshingToken,setRefreshingToken]=useState(false);
  const [config,setConfig]=useState(null);
  const [configError,setConfigError]=useState(null);
  const [savedHint,setSavedHint]=useState(null);
  const [error,setError]=useState(null);

  const bestTwo=useMemo(()=>{
    if(!ipData?.data)return [];
    return pickBestIps(ipData.data,2);
  },[ipData]);

  const highlightIps=useMemo(()=>bestTwo.map(x=>x.ip),[bestTwo]);

  async function loadConfig(){
    setConfigError(null);
    try{
      const r=await fetch("/api/config");
      const j=await r.json();
      if(!j.ok)throw new Error(j.error||"加载配置失败");
      setConfig(j.config);
    }catch(e){
      setConfigError(e.message);
    }
  }
  async function refreshIps(){
    setLoadingIps(true);setError(null);
    try{const data=await api("/api/ips");setIpData(data);}
    catch(e){setError(e.message);}
    finally{setLoadingIps(false);}
  }
  async function refreshDns(){
    setLoadingDns(true);setError(null);
    try{
      const data=await api("/api/records");
      setDnsRecords(data.records||[]);
    }catch(e){setError(e.message);}
    finally{setLoadingDns(false);}
  }
  async function handleSync(){
    setSyncing(true);setError(null);
    try{
      const result=await api("/api/sync");
      setLog(result.log||[]);
      setLastSyncAt(Date.now());
      refreshDns();
      // 同步后再拉一次配置，更新 Token 剩余时间
      loadConfig();
    }catch(e){
      setError(e.message);
      setLog(prev=>[...prev,"[ERROR] "+e.message]);
    }finally{setSyncing(false);}
  }
  async function handleRefreshToken(){
    if(refreshingToken)return;
    setRefreshingToken(true);setError(null);
    try{
      const r=await fetch("/api/refresh-token",{method:"POST"});
      const j=await r.json();
      if(!j.ok)throw new Error(j.error||"刷新失败");
      setSavedHint(j.message);
      setTimeout(()=>setSavedHint(null),3000);
      loadConfig();
    }catch(e){
      setError(e.message);
    }finally{
      setRefreshingToken(false);
    }
  }
  function handleAutoSaved(newCfg){
    setSavedHint("已自动获取并保存 Token，剩余 " + (newCfg?.tokenRemainLabel||""));
    setTimeout(()=>setSavedHint(null),4000);
    loadConfig();
  }
  function handleCleared(result){
    setSavedHint(result?.message || ("已清空 " + (result?.count ?? 0) + " 条 A 记录"));
    setTimeout(()=>setSavedHint(null),4000);
    refreshDns();
  }

  // 计算 hostname/zone 各自的 A 记录数（用于弹窗实时显示）
  const hostnameARecordCount = useMemo(()=>{
    const target = config?.recordName;
    if(!target) return 0;
    return dnsRecords.filter((r)=>r.type==="A" && r.name===target).length;
  },[dnsRecords,config]);
  const zoneARecordCount = useMemo(()=>dnsRecords.filter((r)=>r.type==="A").length,[dnsRecords]);

  useEffect(()=>{refreshIps();loadConfig();},[]);

  const tokenRemainMs=(config?.tokenExpiresAt||0)-Date.now();
  const tokenExpired=!config?.hasToken||tokenRemainMs<=0;
  const tokenNearExpire=config?.hasToken&&tokenRemainMs>0&&tokenRemainMs<3600*1000;

  return h("div",{className:"app"},
    h("header",{className:"topbar"},
      h("div",{className:"brand"},
        h("div",{className:"brand-logo"},"CF"),
        h("div",null,
          h("h1",null,"优选 IP 同步面板"),
          h("p",{className:"muted small"},"每 15 分钟自动同步最优 IP 到华为云 DNS")
        )
      ),
      h("div",{className:"top-actions"},
        h("button",{className:"btn primary",onClick:()=>setAutoOpen(true)},
          h("span",null,config?.autoRefreshEnabled?"重新配置 IAM":"自动化配置")),
        config?.autoRefreshEnabled
          ? h("button",{className:"btn ghost",onClick:handleRefreshToken,disabled:refreshingToken},
              refreshingToken?"刷新中…":"重新获取 Token")
          : null,
        h("button",{className:"btn ghost",onClick:refreshDns},"刷新 DNS"),
        h("button",{className:"btn ghost",onClick:()=>setClearOpen(true),style:{color:"#dc2626",borderColor:"#fca5a5"}},"清空 A 记录"),
        h("button",{className:"btn ghost",onClick:()=>setHelpOpen(true)},"使用说明")
      )
    ),
    savedHint && h("div",{className:"alert info",style:{margin:"12px 24px 0"}},h("strong",null,"✓ "),savedHint),
    (error||configError) && h("div",{className:"alert",style:{margin:"12px 24px 0"}},h("strong",null,"提示: "),error||configError),
    config && h(ConfigBanner,{config,tokenExpired,tokenNearExpire,onAutoConfig:()=>setAutoOpen(true),onRefreshToken:handleRefreshToken,refreshingToken}),
    h("main",null,
      h(StatsHeader,{bestTwo,loading:loadingIps,onRefresh:refreshIps,onSync:handleSync,syncing,lastSyncAt}),
      h("section",{className:"grid-2"},
        h(IpListPanel,{title:"综合最优 (AllAvg)",subtitle:"按 延迟+丢包率×100 综合评分排序",entries:ipData?.data?.AllAvg||[],highlightIps}),
        h(IpListPanel,{title:"电信 (CT)",subtitle:"电信网络下优选 IP 列表",entries:ipData?.data?.CT||[],highlightIps})
      ),
      h("section",{className:"grid-2"},
        h(IpListPanel,{title:"联通 (CU)",subtitle:"联通网络下优选 IP 列表",entries:ipData?.data?.CU||[],highlightIps}),
        h(IpListPanel,{title:"移动 (CM)",subtitle:"移动网络下优选 IP 列表",entries:ipData?.data?.CM||[],highlightIps})
      ),
      h("section",{className:"grid-2"},
        h(DnsRecordsPanel,{records:dnsRecords,loading:loadingDns,highlightIps,onRefresh:refreshDns}),
        h(LogPanel,{log})
      )
    ),
    h("footer",{className:"footer muted small"},
      "Cloudflare 优选 IP 同步面板 · 数据来源 vps789.com · DNS 服务 华为云"
    ),
    h(HelpDialog,{open:helpOpen,onClose:()=>setHelpOpen(false)}),
    h(AutoConfigDialog,{open:autoOpen,onClose:()=>setAutoOpen(false),onSaved:handleAutoSaved,currentConfig:config}),
    h(ClearDialog,{open:clearOpen,onClose:()=>setClearOpen(false),onCleared:handleCleared,
      recordName:config?.recordName,
      zoneARecordCount,
      hostnameARecordCount})
  );
}

function ConfigBanner({config,tokenExpired,tokenNearExpire,onAutoConfig,onRefreshToken,refreshingToken}){
  // 没有 token 或 KV 未绑定：黄色提示
  if(!config)return null;
  const needSetup=!config.hasToken;
  const tokenPill=tokenExpired
    ? h("span",{className:"pill bad"},"Token 已过期")
    : tokenNearExpire
      ? h("span",{className:"pill warn"},"Token " + config.tokenRemainLabel + " 后过期")
      : h("span",{className:"pill good"},"Token 有效 " + config.tokenRemainLabel);

  if(!config.hasKv){
    return h("div",{className:"alert",style:{margin:"12px 24px 0"}},
      h("strong",null,"⚠ 未绑定 KV："),
      " 请在 Worker 的 Settings → Bindings 中创建命名空间并绑定变量名 ",
      h("span",{className:"mono"},"KV"),
      "，否则无法持久化配置。",
      h("span",{style:{marginLeft:6,color:"var(--muted)",fontSize:".8125rem"}},tokenPill)
    );
  }
  if(needSetup){
    return h("div",{className:"alert",style:{margin:"12px 24px 0"}},
      h("strong",null,"尚未配置："),
      " 请点击右上角 “自动化配置” 填写华为云账号/IAM 用户/密码，Worker 将自动获取 Token 并写 KV，后续会自动续期。",
      h("span",{style:{marginLeft:8}},tokenPill)
    );
  }
  // 已配置：紧凑状态条
  return h("div",{className:"alert info",style:{margin:"12px 24px 0",display:"flex",flexWrap:"wrap",gap:14,alignItems:"center"}},
    h("span",null,
      h("strong",null,"账号：")," ",
      h("span",{className:"mono"},config.username + "@" + config.domain)
    ),
    h("span",null,
      h("strong",null,"区域：")," ",
      h("span",{className:"mono"},config.region || "—")
    ),
    h("span",null,
      h("strong",null,"项目：")," ",
      h("span",{className:"mono"},config.projectId || "—"),
      config.projectName ? " (" + config.projectName + ")" : null
    ),
    h("span",null,tokenPill),
    h("span",{style:{flex:1}}),
    h("span",{style:{color:"var(--muted)",fontSize:".8125rem"}},
      config.autoRefreshEnabled ? "✓ 已开启自动续期（剩余 < 1h 时自动换新）" : "未开启自动续期")
  );
}

try{
  const root=createRoot(document.getElementById("root"));
  root.render(h(Dashboard));
  __bootErr("[boot] ✓ 渲染完成");
}catch(e){
  __bootErr("[render error] "+(e?.message||e)+"\n"+(e?.stack||""));
}
</script>
</body>
</html>`;

/* ============================================================
 * 3. Worker 入口
 * ============================================================ */

export default {
  /**
   * 定时任务入口（每 15 分钟执行一次）
   */
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runJob(env));
  },

  /**
   * HTTP 入口
   * GET /              -> 管理面板 HTML
   * GET /api/sync      -> 立即执行一次同步
   * GET /api/records   -> 查询 DNS A 记录
   * GET /api/ips       -> 拉取优选 IP 数据
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // 简单的可选鉴权（如果设置了 ADMIN_KEY）
    const needAuth = !!env.ADMIN_KEY;
    const authorized = !needAuth || url.searchParams.get("key") === env.ADMIN_KEY;

    // 静态资源：根路径 / 或 /index.html
    if (path === "/" || path === "/index.html") {
      return new Response(HTML_PAGE, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-cache",
        },
      });
    }

    // favicon
    if (path === "/favicon.ico") {
      return new Response(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#f48120"/><text x="50%" y="58%" text-anchor="middle" font-size="28" font-family="sans-serif" font-weight="700" fill="white">CF</text></svg>`,
        { headers: { "Content-Type": "image/svg+xml" } }
      );
    }

    // API: 立即同步
    if (path === "/api/sync") {
      if (!authorized) {
        return jsonResp({ ok: false, error: "Unauthorized" }, 401);
      }
      const result = await runJob(env);
      return jsonResp(result);
    }

    // API: 查询 DNS 记录
    if (path === "/api/records") {
      if (!authorized) {
        return jsonResp({ ok: false, error: "Unauthorized" }, 401);
      }
      try {
        const auth = await ensureFreshToken(env);
        if (!auth.token) throw new Error("尚未配置 IAM Token，请先点 “自动化配置”");
        const region = auth.region || env.HUAWEI_REGION || "cn-north-4";
        const zoneId = env.HUAWEI_ZONE_ID;
        if (!zoneId) throw new Error("缺少环境变量 HUAWEI_ZONE_ID");
        const records = await listHuaWeiRecordsets(auth, region, zoneId);
        return jsonResp({ ok: true, records });
      } catch (e) {
        return jsonResp({ ok: false, error: e.message }, 500);
      }
    }

    // API: 拉取优选 IP
    if (path === "/api/ips") {
      try {
        const r = await fetch(CF_IP_API, {
          headers: { "User-Agent": "cf-workers-cfip-sync/2.0" },
        });
        if (!r.ok) {
          return jsonResp(
            { ok: false, error: `vps789 接口失败: HTTP ${r.status}` },
            502
          );
        }
        const data = await r.json();
        return new Response(JSON.stringify(data), {
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Access-Control-Allow-Origin": "*",
          },
        });
      } catch (e) {
        return jsonResp({ ok: false, error: e.message }, 500);
      }
    }

    // API: 自动化配置（登录华为云 IAM 拿 Token 并写入 KV）
    // POST { domain, username, password, region }
    if (path === "/api/auto-config" && request.method === "POST") {
      if (!authorized) return jsonResp({ ok: false, error: "Unauthorized" }, 401);
      try {
        const body = await request.json().catch(() => ({}));
        const domain = (body.domain || "").trim();
        const username = (body.username || "").trim();
        const password = body.password || "";
        const region = (body.region || "").trim();
        if (!domain) throw new Error("请填写华为云账号名（domain）");
        if (!username) throw new Error("请填写 IAM 用户名");
        if (!password) throw new Error("请填写 IAM 密码");
        if (!region) throw new Error("请选择 region（区域）");

        // 先尝试拉取新 Token 验证账号
        const fresh = await fetchIamTokenByPassword({ domain, username, password, region });
        if (!fresh.projectId) {
          throw new Error("登录成功但未返回 project_id，请确认该 IAM 用户在 " + region + " 区域有权限");
        }
        // 合并：保留旧的 accountId/其他字段，写入新 token
        const prev = await loadAuth(env);
        const next = {
          ...prev,
          domain,
          username,
          password,
          region,
          token: fresh.token,
          tokenExpiresAt: fresh.expiresAtMs,
          projectId: fresh.projectId,
          projectName: fresh.projectName || prev.projectName || region,
          accountId: fresh.accountId || prev.accountId || "",
        };
        await saveAuth(env, next);
        return jsonResp({
          ok: true,
          message: "自动化配置成功！Token 已写入 KV，有效期 " + formatRemain(fresh.expiresAtMs),
          config: {
            region,
            projectId: fresh.projectId,
            projectName: next.projectName,
            accountId: next.accountId,
            tokenExpiresAt: fresh.expiresAtMs,
            tokenRemainLabel: formatRemain(fresh.expiresAtMs),
          },
        });
      } catch (e) {
        return jsonResp({ ok: false, error: e.message }, 500);
      }
    }

    // API: 查看当前生效配置（Token 不返回明文，只显示剩余有效期）
    if (path === "/api/config") {
      if (!authorized) return jsonResp({ ok: false, error: "Unauthorized" }, 401);
      try {
        const cfg = await loadAuth(env);
        const hasCred = !!(cfg.domain && cfg.username && cfg.password);
        return jsonResp({
          ok: true,
          config: {
            region: cfg.region || env.HUAWEI_REGION || "",
            projectId: cfg.projectId || env.HUAWEI_PROJECT_ID || "",
            projectName: cfg.projectName || "",
            accountId: cfg.accountId || "",
            domain: cfg.domain || "",
            username: cfg.username || "",
            hasPassword: !!cfg.password,
            hasToken: !!cfg.token,
            tokenExpiresAt: cfg.tokenExpiresAt || 0,
            tokenRemainLabel: cfg.token ? formatRemain(cfg.tokenExpiresAt) : "未配置",
            hasKv: !!env.KV,
            autoRefreshEnabled: hasCred,
            zoneId: env.HUAWEI_ZONE_ID || "",
            recordName: env.RECORD_NAME || "",
          },
        });
      } catch (e) {
        return jsonResp({ ok: false, error: e.message }, 500);
      }
    }

    // API: 强制刷新 Token（不依赖剩余有效期）
    if (path === "/api/refresh-token" && request.method === "POST") {
      if (!authorized) return jsonResp({ ok: false, error: "Unauthorized" }, 401);
      try {
        const cfg = await loadAuth(env);
        if (!cfg.domain || !cfg.username || !cfg.password) {
          throw new Error("未配置账号/密码，无法自动续期。请先点 “自动化配置” 填写。");
        }
        const fresh = await fetchIamTokenByPassword({
          domain: cfg.domain,
          username: cfg.username,
          password: cfg.password,
          region: cfg.region,
        });
        const next = { ...cfg, ...fresh };
        await saveAuth(env, next);
        return jsonResp({
          ok: true,
          message: "Token 已刷新，" + formatRemain(fresh.expiresAtMs) + " 后过期",
          tokenRemainLabel: formatRemain(fresh.expiresAtMs),
        });
      } catch (e) {
        return jsonResp({ ok: false, error: e.message }, 500);
      }
    }

    // API: 清空 A 记录
    //   POST { scope: "hostname" | "zone", confirm: "CLEAR" }
    //     - scope=hostname（默认）：仅清 RECORD_NAME 下的 A 记录集
    //     - scope=zone：清空整个 zone 下的所有 A 记录集（慎用！）
    //   必须带 confirm: "CLEAR" 二次确认字
    if (path === "/api/clear-records" && request.method === "POST") {
      if (!authorized) return jsonResp({ ok: false, error: "Unauthorized" }, 401);
      try {
        const body = await request.json().catch(() => ({}));
        const scope = (body.scope || "hostname").toLowerCase();
        const confirm = (body.confirm || "").toString();
        if (confirm !== "CLEAR") {
          throw new Error("缺少二次确认：confirm 字段必须为 \"CLEAR\"");
        }
        if (scope !== "hostname" && scope !== "zone") {
          throw new Error("scope 仅支持 hostname 或 zone");
        }
        const auth = await ensureFreshToken(env);
        if (!auth.token) throw new Error("尚未配置 IAM Token，请先点 “自动化配置”");
        const region = auth.region || env.HUAWEI_REGION || "cn-north-4";
        const zoneId = env.HUAWEI_ZONE_ID;
        if (!zoneId) throw new Error("缺少环境变量 HUAWEI_ZONE_ID");

        // 1) 列出该 zone 下全部 A 记录
        const all = await listHuaWeiRecordsets(auth, region, zoneId);
        let targets = all.filter((r) => r.type === "A");
        let scopeNote = "";
        if (scope === "hostname") {
          if (!env.RECORD_NAME) throw new Error("scope=hostname 时必须设置环境变量 RECORD_NAME");
          const targetName = normalizeDnsName(env.RECORD_NAME);
          targets = targets.filter((r) => normalizeDnsName(r.name) === targetName);
          scopeNote = `（主机 ${env.RECORD_NAME}）`;
        } else {
          scopeNote = "（整个 zone）";
        }
        if (targets.length === 0) {
          // 顺便把全 zone 的 A 记录 name 列表返回，方便前端排查 "为什么 hostname 没匹配上"
          const allA = all.filter((r) => r.type === "A").map((r) => r.name);
          return jsonResp({
            ok: true,
            message: scope === "hostname"
              ? `主机记录 ${env.RECORD_NAME} 下没有 A 记录，无需清空`
              : "该 zone 下没有 A 记录，无需清空",
            scope,
            count: 0,
            deleted: [],
            allZoneANames: allA,
            matchedName: env.RECORD_NAME,
            normalizedMatchedName: scope === "hostname" ? normalizeDnsName(env.RECORD_NAME) : null,
          });
        }

        // 2) 逐条删除
        const deleted = [];
        const failed = [];
        for (const r of targets) {
          try {
            await deleteHuaWeiRecordset(auth, region, zoneId, r.id);
            deleted.push({ id: r.id, name: r.name, records: r.records || [] });
          } catch (e) {
            failed.push({ id: r.id, name: r.name, error: e.message });
          }
        }
        const summary = {
          ok: failed.length === 0,
          message:
            `已清空 ${deleted.length} 条 A 记录` + scopeNote +
            (failed.length ? `；${failed.length} 条失败` : ""),
          scope,
          count: deleted.length,
          deleted,
          failed,
        };
        return jsonResp(summary, failed.length === 0 ? 200 : 207);
      } catch (e) {
        return jsonResp({ ok: false, error: e.message }, 500);
      }
    }

    return new Response("Not Found", { status: 404 });
  },
};

function jsonResp(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
