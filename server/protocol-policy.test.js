import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ERR_SESSION_EXPIRED,
  SESSION_PAUSE_MS,
  accountSendBlocked,
  applySessionExpiry,
  ensureScannerAllowed,
  interpretQrStatus,
  isSenderAllowed,
  isStaleToken,
  loginPersistPlan,
  nextVerifyBlockAction,
  normalizeRedirectBase,
} from "./protocol-policy.js";
import { applyAllowFromPolicy, isAllowed, loadState, paths, saveState, updateState } from "./store.js";

test("binded_redirect does not persist a bot_token", () => {
  const plan = loginPersistPlan({
    status: "binded_redirect",
    bot_token: "should-not-be-written",
    ilink_bot_id: "bot-1",
    ilink_user_id: "user-1",
    baseurl: "https://evil.example",
  });
  assert.equal(plan.persist, false);
  assert.equal(plan.writeToken, false);
  assert.equal(plan.alreadyBound, true);
  assert.equal(plan.account, undefined);
});

test("confirmed login persists server baseurl and scanner id", () => {
  const plan = loginPersistPlan(
    {
      status: "confirmed",
      bot_token: "tok",
      ilink_bot_id: "bot-1",
      ilink_user_id: "scanner@im.wechat",
      baseurl: "https://idc.example",
    },
    "https://ilinkai.weixin.qq.com",
  );
  assert.equal(plan.persist, true);
  assert.equal(plan.writeToken, true);
  assert.equal(plan.account.baseUrl, "https://idc.example");
  assert.equal(plan.account.needsRelogin, false);
  assert.equal(plan.allowFromAdd, "scanner@im.wechat");
});

test("confirmed without baseurl keeps the previous base", () => {
  const plan = loginPersistPlan(
    { status: "confirmed", bot_token: "tok", ilink_bot_id: "bot-1", ilink_user_id: "u" },
    "https://previous.example",
  );
  assert.equal(plan.account.baseUrl, "https://previous.example");
});

test("confirmed without token or bot id is not a login", () => {
  assert.equal(loginPersistPlan({ status: "confirmed", bot_token: "tok" }).persist, false);
  assert.equal(loginPersistPlan({ status: "confirmed", ilink_bot_id: "bot" }).persist, false);
});

test("QR statuses map to verify, redirect, and continue", () => {
  assert.equal(interpretQrStatus({ status: "need_verifycode" }).action, "need_verifycode");
  assert.equal(interpretQrStatus({ status: "verify_code_blocked" }).action, "verify_code_blocked");
  assert.equal(interpretQrStatus({ status: "scaned" }).action, "continue");
  assert.equal(interpretQrStatus({ status: "expired" }).action, "expired");
  const redirect = interpretQrStatus({
    status: "scaned_but_redirect",
    redirect_host: "https://sz.ilink.example/",
  });
  assert.equal(redirect.action, "redirect");
  assert.equal(redirect.baseUrl, "https://sz.ilink.example");
  assert.equal(normalizeRedirectBase(""), "");
  assert.equal(
    interpretQrStatus({ status: "scaned_but_redirect" }).baseUrl,
    "",
  );
});

test("verify_code_blocked refresh limit matches official counter", () => {
  assert.deepEqual(nextVerifyBlockAction(1), { refresh: true, qrRefreshCount: 2, stop: false });
  assert.deepEqual(nextVerifyBlockAction(2), { refresh: true, qrRefreshCount: 3, stop: false });
  assert.equal(nextVerifyBlockAction(3).stop, true);
  assert.equal(nextVerifyBlockAction(3).refresh, false);
});

test("empty allowlist denies everyone; scanner is added on login", () => {
  assert.equal(isSenderAllowed([], "anyone"), false);
  assert.equal(isSenderAllowed(undefined, "anyone"), false);
  assert.equal(isSenderAllowed(["scanner"], "scanner"), true);
  assert.equal(isSenderAllowed(["scanner"], "other"), false);
  assert.deepEqual(ensureScannerAllowed([], "scanner@im.wechat"), ["scanner@im.wechat"]);
  assert.deepEqual(ensureScannerAllowed(["scanner@im.wechat"], "scanner@im.wechat"), ["scanner@im.wechat"]);
  assert.deepEqual(ensureScannerAllowed(["a"], "  "), ["a"]);
});

