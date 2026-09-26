// The welcome window's buttons. Main does the work; this only asks.

const bridge = window.frameStudioWelcome;
const error = document.getElementById('error');

async function run(action) {
  error.hidden = true;
  // One folder at a time: the buttons wait while this one opens.
  const buttons = [...document.querySelectorAll('button')];
  for (const b of buttons) b.disabled = true;
  try {
    const problem = await action();
    if (problem) {
      error.textContent = problem;
      error.hidden = false;
    }
  } catch (err) {
    error.textContent = String(err && err.message ? err.message : err);
    error.hidden = false;
  } finally {
    for (const b of buttons) b.disabled = false;
  }
}

document.getElementById('new').addEventListener('click', () => run(() => bridge.newFolder()));
document.getElementById('open').addEventListener('click', () => run(() => bridge.openFolder()));

const list = document.getElementById('recent');
for (const path of bridge.recent) {
  const item = document.createElement('li');
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = path;
  button.title = path;
  button.addEventListener('click', () => run(() => bridge.openRecent(path)));
  item.append(button);
  list.append(item);
}
document.getElementById('recent-section').hidden = bridge.recent.length === 0;
