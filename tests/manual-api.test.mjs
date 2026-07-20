/*
 * Tests for the fully-manual "bring your own API" flow.
 *
 * These drive the REAL app: they launch it in Electron with an isolated
 * --user-data-dir (never touches your real sessions), mock window.fetch so no
 * real network call is made, and assert the setup + settings behaviour.
 *
 * Run:  node tests/manual-api.test.mjs
 * Needs: node_modules/electron (installed as a dev dependency).
 */
import { spawn, execSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const electron = path.join(appDir, 'node_modules', 'electron', 'dist', 'electron.exe');
const userData = path.join(process.env.TEMP || '/tmp', 'sb-manualapi-test');
const PORT = 9466;

if (!existsSync(electron)) { console.error('electron dev binary missing — run npm install'); process.exit(2); }
if (existsSync(userData)) rmSync(userData, { recursive: true, force: true });

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userData}`], { cwd: appDir, env, stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));
let ws, msgId = 1;
function raw(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = msgId++;
    const onMsg = ev => { const m = JSON.parse(ev.data); if (m.id === id) { ws.removeEventListener('message', onMsg); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); } };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const r = await raw('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('eval threw: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
}

// ---- tiny assertion harness ----
const results = [];
function check(name, cond, detail = '') { results.push({ name, pass: !!cond, detail }); }

// Install a fetch spy + reset app AI state. Returns nothing.
const RESET_AND_SPY = `(() => {
  window.__calls = [];
  window.fetch = (u, o) => { window.__calls.push(String(u)); return Promise.resolve(new Response(JSON.stringify({choices:[{message:{content:'hi'}}]}), { status:200, headers:{'Content-Type':'application/json'} })); };
  ['sc-api-key','sc-api-url','sc-model','sc-setup-done'].forEach(k => localStorage.removeItem(k));
})()`;

try {
  // wait for CDP + page
  let target;
  for (let i = 0; i < 40 && !target; i++) {
    try { const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); target = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl); } catch {}
    if (!target) await sleep(500);
  }
  if (!target) throw new Error('CDP target never appeared');
  ws = await new Promise((res, rej) => { const w = new WebSocket(target.webSocketDebuggerUrl); w.onopen = () => res(w); w.onerror = rej; });
  await sleep(3000); // let the app boot

  // sanity: app actually loaded its script
  const booted = await evaluate(`typeof testAiConnection === 'function' && typeof showSetup === 'function'`);
  check('app script loaded', booted);

  // T1: auto-detect was fully removed
  check('detectProvider removed', await evaluate(`typeof detectProvider === 'undefined'`));

  // T2: setup requires the endpoint URL (key alone is NOT enough anymore)
  await evaluate(RESET_AND_SPY);
  await evaluate(`showSetup(); suKey.value='sk-manual-test'; suUrl.value=''; suModel.value=''; suResult.textContent=''; suSave.click();`);
  await sleep(600);
  const t2 = await evaluate(`JSON.stringify({ calls: window.__calls.length, result: suResult.textContent, savedUrl: localStorage.getItem('sc-api-url'), setupDone: localStorage.getItem('sc-setup-done'), setupVisible: setupView.classList.contains('show') })`);
  const j2 = JSON.parse(t2);
  check('blank URL blocks save (no network probe)', j2.calls === 0, t2);
  check('blank URL shows required-field error', /endpoint/i.test(j2.result), t2);
  check('blank URL does not save url / setup-done', j2.savedUrl === null && j2.setupDone === null, t2);
  check('setup stays open on missing field', j2.setupVisible === true, t2);

  // T3: setup requires the model too
  await evaluate(RESET_AND_SPY);
  await evaluate(`showSetup(); suKey.value='sk-x'; suUrl.value='https://my.test/v1/chat/completions'; suModel.value=''; suResult.textContent=''; suSave.click();`);
  await sleep(600);
  const j3 = JSON.parse(await evaluate(`JSON.stringify({ calls: window.__calls.length, result: suResult.textContent })`));
  check('blank model blocks save', j3.calls === 0 && /model/i.test(j3.result), JSON.stringify(j3));

  // T4: all three filled → exactly ONE call, to the typed URL, saved verbatim, setup dismissed
  await evaluate(RESET_AND_SPY);
  await evaluate(`showSetup(); suKey.value='sk-mine'; suUrl.value='https://my.provider.test/v1/chat/completions'; suModel.value='my-model-42'; suSave.click();`);
  for (let i = 0; i < 20 && await evaluate(`localStorage.getItem('sc-setup-done') !== '1'`); i++) await sleep(200);
  const j4 = JSON.parse(await evaluate(`JSON.stringify({ calls: window.__calls.slice(), key: localStorage.getItem('sc-api-key'), url: localStorage.getItem('sc-api-url'), model: localStorage.getItem('sc-model'), setupVisible: setupView.classList.contains('show') })`));
  check('manual connect makes exactly ONE request (no multi-provider probe)', j4.calls.length === 1, JSON.stringify(j4.calls));
  check('the one request goes to the typed endpoint', j4.calls[0] === 'https://my.provider.test/v1/chat/completions', JSON.stringify(j4.calls));
  check('key/url/model saved exactly as typed', j4.key === 'sk-mine' && j4.url === 'https://my.provider.test/v1/chat/completions' && j4.model === 'my-model-42', JSON.stringify(j4));
  check('setup dismissed after connect', j4.setupVisible === false, JSON.stringify(j4));

  // T5: endpoint without /chat/completions is normalized on save
  await evaluate(RESET_AND_SPY);
  await evaluate(`showSetup(); suKey.value='sk-a'; suUrl.value='https://bare.test/v1'; suModel.value='m'; suSave.click();`);
  for (let i = 0; i < 20 && await evaluate(`localStorage.getItem('sc-setup-done') !== '1'`); i++) await sleep(200);
  check('endpoint URL auto-appends /chat/completions', await evaluate(`localStorage.getItem('sc-api-url') === 'https://bare.test/v1/chat/completions'`));

  // T6: Settings save is manual too — saves typed values, no auto-detect network call
  await evaluate(RESET_AND_SPY);
  await evaluate(`openSettings(); setApiKey.value='sk-settings'; setApiUrl.value='https://s.test/v1/chat/completions'; setModelSelect.value='__custom'; syncCustomModel(); setModel.value='settings-model'; btnSaveSettings.click();`);
  await sleep(700);
  const j6 = JSON.parse(await evaluate(`JSON.stringify({ calls: window.__calls.length, key: localStorage.getItem('sc-api-key'), url: localStorage.getItem('sc-api-url'), model: localStorage.getItem('sc-model') })`));
  check('settings save makes NO network probe', j6.calls === 0, JSON.stringify(j6));
  check('settings saves typed key/url/model verbatim', j6.key === 'sk-settings' && j6.url === 'https://s.test/v1/chat/completions' && j6.model === 'settings-model', JSON.stringify(j6));

} catch (e) {
  check('test harness ran without error', false, e.message);
} finally {
  try { ws && ws.close(); } catch {}
  child.kill();
  try { execSync(`powershell -NoProfile -Command "Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force"`); } catch {}
  if (existsSync(userData)) { try { rmSync(userData, { recursive: true, force: true }); } catch {} }

  const passed = results.filter(r => r.pass).length;
  console.log(`\n  Manual-API flow — ${passed}/${results.length} passed\n`);
  for (const r of results) console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : '   <-- ' + r.detail}`);
  console.log('');
  process.exit(passed === results.length ? 0 : 1);
}