test("legacy empty allowlist seeds stored scanner ids once", () => {
  const seeded = applyAllowFromPolicy(
    {
      accounts: [{ ilinkUserId: "owner@im.wechat" }, { ilinkUserId: "owner@im.wechat" }, { ilinkUserId: "" }],
      allowFrom: [],
    },
    { allowFrom: [] },
  );
  assert.deepEqual(seeded.allowFrom, ["owner@im.wechat"]);
  assert.equal(seeded.allowFromPolicy, "deny");
  assert.equal(isAllowed(seeded, "owner@im.wechat"), true);
  assert.equal(isAllowed(seeded, "stranger"), false);

  const explicit = applyAllowFromPolicy(
    { accounts: [{ ilinkUserId: "owner" }], allowFrom: ["friend"] },
    {},
  );
  assert.deepEqual(explicit.allowFrom, ["friend"]);

  const cleared = applyAllowFromPolicy(
    { accounts: [{ ilinkUserId: "owner" }], allowFrom: [], allowFromPolicy: "deny" },
    { allowFromPolicy: "deny", allowFrom: [] },
  );
  assert.deepEqual(cleared.allowFrom, []);
  assert.equal(isAllowed(cleared, "owner"), false);
});

test("session errcode -14 pauses the account for at least one hour", () => {
  assert.equal(isStaleToken({ ret: ERR_SESSION_EXPIRED }), true);
  assert.equal(isStaleToken({ errcode: ERR_SESSION_EXPIRED }), true);
  assert.equal(isStaleToken({ ret: 0 }), false);
  assert.ok(SESSION_PAUSE_MS >= 60 * 60 * 1000);
  assert.notEqual(SESSION_PAUSE_MS, 60_000);

  const now = 1_700_000_000_000;
  const next = applySessionExpiry({ token: "expired-token", needsRelogin: false }, now);
  assert.equal(next.needsRelogin, true);
  assert.equal(next.sessionPausedUntil - now, SESSION_PAUSE_MS);

  const during = accountSendBlocked(next, now + 60_000);
  assert.equal(during.blocked, true);
  assert.equal(during.reason, "needs_relogin");
  assert.ok(during.remainingMs >= SESSION_PAUSE_MS - 60_000);

  const afterPause = accountSendBlocked(next, now + SESSION_PAUSE_MS + 1);
  assert.equal(afterPause.blocked, true);
  assert.equal(afterPause.reason, "needs_relogin");
  assert.equal(afterPause.remainingMs, 0);

  assert.equal(accountSendBlocked({ token: "ok", needsRelogin: false, sessionPausedUntil: 0 }, now).blocked, false);
});

test("every account.json write is mode 600 and legacy allowlist loads deny-by-default", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-wechat-"));
  const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-wechat-legacy-"));
  const prev = process.env.GROK_WECHAT_HOME;
  process.env.GROK_WECHAT_HOME = dir;
  try {
    saveState({
      accounts: [],
      pendingQrs: [],
      allowFrom: ["scanner"],
      allowFromPolicy: "deny",
    });
    const file = paths().state;
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    updateState((s) => {
      s.allowFrom.push("friend");
      return s;
    });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(saved.allowFrom, ["scanner", "friend"]);

    process.env.GROK_WECHAT_HOME = legacyDir;
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, "account.json"), JSON.stringify({
      token: "legacy-token",
      ilinkUserId: "owner@im.wechat",
      ilinkBotId: "bot-legacy",
      allowFrom: [],
    }));
    const loaded = loadState();
    assert.deepEqual(loaded.allowFrom, ["owner@im.wechat"]);
    assert.equal(loaded.allowFromPolicy, "deny");
    assert.equal(isAllowed(loaded, "stranger"), false);
    updateState((s) => s);
    assert.equal(fs.statSync(paths().state).mode & 0o777, 0o600);
  } finally {
    if (prev === undefined) delete process.env.GROK_WECHAT_HOME;
    else process.env.GROK_WECHAT_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(legacyDir, { recursive: true, force: true });
  }
});
