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
</style>
</head>
<body>
<aside>
  <h1>Sessions</h1>
  <div id="sessions"></div>
  <div class="row" style="justify-content:flex-start;margin-top:12px">
    <button class="ghost" id="refresh">Refresh</button>
  </div>
</aside>
<main>
  <header>
    <strong id="title">Not connected</strong>
    <span class="who" id="who"></span>
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
    <button class="ghost" value="no" id="deny">No</button>
    <button value="yes" id="allow">Yes</button>
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

  let socket, nextId = 1, sessionId = null, streaming = null;
  const waiting = new Map();

  const note = (text, cls) => {
    const el = document.createElement('div');
    el.className = 'msg note ' + (cls || '');
    el.textContent = text;
    $('log').append(el);
    $('log').scrollTop = $('log').scrollHeight;
  };

  const message = (role, text) => {
    const el = document.createElement('div');
    el.className = 'msg ' + role;
    const label = document.createElement('span');
    label.className = 'role';
    label.textContent = role === 'user' ? 'You' : 'Robin';
    el.append(label, document.createTextNode(text));
    $('log').append(el);
    $('log').scrollTop = $('log').scrollHeight;
    return el;
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
      meta.textContent = s.cwd;
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

    if (event.kind === 'text') {
      if (!streaming) streaming = message('assistant', '');
      streaming.append(document.createTextNode(event.delta));
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

  for (const [id, approved] of [['allow', true], ['deny', false]]) {
    $(id).onclick = () => {
      const approvalId = $('approval').dataset.id;
      $('approval').close();
      request('approval.answer', { approvalId, approved }).catch(() => {});
    };
  }

  $('refresh').onclick = () => refresh();

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
