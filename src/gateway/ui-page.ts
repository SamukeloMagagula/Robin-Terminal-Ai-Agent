/**
 * The control UI, as one self-contained page.
 *
 * A string rather than a file because `tsc` is the whole build here — it emits
 * JavaScript and copies nothing, so an .html beside it would never reach dist/.
 * No framework and no bundler for the same reason: the moment this needs a
 * build step, `npm run build` stops being one command.
 *
 * Everything is inline, which is what lets the Content-Security-Policy be as
 * tight as it is: nothing is fetched from anywhere.
 */
export function controlUiPage(protocolVersion: number): string {
  return PAGE.replace('__PROTOCOL__', String(protocolVersion));
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Robin</title>
<style>
  :root {
    --bg: #0e1116; --panel: #161b22; --line: #262d36; --text: #d7dde5;
    --muted: #8b949e; --accent: #6ea8fe; --warn: #e3b341; --bad: #f85149;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; height: 100vh; display: grid; grid-template-columns: 260px 1fr;
    background: var(--bg); color: var(--text);
    font: 14px/1.55 ui-monospace, SFMono-Regular, Consolas, monospace;
  }
  aside { border-right: 1px solid var(--line); overflow-y: auto; padding: 12px; }
  aside h1 { font-size: 13px; letter-spacing: .12em; text-transform: uppercase; color: var(--muted); margin: 0 0 10px; }
  .session { padding: 8px; border-radius: 6px; cursor: pointer; border: 1px solid transparent; }
  .session:hover { background: var(--panel); }
  .session.on { background: var(--panel); border-color: var(--accent); }
  .session .name { color: var(--text); }
  .session .meta { color: var(--muted); font-size: 12px; word-break: break-all; }
  .tag { font-size: 11px; padding: 1px 5px; border-radius: 4px; border: 1px solid var(--line); color: var(--muted); }
  .tag.busy { color: var(--warn); border-color: var(--warn); }
  main { display: flex; flex-direction: column; min-width: 0; }
  header { padding: 10px 14px; border-bottom: 1px solid var(--line); display: flex; gap: 10px; align-items: center; }
  header .who { color: var(--muted); }
  #log { flex: 1; overflow-y: auto; padding: 14px; }
  .msg { margin-bottom: 14px; white-space: pre-wrap; word-wrap: break-word; }
  .msg .role { color: var(--muted); font-size: 12px; display: block; margin-bottom: 2px; }
  .msg.user .role { color: var(--accent); }
  .msg.note { color: var(--muted); font-size: 13px; }
  .msg.bad { color: var(--bad); }
  form { display: flex; gap: 8px; padding: 12px; border-top: 1px solid var(--line); }
  textarea {
    flex: 1; resize: none; height: 62px; background: var(--panel); color: var(--text);
    border: 1px solid var(--line); border-radius: 6px; padding: 8px; font: inherit;
  }
  button {
    background: var(--accent); color: #08101f; border: 0; border-radius: 6px;
    padding: 0 16px; font: inherit; font-weight: 600; cursor: pointer;
  }
  button.ghost { background: transparent; color: var(--text); border: 1px solid var(--line); }
  dialog {
    background: var(--panel); color: var(--text); border: 1px solid var(--accent);
    border-radius: 8px; padding: 16px; max-width: 560px; font: inherit;
  }
  dialog pre { white-space: pre-wrap; word-break: break-all; background: var(--bg); padding: 10px; border-radius: 6px; }
  dialog .from { color: var(--warn); }
  .row { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
  .bar { display: flex; gap: 6px; margin-bottom: 10px; flex-wrap: wrap; }
  .bar button { padding: 4px 10px; font-size: 12px; }
  select {
    background: var(--panel); color: var(--text); border: 1px solid var(--line);
    border-radius: 6px; padding: 4px 6px; font: inherit; font-size: 12px; max-width: 100%;
  }
  /* Rendered markdown. The terminal styles these too; same reading either way. */
  .msg strong { color: #fff; }
  .msg em { color: var(--text); }
  .msg code {
    background: #0b0f14; color: #f0b072; padding: 1px 4px; border-radius: 4px;
    font-size: 12.5px;
  }
  .msg pre {
    background: #0b0f14; border: 1px solid var(--line); border-radius: 6px;
    padding: 10px; overflow-x: auto; margin: 8px 0;
  }
  .msg pre code { background: none; padding: 0; color: #d7dde5; }
  .msg h1, .msg h2, .msg h3 { color: var(--accent); margin: 12px 0 6px; font-size: 15px; }
  .msg ul, .msg ol { margin: 6px 0; padding-left: 22px; }
  .msg blockquote {
    margin: 6px 0; padding-left: 10px; border-left: 2px solid var(--line); color: var(--muted);
  }
  .msg a { color: var(--accent); }
</style>
</head>
<body>
<aside>
  <h1>Sessions</h1>
  <div class="bar">
    <button class="ghost" id="refresh">Refresh</button>
    <button class="ghost" id="close">Close</button>
  </div>
  <div id="sessions"></div>
  <h1 style="margin-top:16px">New conversation</h1>
  <div class="bar">
    <select id="provider"></select>
    <select id="model"></select>
  </div>
  <div class="bar">
    <button id="create">Start</button>
  </div>
</aside>
<main>
  <header>
    <strong id="title">Not connected</strong>
    <span class="who" id="who"></span>
    <button class="ghost" id="stop" style="margin-left:auto;display:none">Stop</button>
  </header>
  <div id="log"></div>
  <form id="ask">
    <textarea id="text" placeholder="Message Robin…  (Enter to send, Shift+Enter for a newline)"></textarea>
    <button id="send">Send</button>
  </form>
</main>

<dialog id="approval">
  <div><strong>Robin wants to do something</strong></div>
  <div class="from" id="approvalFrom"></div>
  <pre id="approvalWhat"></pre>
  <div class="row">
    <button class="ghost" id="denyAll">No, stop asking</button>
    <button class="ghost" id="deny">No</button>
    <button id="allow">Yes</button>
    <button id="allowAll">Yes, stop asking</button>
  </div>
</dialog>

<script>
(() => {
  const $ = (id) => document.getElementById(id);

  // The token arrives in the URL because a browser cannot read ~/.robin. It is
  // taken out of the address bar immediately: a URL is history, a bookmark, and
  // a referrer, and this one runs commands.
  const url = new URL(location.href);
  let token = url.searchParams.get('token') || sessionStorage.getItem('robin-token') || '';
  if (url.searchParams.has('token')) {
    sessionStorage.setItem('robin-token', token);
    url.searchParams.delete('token');
    history.replaceState(null, '', url.toString());
  }

  let socket, nextId = 1, sessionId = null, streaming = null, currentTurn = null;
  const waiting = new Map();

  const note = (text, cls) => {
    const el = document.createElement('div');
    el.className = 'msg note ' + (cls || '');
    el.textContent = text;
    $('log').append(el);
    $('log').scrollTop = $('log').scrollHeight;
  };

  // The same rules the terminal renders by: markers styled away, and nothing
  // inside code touched, because that text is source.
  //
  // Backticks cannot appear literally in this file — the whole page is a
  // template literal and one would end it — so the patterns that need them are
  // built from a character code.
  const BT = String.fromCharCode(96);
  const CODE_SPAN = new RegExp(BT + '([^' + BT + ']+)' + BT, 'g');
  const FENCE_LINE = new RegExp('^\\s*' + BT + BT + BT + '(.*)$');
  // A sentinel the model cannot type, so lifted code spans go back exactly
  // where they came from.
  const MARK = String.fromCharCode(1);
  const NL = String.fromCharCode(10);

  const escapeHtml = (t) =>
    String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  function inline(text) {
    const code = [];
    let out = escapeHtml(text).replace(CODE_SPAN, (m, c) => {
      code.push(c);
      return MARK + (code.length - 1) + MARK;
    });
    // Only http(s). This reaches innerHTML, and a javascript: href would run
    // in the page that holds the gateway token.
    out = out.replace(/\\[([^\\]]+)\\]\\(([^)\\s]+)\\)/g, (m, label, href) =>
      /^https?:\\/\\//i.test(href)
        ? '<a href="' + href + '" target="_blank" rel="noreferrer noopener">' + label + '</a>'
        : label + ' (' + href + ')');
    out = out.replace(/\\*\\*(\\S(?:[^*]*\\S)?)\\*\\*/g, '<strong>$1</strong>');
    out = out.replace(/~~(\\S(?:[^~]*\\S)?)~~/g, '<del>$1</del>');
    out = out.replace(/\\*(\\S(?:[^*]*\\S)?)\\*/g, '<em>$1</em>');
    // Word boundaries, or snake_case turns italic.
    out = out.replace(/(^|[^\\w])_(\\S(?:[^_]*\\S)?)_(?![\\w])/g, '$1<em>$2</em>');
    // Put the code spans back. Split rather than match: a pattern here has to
    // survive a template literal and a JS string before the regex engine sees
    // it, and one that does not fails silently, leaving the marker on screen.
    const parts = out.split(MARK);
    let restored = '';
    for (let i = 0; i < parts.length; i += 1) {
      restored += i % 2 === 1 ? '<code>' + code[Number(parts[i])] + '</code>' : parts[i];
    }
    return restored;
  }

  function renderMarkdown(text) {
    const lines = String(text).split(NL);
    let html = '';
    let list = null;
    let fence = null;
    const closeList = () => {
      if (list) { html += '</' + list + '>'; list = null; }
    };
    const flushFence = () => {
      html += '<pre><code>' + escapeHtml(fence.join(NL)) + '</code></pre>';
      fence = null;
    };

    for (const line of lines) {
      if (FENCE_LINE.test(line)) {
        if (fence === null) { closeList(); fence = []; } else { flushFence(); }
        continue;
      }
      if (fence !== null) { fence.push(line); continue; }
      if (!line.trim()) { closeList(); continue; }

      const heading = /^(#{1,6})\\s+(.*)$/.exec(line);
      if (heading) { closeList(); html += '<h3>' + inline(heading[2]) + '</h3>'; continue; }

      if (/^\\s*([-*_])\\s*(?:\\s*){2,}$/.test(line)) { closeList(); html += '<hr>'; continue; }

      const quote = /^\\s*>\\s?(.*)$/.exec(line);
      if (quote) {
        closeList();
        html += '<blockquote>' + inline(quote[1]) + '</blockquote>';
        continue;
      }

      const numbered = /^\\s*(\\d+)\\.\\s+(.*)$/.exec(line);
      if (numbered) {
        if (list !== 'ol') { closeList(); html += '<ol>'; list = 'ol'; }
        html += '<li>' + inline(numbered[2]) + '</li>';
        continue;
      }

      const bullet = /^\\s*[-*+]\\s+(.*)$/.exec(line);
      if (bullet) {
        if (list !== 'ul') { closeList(); html += '<ul>'; list = 'ul'; }
        html += '<li>' + inline(bullet[1]) + '</li>';
        continue;
      }

      closeList();
      html += '<div>' + inline(line) + '</div>';
    }
    closeList();
    // An unclosed fence is still the answer.
    if (fence !== null) flushFence();
    return html;
  }

  const message = (role, text) => {
    const el = document.createElement('div');
    el.className = 'msg ' + role;
    const label = document.createElement('span');
    label.className = 'role';
    label.textContent = role === 'user' ? 'You' : 'Robin';
    const body = document.createElement('div');
    if (role === 'user') body.textContent = text;
    else body.innerHTML = renderMarkdown(text);
    // What the model actually wrote, so a streaming reply can be re-rendered
    // as it grows without reconstructing it from the DOM.
    body.dataset.raw = text;
    el.append(label, body);
    $('log').append(el);
    $('log').scrollTop = $('log').scrollHeight;
    return body;
  };

  function request(method, params) {
    return new Promise((resolve, reject) => {
      const id = String(nextId++);
      waiting.set(id, { resolve, reject });
      socket.send(JSON.stringify({ type: 'req', id, method, params: params || {} }));
    });
  }

  function renderSessions(list) {
    $('sessions').replaceChildren();
    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = 'session meta';
      empty.textContent = 'None open. Send a message to start one.';
      $('sessions').append(empty);
      return;
    }
    for (const s of list) {
      const el = document.createElement('div');
      el.className = 'session' + (s.id === sessionId ? ' on' : '');
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = s.label || (s.providerName + ' · ' + s.model);
      const meta = document.createElement('div');
      meta.className = 'meta';
      const spent = s.tokens && (s.tokens.input || s.tokens.output)
        ? '  ·  ' + (s.tokens.input + s.tokens.output).toLocaleString() + ' tokens'
        : '';
      meta.textContent = s.cwd + spent;
      const tags = document.createElement('div');
      const origin = document.createElement('span');
      origin.className = 'tag';
      origin.textContent = s.origin;
      tags.append(origin);
      if (s.busy) {
        const busy = document.createElement('span');
        busy.className = 'tag busy';
        busy.textContent = s.queued ? 'busy +' + s.queued : 'busy';
        tags.append(' ', busy);
      }
      if (s.autoApprove) {
        const auto = document.createElement('span');
        auto.className = 'tag busy';
        auto.textContent = 'auto-approves';
        tags.append(' ', auto);
      }
      el.append(name, meta, tags);
      el.onclick = () => attach(s.id);
      $('sessions').append(el);
    }
  }

  async function refresh() {
    const { sessions } = await request('session.list');
    renderSessions(sessions);
    return sessions;
  }

  async function attach(id) {
    if (sessionId !== null && sessionId !== id) {
      await request('session.detach', { id: sessionId }).catch(() => {});
    }
    const result = await request('session.attach', { id });
    sessionId = id;
    $('log').replaceChildren();
    for (const m of result.history) {
      if (m.role === 'user' || (m.role === 'assistant' && m.content)) {
        message(m.role === 'user' ? 'user' : 'assistant', m.content);
      }
    }
    $('title').textContent = result.snapshot.providerName + ' · ' + result.snapshot.model;
    $('who').textContent = result.snapshot.cwd;
    await refresh();
  }

  function onEvent(sid, event) {
    if (event.kind === 'approval.request') return ask(event);
    if (event.kind === 'approval.resolved') {
      if ($('approval').open && $('approval').dataset.id === event.approvalId) $('approval').close();
      return;
    }
    if (sid !== sessionId) return;

    if (event.kind === 'turn.started') {
      currentTurn = event.turnId;
      $('stop').style.display = '';
      return;
    }
    if (event.kind === 'text') {
      if (!streaming) streaming = message('assistant', '');
      streaming.dataset.raw += event.delta;
      streaming.innerHTML = renderMarkdown(streaming.dataset.raw);
      $('log').scrollTop = $('log').scrollHeight;
    } else if (event.kind === 'tool.auto_approved') {
      note('$ ' + event.command);
    } else if (event.kind === 'tool.output') {
      note(event.chunk);
    } else if (event.kind === 'fallback') {
      note(event.message + ' — trying ' + event.providerName + ' · ' + event.model);
    } else if (event.kind === 'trim') {
      note('Dropped the oldest ' + event.dropped + ' message(s) to fit ' + event.limit + ' tokens.');
    } else if (event.kind === 'session.changed') {
      $('title').textContent = event.snapshot.providerName + ' · ' + event.snapshot.model;
      refresh();
    } else if (event.kind === 'turn.finished') {
      streaming = null;
      currentTurn = null;
      $('stop').style.display = 'none';
      if (event.aborted) note('Interrupted.');
      else if (!event.ok) note('✖ ' + (event.error || 'The turn failed.'), 'bad');
      refresh();
    }
  }

  function ask(event) {
    const dialog = $('approval');
    dialog.dataset.id = event.approvalId;
    $('approvalFrom').textContent =
      event.origin.surface === 'terminal'
        ? ''
        : 'Requested from ' + event.origin.surface + (event.origin.who ? ' by ' + event.origin.who : '');
    $('approvalWhat').textContent = event.request.message;
    dialog.showModal();
  }

  // The two wide answers are the user saying once what they would otherwise
  // say to every near-identical request in a row.
  const answers = [
    ['allow', true, 'once'],
    ['deny', false, 'once'],
    ['allowAll', true, 'session'],
    ['denyAll', false, 'reply'],
  ];
  for (const [id, approved, scope] of answers) {
    $(id).onclick = () => {
      const approvalId = $('approval').dataset.id;
      $('approval').close();
      request('approval.answer', { approvalId, approved, scope }).catch(() => {});
    };
  }

  $('refresh').onclick = () => refresh();

  // A browser cannot read ~/.robin, so it asks what it may use.
  async function loadProviders() {
    const { providers } = await request('providers.list');
    const usable = providers.filter((p) => p.authenticated);
    $('provider').replaceChildren();
    for (const p of usable) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name;
      $('provider').append(opt);
    }
    if (!usable.length) {
      const opt = document.createElement('option');
      opt.textContent = 'nothing logged in';
      $('provider').append(opt);
      $('create').disabled = true;
      return;
    }
    await loadModels();
  }

  async function loadModels() {
    const providerId = $('provider').value;
    $('model').replaceChildren();
    const loading = document.createElement('option');
    loading.textContent = 'loading…';
    $('model').append(loading);
    try {
      const { models } = await request('providers.models', { providerId });
      $('model').replaceChildren();
      for (const m of models) {
        const opt = document.createElement('option');
        opt.value = m;
        // A local server reports the weights file it is serving, which is a
        // path and a hash; the tail is the only readable part of it.
        opt.textContent = m.length > 44 ? '…' + m.slice(-40) : m;
        $('model').append(opt);
      }
    } catch (err) {
      $('model').replaceChildren();
      const failed = document.createElement('option');
      failed.textContent = 'could not list models';
      $('model').append(failed);
      note('✖ ' + err.message, 'bad');
    }
  }

  $('provider').onchange = () => loadModels();

  $('create').onclick = async () => {
    try {
      const created = await request('session.create', {
        providerId: $('provider').value,
        model: $('model').value,
        cwd: 'browser',
      });
      await attach(created.id);
    } catch (err) {
      note('✖ ' + err.message, 'bad');
    }
  };

  $('close').onclick = async () => {
    if (sessionId === null) return;
    const closing = sessionId;
    sessionId = null;
    await request('session.close', { id: closing }).catch(() => {});
    $('log').replaceChildren();
    $('title').textContent = 'No session';
    $('who').textContent = '';
    const sessions = await refresh();
    if (sessions.length) await attach(sessions[0].id);
  };

  $('stop').onclick = () => {
    if (currentTurn) request('turn.interrupt', { turnId: currentTurn }).catch(() => {});
  };

  $('ask').onsubmit = async (e) => {
    e.preventDefault();
    const text = $('text').value.trim();
    if (!text) return;
    $('text').value = '';

    if (sessionId === null) {
      note('No session selected — open one from the left, or start Robin in a terminal.', 'bad');
      return;
    }
    message('user', text);
    streaming = null;
    try {
      await request('prompt.send', { id: sessionId, text });
    } catch (err) {
      note('✖ ' + err.message, 'bad');
    }
  };

  $('text').onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      $('ask').requestSubmit();
    }
  };

  function connect() {
    socket = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);

    socket.onopen = () => {
      const id = String(nextId++);
      waiting.set(id, {
        resolve: async (hello) => {
          $('title').textContent = 'Connected';
          renderSessions(hello.sessions);
          if (hello.daemonStale) {
            // The page you are looking at was served by this daemon, so it is
            // as old as the daemon is. Reloading will not help; the daemon has
            // to be restarted first.
            note(
              'The gateway is older than the build on disk. Run "robin gateway stop", then ' +
                '"robin ui" to start it again — this page came from the older build too, so ' +
                'reloading it on its own will not help.',
              'bad'
            );
          }
          void loadProviders();
          const mine = hello.sessions.find((s) => s.origin === 'terminal') || hello.sessions[0];
          if (mine) await attach(mine.id);
          else note('No sessions open yet. Start one with "robin chat", or send a message once one exists.');
        },
        reject: (err) => {
          note('✖ ' + err.message, 'bad');
          if (/token/i.test(err.message)) {
            sessionStorage.removeItem('robin-token');
            note('Re-open this page with "robin ui" to get a fresh link.', 'bad');
          }
        },
      });
      socket.send(JSON.stringify({
        type: 'req', id, method: 'connect',
        params: { token, kind: 'terminal', canApprove: true, cwd: 'browser', protocol: __PROTOCOL__ },
      }));
    };

    socket.onmessage = (e) => {
      const frame = JSON.parse(e.data);
      if (frame.type === 'event') return onEvent(frame.sessionId, frame.event);
      if (frame.type !== 'res') return;
      const pending = waiting.get(frame.id);
      if (!pending) return;
      waiting.delete(frame.id);
      if (frame.ok) pending.resolve(frame.result);
      else pending.reject(new Error(frame.error.message));
    };

    socket.onclose = () => {
      $('title').textContent = 'Disconnected';
      note('The gateway went away. Retrying in 2s…');
      setTimeout(connect, 2000);
    };
  }

  if (!token) note('No token. Open this page with "robin ui".', 'bad');
  else connect();
})();
</script>
</body>
</html>`;
