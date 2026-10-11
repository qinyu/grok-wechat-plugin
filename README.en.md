# grok-wechat-plugin

[中文](README.md) | [English](README.en.md)

WeChat iLink channel for Grok Bot. After QR bind, DMs wake the matching dedicated assistant via a shared webhook. The assistant can reply with text or media and show a typing indicator.

## Capabilities

- **QR login**, one connector binds multiple WeChat personal accounts; each account gets a dedicated Grok Bot assistant
- **DM text**: Markdown is flattened to plain text; long messages are split automatically
- **Voice**: handled as transcription text
- **Media**: receive and send images, videos, and files (inbound media is saved locally)
- **Typing**: turn on before a reply, off after send
- **Allowlist**: deny by default. A successful scan adds the scanner's `ilink_user_id`; an empty list does not accept everyone. Use `wechat_approve` for anyone else
- **Global webhook**: paste once; it covers every current and future bound account

## One-line install

Send this in Grok Bot:

```
Install this WeChat plugin https://github.com/little-thing/grok-wechat-plugin
```

## Binding

Follow the conversation. The full flow looks like this:

![Install, confirm the channel, paste webhook once, scan QR](docs/bind-flow.png)

1. **Confirm the channel**  
   Tap **加** in the chat to attach the WeChat channel to Grok Bot.

2. **Connector and shared routines**  
   The installing assistant adds the WeChat connector and creates two routines: **「微信入站唤醒」** (webhook) and **「微信监听保活」** (every 5 minutes, `wechat_start_monitor`). Creating the webhook routine does not return url/key to the agent; the user copies them once from that routine's panel and sends them. The assistant calls `wechat_set_wake` to write global `wake.json` for all current and future bound accounts.

3. **Scan to log in**  
   `wechat_login_start` shows a QR code, then immediately `wechat_login_wait` until `logged_in=true`. After each bind, **create a dedicated Grok Bot assistant** for that WeChat number and call `wechat_set_dedicated_assistant` with its id and name; dedicated assistants do not create inbound routines. Bind more accounts by repeating start and wait — no second webhook paste.

4. **Binding complete**  
   `wechat_status` shows `global_wake_configured=true` and each account's `dedicated_assistant_name`. Inbound: installing assistant `wechat_inbox`, then forwards by `ilink_bot_id` to that account's dedicated assistant.

When someone DMs you on WeChat, the bot can reply there.

## After binding

Talk in WeChat as usual:

![Send a WeChat DM and get a reply](docs/bind-effect.png)

The assistant can show typing while it works. Text, voice transcriptions, images, videos, and files are all handled; outbound media uses a local file path on the Grok Bot machine.

The scanning user is added to the allowlist automatically. To let someone else talk, have the assistant call `wechat_approve`. An empty list rejects every DM. To unbind one number, ask to log that WeChat account out; omit the account to log all of them out.

## Protocol behavior (aligned with official iLink 2.4.10)

Three behaviors now follow Tencent `@tencent-weixin/openclaw-weixin@2.4.10`. The Grok shell (MCP, webhook, inbox, dedicated assistants) stays:

1. **Login states.** `need_verifycode` asks the user for the digits shown on the phone, then calls `wechat_login_wait` with `verify_code`. `verify_code_blocked` refreshes the QR and stops after repeated failures. `scaned_but_redirect` keeps polling on the server's `redirect_host`. `binded_redirect` means already bound and does **not** write a new `bot_token`. A successful login stores the server `baseurl`.
2. **Session expiry (ret/errcode -14).** That account pauses for at least 1 hour and is marked `needs_relogin`. Send and typing are refused while it is paused, and the monitor does not keep calling with the expired token after a 60s sleep. Every write of `account.json` uses mode `600`.
3. **Allowlist.** The scanner's `ilink_user_id` is added to `allowFrom` on login. An empty list rejects everyone.

## Multiple accounts

One connector binds multiple WeChat personal accounts. One global webhook covers all of them; each new bind gets its own QR scan and dedicated assistant. `wechat_status` shows `global_wake_configured` and per-account dedicated assistant names.

## Flow

WeChat DM → monitor inbox → POST shared webhook → installing assistant wakes → `wechat_inbox` → forward by `ilink_bot_id` to dedicated assistant → `wechat_send` / `wechat_send_media`

After a task finishes, reply immediately.

`bot_agent` is `Grokbot/1.0.0`.

See `skills/wechat-channel/SKILL.md` for install details.

## One-line uninstall

Send this in Grok Bot:

```
Uninstall the WeChat plugin
```

The installing assistant will:

1. Call `wechat_uninstall` to clean the machine and read `dedicated_assistants_sidebar_delete` for dedicated assistant names.
2. Remove the `grok-wechat` connector.
3. Delete Routine「微信入站唤醒」and「微信监听保活」on the installing assistant, and remove any leftover copies on other assistants.
4. Tell the user to right-click → Delete the dedicated assistants listed in the uninstall response (e.g. 微信1, 微信2) in the sidebar.

Removing the connector from Settings also triggers local monitor cleanup. After a clean uninstall, reinstall requires a fresh webhook paste and QR scan; `wechat_status` shows zero accounts.
