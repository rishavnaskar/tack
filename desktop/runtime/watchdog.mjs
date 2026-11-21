// Loaded into the coach process with --import. If the desktop shell goes away
// without stopping us (crash, force quit), shut down instead of holding the port.

const parent = process.ppid;
let since = 0;

setInterval(() => {
  if (process.ppid === parent) return;
  if (!since) {
    since = Date.now();
    process.kill(process.pid, 'SIGTERM');
  } else if (Date.now() - since > 5000) {
    process.exit(0);
  }
}, 1000).unref();
