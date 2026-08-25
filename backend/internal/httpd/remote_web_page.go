package httpd

// remoteWebLoginPage is the credential prompt served at / on the network
// listener. It is the only page the daemon serves to an unauthenticated caller,
// so it is written to be self-contained: one inline style block, one inline
// script, no images, no fonts, no fetch to anywhere but this daemon. A page that
// pulled a subresource would either need its own authenticated route or would
// leak the daemon's existence to whatever host it pulled from.
//
// On success the token goes to sessionStorage rather than to a readable cookie
// or the URL. The client needs it for the Authorization header and the terminal
// stream's subprotocol, so it has to be reachable from JavaScript; sessionStorage
// keeps it out of the address bar and out of every log that records one, and
// drops it when the tab closes.
const remoteWebLoginPage = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Connect to Agent Orchestrator</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center;
    justify-content: center; padding: 24px;
    font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    background: #f6f6f7; color: #1c1c1f;
  }
  main { width: 100%; max-width: 22rem; }
  h1 { font-size: 1.125rem; margin: 0 0 0.25rem; }
  p.sub { margin: 0 0 1.5rem; opacity: 0.7; font-size: 0.875rem; }
  label { display: block; font-size: 0.8125rem; margin-bottom: 0.375rem; opacity: 0.8; }
  input, button {
    width: 100%; font: inherit; border-radius: 6px;
    border: 1px solid rgba(128, 128, 128, 0.4); padding: 0.5rem 0.625rem;
    background: #fff; color: inherit;
  }
  button {
    margin-top: 0.75rem; background: #1c1c1f; color: #fff;
    border-color: #1c1c1f; cursor: pointer;
  }
  button[disabled] { opacity: 0.6; cursor: default; }
  p.msg { margin: 0.875rem 0 0; font-size: 0.8125rem; min-height: 1.25rem; }
  p.msg[data-kind="error"] { color: #b4232a; }
  p.note {
    margin: 1.5rem 0 0; font-size: 0.75rem; opacity: 0.7;
    border-top: 1px solid rgba(128, 128, 128, 0.25); padding-top: 0.75rem;
  }
  @media (prefers-color-scheme: dark) {
    body { background: #131316; color: #ececee; }
    input { background: #1c1c20; }
    button { background: #ececee; color: #131316; border-color: #ececee; }
    p.msg[data-kind="error"] { color: #ff8b8b; }
  }
</style>
</head>
<body>
<main>
  <h1>Agent Orchestrator</h1>
  <p class="sub">Enter the connection password shown on the host machine.</p>
  <form id="f" autocomplete="off">
    <label for="pw">Connection password</label>
    <input id="pw" name="pw" type="password" autocomplete="current-password"
           autocapitalize="off" autocorrect="off" spellcheck="false" required>
    <button id="go" type="submit">Connect</button>
  </form>
  <p class="msg" id="msg" role="status" aria-live="polite"></p>
  <p class="note" id="note" hidden>
    This connection is not encrypted. Use it only on a network you trust, or put
    an encrypted proxy in front of the daemon.
  </p>
</main>
<script>
(function () {
  var TOKEN_KEY = "ao.remote.token";
  var VERSION_KEY = "ao.remote.serverVersion";
  var APP = "/app/";
  var form = document.getElementById("f");
  var input = document.getElementById("pw");
  var button = document.getElementById("go");
  var msg = document.getElementById("msg");

  function say(text, kind) {
    msg.textContent = text;
    msg.setAttribute("data-kind", kind || "info");
  }

  function stored(key) {
    try { return window.sessionStorage.getItem(key); } catch (e) { return null; }
  }

  if (location.protocol !== "https:") {
    document.getElementById("note").hidden = false;
  }
  if (stored(TOKEN_KEY)) {
    location.replace(APP);
    return;
  }

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    var password = input.value;
    if (!password) return;
    button.disabled = true;
    say("Connecting...");
    fetch("/api/v1/remote/session", {
      method: "POST",
      headers: { "Authorization": "Bearer " + password },
    }).then(function (response) {
      if (response.status === 401) throw new Error("That password was not accepted.");
      if (response.status === 429) throw new Error("Too many attempts. Wait a minute and try again.");
      if (!response.ok) throw new Error("The server answered with status " + response.status + ".");
      return response.json();
    }).then(function (body) {
      try {
        window.sessionStorage.setItem(TOKEN_KEY, body.token);
        window.sessionStorage.setItem(VERSION_KEY, body.appVersion || "");
      } catch (e) {
        throw new Error("This browser is blocking storage, which the client needs.");
      }
      location.replace(APP);
    }).catch(function (error) {
      button.disabled = false;
      input.select();
      say(error && error.message ? error.message : "Could not reach the server.", "error");
    });
  });
})();
</script>
</body>
</html>
`
