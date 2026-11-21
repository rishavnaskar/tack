const $ = (id) => document.getElementById(id);
const form = $('form');
const input = $('key');
const status = $('status');
const buttons = ['save', 'clear', 'cancel'].map($);

function show(text, tone = '') {
  status.textContent = text;
  status.className = `status ${tone}`;
}

function describe(s) {
  if (!s) return show('');
  if (s.configured) {
    show(`Model ready: ${s.model}${s.saved ? ` (saved key ${s.saved})` : ' (key from the environment or a .env file)'}`, 'ok');
  } else {
    show('No model key yet. The demo works without one; résumé reading and plans need it.');
  }
  $('clear').hidden = !s.saved;
}

async function submit(key) {
  buttons.forEach((b) => { b.disabled = true; });
  show('Restarting the coach…');
  const res = await window.tack.save(key);
  buttons.forEach((b) => { b.disabled = false; });
  if (!res.ok) return show(res.error, 'error');
  input.value = '';
  describe(res.status);
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const key = input.value.trim();
  if (!key) return show('Paste a key first.', 'error');
  void submit(key);
});
$('clear').addEventListener('click', () => void submit(''));
$('cancel').addEventListener('click', () => window.tack.close());
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.tack.close(); });

window.tack.status().then(describe);
