/**
 * iLink 协议决策，对齐 @tencent-weixin/openclaw-weixin@2.4.10。
 * 纯函数，不访问网络或磁盘。
 */

export const FIXED_QR_BASE = "https://ilinkai.weixin.qq.com";
export const DEFAULT_BASE = "https://ilinkai.weixin.qq.com";
export const ERR_SESSION_EXPIRED = -14;
/** 与官方 session-guard 相同：过期后按账号暂停一小时，而不是 60 秒后继续用旧 token。 */
export const SESSION_PAUSE_MS = 60 * 60 * 1000;
/** 与 login-qr.ts 相同：qrRefreshCount 从 1 起，超过 3 则停止刷新。 */
export const MAX_QR_REFRESH_COUNT = 3;

export function isStaleToken(data) {
  if (!data || typeof data !== "object") return false;
  return data.errcode === ERR_SESSION_EXPIRED || data.ret === ERR_SESSION_EXPIRED;
}

export function normalizeRedirectBase(redirectHost) {
  if (!redirectHost || typeof redirectHost !== "string") return "";
  const host = redirectHost.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  if (!host) return "";
  return `https://${host}`;
}

export function interpretQrStatus(statusResponse) {
  const status = statusResponse?.status || "wait";
  switch (status) {
    case "need_verifycode":
      return { action: "need_verifycode", status };
    case "verify_code_blocked":
      return { action: "verify_code_blocked", status };
    case "scaned_but_redirect":
      return {
        action: "redirect",
        status,
        baseUrl: normalizeRedirectBase(statusResponse?.redirect_host),
      };
    case "binded_redirect":
      return { action: "already_bound", status, writeToken: false };
    case "confirmed":
      return {
        action: "confirmed",
        status,
        writeToken: true,
        token: statusResponse?.bot_token || "",
        ilinkBotId: statusResponse?.ilink_bot_id || "",
        ilinkUserId: statusResponse?.ilink_user_id || "",
        baseUrl: typeof statusResponse?.baseurl === "string" ? statusResponse.baseurl.trim() : "",
      };
    case "expired":
      return { action: "expired", status };
    case "scaned":
    case "wait":
    default:
      return { action: "continue", status };
  }
}

/**
 * 只有 confirmed 且同时带 bot_token 与 ilink_bot_id 才写入账号。
 * binded_redirect 即使带 bot_token 也不写入（官方 2.4.10 把它当成已绑定，不发新凭证）。
 */
export function loginPersistPlan(statusResponse, fallbackBase = DEFAULT_BASE) {
  const decision = interpretQrStatus(statusResponse);
  if (decision.action === "already_bound") {
    return { persist: false, alreadyBound: true, writeToken: false, action: decision.action };
  }
  if (decision.action !== "confirmed" || !decision.token || !decision.ilinkBotId) {
    return {
      persist: false,
      alreadyBound: false,
      writeToken: false,
      action: decision.action === "confirmed" ? "incomplete" : decision.action,
    };
  }
  const baseUrl = decision.baseUrl || fallbackBase || DEFAULT_BASE;
  return {
    persist: true,
    alreadyBound: false,
    writeToken: true,
    action: "confirmed",
    account: {
      token: decision.token,
      ilinkBotId: decision.ilinkBotId,
      ilinkUserId: decision.ilinkUserId || "",
      baseUrl,
      needsRelogin: false,
      sessionPausedUntil: 0,
    },
    allowFromAdd: (decision.ilinkUserId || "").trim(),
  };
}

export function nextVerifyBlockAction(qrRefreshCount = 1) {
  const next = (Number(qrRefreshCount) || 1) + 1;
  if (next > MAX_QR_REFRESH_COUNT) {
    return { refresh: false, qrRefreshCount: next, stop: true };
  }
  return { refresh: true, qrRefreshCount: next, stop: false };
}

export function ensureScannerAllowed(allowFrom, ilinkUserId) {
  const list = Array.isArray(allowFrom) ? [...allowFrom] : [];
  const id = typeof ilinkUserId === "string" ? ilinkUserId.trim() : "";
  if (id && !list.includes(id)) list.push(id);
  return list;
}

/** 空 allowlist 拒绝所有人。只有名单内的 user id 可以入站。 */
export function isSenderAllowed(allowFrom, userId) {
  if (!userId) return false;
  if (!Array.isArray(allowFrom) || allowFrom.length === 0) return false;
  return allowFrom.includes(userId);
}

export function applySessionExpiry(account, now = Date.now()) {
  return {
    ...(account || {}),
    needsRelogin: true,
    sessionPausedUntil: now + SESSION_PAUSE_MS,
  };
}

export function accountSendBlocked(account, now = Date.now()) {
  if (!account?.token && !account?.needsRelogin) {
    return { blocked: false, reason: "", remainingMs: 0 };
  }
  const until = Number(account?.sessionPausedUntil) || 0;
  const remainingMs = Math.max(0, until - now);
  if (account?.needsRelogin) {
    return { blocked: true, reason: "needs_relogin", remainingMs };
  }
  if (remainingMs > 0) {
    return { blocked: true, reason: "paused", remainingMs };
  }
  return { blocked: false, reason: "", remainingMs: 0 };
}

export function sessionBlockedMessage(block) {
  if (block?.remainingMs > 0) {
    const mins = Math.ceil(block.remainingMs / 60_000);
    return `会话已失效（errcode -14），该账号已暂停 ${mins} 分钟并需要重新登录。暂停期间拒绝发送与正在输入，也不会继续使用过期 token。请 wechat_login_start 重新扫码。`;
  }
  return "会话已失效（errcode -14），该账号需要重新登录。过期 token 不再使用。请 wechat_login_start 重新扫码。";
}
