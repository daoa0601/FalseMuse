export const PAGE: string = String.raw`<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>OptChat</title><style>
body{font:16px system-ui;margin:40px auto;padding:0 20px;max-width:850px;color:#e3e7ef;background:#15181d}
button,input,textarea{font:inherit;padding:10px;border:1px solid #49515e;background:#252a33;color:inherit}
textarea{width:100%;box-sizing:border-box;min-height:100px}button{cursor:pointer;margin:8px 8px 8px 0}
pre{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.5}small{color:#aab3c2}article{border-top:1px solid #39404a;padding:12px 0}
</style><h1>OptChat</h1><p>One chat, permanent memory.</p>
<form id="login"><input name="key" type="password" placeholder="Owner key" required><button>Sign in</button></form>
<main hidden>
  <small id="status"></small>
  <p><button id="connect">Connect ChatGPT subscription</button><span id="device"></span></p>
  <details><summary>Sandbox fallback</summary>
    <p id="sandbox-status"></p>
    <button id="sandbox-start">Start Sandbox</button>
    <button id="sandbox-save">Save workspace and stop</button>
    <button id="sandbox-connect">Connect Sandbox subscription</button>
    <span id="sandbox-device"></span>
  </details>
  <details><summary>Scheduled prompts</summary>
    <section id="schedules"></section>
    <form id="schedule">
      <textarea name="prompt" placeholder="What should the assistant do?" required></textarea>
      <label>Start <input type="datetime-local" name="at" required></label>
      <label>Repeat every <input type="number" name="every_minutes" min="0" value="0"> minutes; zero runs once</label>
      <button>Schedule</button>
    </form>
  </details>
  <section id="permissions"></section><section id="jobs"></section><section id="messages"></section>
  <form id="send"><textarea name="text" placeholder="Your message" required></textarea>
    <button>Send</button><button type="button" id="cancel">Stop reply</button>
  </form>
</main>
<p id="error" role="alert"></p><script>
const select = (selector) => document.querySelector(selector);

async function api(path, body) {
  const response = await fetch('/api/' + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const value = await response.json();
  if (!response.ok) {
    const error = new Error(value.error || response.statusText);
    error.status = response.status;
    throw error;
  }
  return value;
}

function messageElement(message) {
  const article = document.createElement('article');
  const label = document.createElement('small');
  label.textContent = message.kind + ' · ' + message.date;
  const text = document.createElement('pre');
  text.textContent = message.text;
  article.append(label, text);
  return article;
}

function jobElement(job) {
  const article = document.createElement('article');
  const task = document.createElement('pre');
  task.textContent = job.machine + ' · ' + job.cwd + '\n' + job.task;
  article.append(task);
  if (job.report) {
    const report = document.createElement('pre');
    report.textContent = job.status + ' · ' + job.report;
    article.append(report);
    return article;
  }
  const button = document.createElement('button');
  const action = job.status === 'approval' ? 'approve' : 'abort';
  button.textContent = action === 'approve' ? 'Approve Pi task' : 'Abort task';
  button.onclick = async () => {
    try { await api('jobs/' + job.id + '/' + action, {}); await refreshJobs(); }
    catch (error) { select('#error').textContent = error.message; }
  };
  article.append(button);
  return article;
}

async function refresh() {
  try {
    const status = await api('status');
    select('#error').textContent = '';
    select('#login').hidden = true;
    select('main').hidden = false;
    select('#status').textContent = status.messages + ' messages · ' + status.nodes +
      ' summaries · subscription ' + (status.authenticated ? 'connected' : 'disconnected') +
      ' · ' + status.pending + ' queued' + (status.error ? ' · ' + status.error : '');
    const messages = await api('messages');
    select('#messages').replaceChildren(...messages.map(messageElement));
  } catch (error) {
    if (error.status !== 401) select('#error').textContent = error.message;
  }
}

async function refreshJobs() {
  try {
    const jobs = await api('jobs');
    select('#jobs').replaceChildren(...jobs.map(jobElement));
  } catch (error) {
    if (error.status !== 401) select('#error').textContent = error.message;
  }
}

async function refreshPermissions() {
  try {
    const permissions = await api('permissions');
    select('#permissions').replaceChildren(...permissions.map((permission) => {
      const article = document.createElement('article');
      const title = document.createElement('strong');
      title.textContent = permission.title + ' · ' + permission.machine;
      const details = document.createElement('pre');
      details.textContent = permission.message;
      article.append(title, details);
      for (const allowed of [true, false]) {
        const button = document.createElement('button');
        button.textContent = allowed ? 'Allow this tool call' : 'Deny';
        button.onclick = async () => {
          try {
            await api('permissions/' + permission.job + '/' + permission.request, { allowed });
            await refreshPermissions();
          } catch (error) { select('#error').textContent = error.message; }
        };
        article.append(button);
      }
      return article;
    }));
  } catch (error) {
    if (error.status !== 401) select('#error').textContent = error.message;
  }
}

async function refreshSchedules() {
  try {
    const schedules = await api('schedules');
    select('#schedules').replaceChildren(...schedules.map((schedule) => {
      const article = document.createElement('article');
      const text = document.createElement('pre');
      text.textContent = schedule.prompt + '\n' +
        (schedule.enabled ? 'Next: ' + new Date(schedule.at).toLocaleString() : 'Stopped or completed');
      article.append(text);
      if (schedule.enabled) {
        const button = document.createElement('button');
        button.textContent = 'Cancel schedule';
        button.onclick = async () => {
          try { await api('schedules/' + schedule.id + '/cancel', {}); await refreshSchedules(); }
          catch (error) { select('#error').textContent = error.message; }
        };
        article.append(button);
      }
      return article;
    }));
  } catch (error) {
    if (error.status !== 401) select('#error').textContent = error.message;
  }
}

async function refreshSandbox() {
  try {
    const sandbox = await api('sandbox');
    select('#sandbox-status').textContent = sandbox.state +
      ' · subscription ' + (sandbox.authenticated ? 'connected' : 'disconnected') +
      (sandbox.repository ? ' · ' + sandbox.repository : '') + (sandbox.error ? ' · ' + sandbox.error : '');
  } catch (error) {
    if (error.status !== 401) select('#error').textContent = error.message;
  }
}

for (const action of ['start', 'save']) select('#sandbox-' + action).onclick = async () => {
  try { await api('sandbox/' + action, {}); await refreshSandbox(); }
  catch (error) { select('#error').textContent = error.message; }
};

select('#sandbox-connect').onclick = async () => {
  try {
    const device = await api('sandbox/auth/start', {});
    const link = document.createElement('a');
    link.href = device.url;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = 'Open Sandbox device login';
    select('#sandbox-device').replaceChildren(link, document.createTextNode(' — code ' + device.code));
  } catch (error) { select('#error').textContent = error.message; }
};

select('#schedule').onsubmit = async (event) => {
  event.preventDefault();
  try {
    await api('schedules', {
      prompt: event.target.prompt.value,
      at: new Date(event.target.at.value).toISOString(),
      every_minutes: Number(event.target.every_minutes.value),
    });
    event.target.reset();
    await refreshSchedules();
  } catch (error) { select('#error').textContent = error.message; }
};

select('#login').onsubmit = async (event) => {
  event.preventDefault();
  const response = await fetch('/login', { method: 'POST', body: new FormData(event.target) });
  if (response.ok) { event.target.reset(); await refresh(); await refreshJobs(); await refreshPermissions(); await refreshSchedules(); await refreshSandbox(); }
  else select('#error').textContent = 'Sign-in failed';
};

select('#send').onsubmit = async (event) => {
  event.preventDefault();
  try {
    await api('chat', { text: event.target.text.value });
    event.target.reset();
    await refresh();
  } catch (error) { select('#error').textContent = error.message; }
};

select('#cancel').onclick = async () => {
  try { await api('cancel', {}); await refresh(); }
  catch (error) { select('#error').textContent = error.message; }
};

select('#connect').onclick = async () => {
  try {
    const device = await api('auth/start', {});
    const link = document.createElement('a');
    link.href = device.url;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = 'Open device login';
    select('#device').replaceChildren(link, document.createTextNode(' — code ' + device.code));
  } catch (error) { select('#error').textContent = error.message; }
};

refresh();
refreshJobs();
refreshPermissions();
refreshSchedules();
refreshSandbox();
setInterval(() => { refresh(); refreshJobs(); refreshPermissions(); refreshSchedules(); refreshSandbox(); }, 5000);
</script></html>`;
