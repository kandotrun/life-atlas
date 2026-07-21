function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function loginHtml(message = "", retryAfterSeconds?: number): string {
  const safeMessage = escapeHtml(message);
  const retryText = retryAfterSeconds
    ? `<p class="retry">次の試行まで約 ${Math.max(1, Math.ceil(retryAfterSeconds))} 秒です。</p>`
    : "";
  const alert = safeMessage
    ? `<div class="alert" role="alert" aria-live="polite"><strong>${safeMessage}</strong>${retryText}</div>`
    : "";

  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
  <meta name="robots" content="noindex,nofollow,noarchive" />
  <meta name="referrer" content="no-referrer" />
  <title>Life Atlas — Private Access</title>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
  <link rel="stylesheet" href="/login.css" />
</head>
<body>
  <main class="login-shell">
    <section class="login-card" aria-labelledby="login-title">
      <div class="brand-mark" aria-hidden="true"><span></span><span></span><span></span></div>
      <p class="eyebrow">PRIVATE LOCATION ARCHIVE</p>
      <h1 id="login-title">Life Atlas</h1>
      <p class="lead">移動履歴ダッシュボードへアクセスします。</p>
      ${alert}
      <form action="/login" method="post">
        <label for="password">アクセスパスワード</label>
        <input id="password" name="password" type="password" maxlength="128" autocomplete="current-password" required autofocus />
        <button type="submit">地図を開く</button>
      </form>
      <p class="policy">日本国内限定 · パスワード照合は全体で1分に1回</p>
    </section>
  </main>
</body>
</html>`;
}

export function geoBlockedHtml(): string {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Access unavailable</title></head><body><main><h1>アクセスできません</h1><p>このページは日本国内のネットワークからのみ利用できます。</p></main></body></html>`;
}

export const loginCss = `
:root{color-scheme:dark;--bg:#07100d;--panel:#0d1915;--line:#21342c;--text:#ecf7f1;--muted:#8ea59a;--accent:#71f5b2;--danger:#ff9c91;font-family:Inter,"Noto Sans JP",system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}*{box-sizing:border-box}html,body{margin:0;min-height:100%;background:var(--bg);color:var(--text)}body{background-image:radial-gradient(circle at 15% 20%,rgba(113,245,178,.09),transparent 34%),linear-gradient(rgba(113,245,178,.025) 1px,transparent 1px),linear-gradient(90deg,rgba(113,245,178,.025) 1px,transparent 1px);background-size:auto,32px 32px,32px 32px}.login-shell{min-height:100vh;min-height:100dvh;display:grid;place-items:center;padding:24px}.login-card{width:min(440px,100%);padding:36px;border:1px solid var(--line);border-radius:20px;background:rgba(13,25,21,.94);box-shadow:0 30px 90px rgba(0,0,0,.38)}.login-card.compact{padding-bottom:40px}.brand-mark{display:flex;gap:7px;align-items:end;height:28px;margin-bottom:28px}.brand-mark span{display:block;width:5px;border-radius:8px;background:var(--accent)}.brand-mark span:nth-child(1){height:11px;opacity:.55}.brand-mark span:nth-child(2){height:20px;opacity:.78}.brand-mark span:nth-child(3){height:28px}.eyebrow{margin:0 0 9px;color:var(--accent);font:700 11px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.18em}.login-card h1{margin:0;font-size:clamp(32px,8vw,50px);line-height:1;letter-spacing:-.045em}.lead{margin:18px 0 28px;color:var(--muted);line-height:1.7}.alert{margin:0 0 22px;padding:13px 14px;border:1px solid rgba(255,156,145,.35);border-radius:10px;background:rgba(255,156,145,.08);color:var(--danger);font-size:13px;line-height:1.5}.retry{margin:4px 0 0;color:var(--muted)}form{display:grid;gap:12px}label{font-size:12px;color:var(--muted);font-weight:700;letter-spacing:.04em}input{width:100%;min-height:50px;padding:0 15px;border:1px solid var(--line);border-radius:10px;background:#08120e;color:var(--text);font:inherit;outline:none}input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(113,245,178,.12)}button{min-height:50px;margin-top:4px;border:0;border-radius:10px;background:var(--accent);color:#06100c;font:800 14px/1 inherit;cursor:pointer}button:hover{filter:brightness(1.06)}button:focus-visible{outline:3px solid rgba(113,245,178,.35);outline-offset:3px}.policy{margin:22px 0 0;color:#63786e;font:600 10px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.08em;text-transform:uppercase}@media(max-width:520px){.login-shell{padding:14px}.login-card{padding:28px 22px;border-radius:16px}}`;

export const faviconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#07100d"/><path d="M32 10c-10.5 0-19 8.5-19 19 0 14.2 19 26 19 26s19-11.8 19-26c0-10.5-8.5-19-19-19Zm0 27a8 8 0 1 1 0-16 8 8 0 0 1 0 16Z" fill="#71f5b2"/></svg>`;
