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

// Install a fetch spy + reset app AI state. Records {url, method}; answers a
// GET .../models with a fake model list and any chat POST with a canned reply.
const RESET_AND_SPY = `(() => {
  window.__calls = [];
  window.fetch = (u, o) => {
    const url = String(u), method = (o && o.method) || 'GET';
    window.__calls.push({ url, method });
    if (/\\/models$/.test(url)) return Promise.resolve(new Response(JSON.stringify({data:[{id:'model-a'},{id:'model-b'}]}), { status:200, headers:{'Content-Type':'application/json'} }));
    return Promise.resolve(new Response(JSON.stringify({choices:[{message:{content:'hi'}}]}), { status:200, headers:{'Content-Type':'application/json'} }));
  };
  ['sc-api-key','sc-api-url','sc-model','sc-setup-done','sc-models'].forEach(k => localStorage.removeItem(k));
})()`;
const chatPosts = calls => calls.filter(c => c.method === 'POST' && !/\/models$/.test(c.url));
const modelGets = calls => calls.filter(c => /\/models$/.test(c.url));

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
  const j4chat = chatPosts(j4.calls);
  check('manual connect makes exactly ONE chat request (no multi-provider probe)', j4chat.length === 1, JSON.stringify(j4.calls));
  check('the chat request goes to the typed endpoint', j4chat[0] && j4chat[0].url === 'https://my.provider.test/v1/chat/completions', JSON.stringify(j4.calls));
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

  // Helper: seed a full saved config, then open settings fresh
  const SEED = `(() => { localStorage.setItem('sc-api-key','sk-seed'); localStorage.setItem('sc-api-url','https://seed.test/v1/chat/completions'); localStorage.setItem('sc-model','seed-model'); localStorage.setItem('sc-setup-done','1'); openSettings(); })()`;

  // T7: "Remove" on the key clears ONLY the key
  await evaluate(RESET_AND_SPY); await evaluate(SEED);
  await evaluate(`rmKey.click()`); await sleep(200);
  const j7 = JSON.parse(await evaluate(`JSON.stringify({ key: localStorage.getItem('sc-api-key'), url: localStorage.getItem('sc-api-url'), model: localStorage.getItem('sc-model'), input: setApiKey.value })`));
  check('Remove key clears only the key (url/model kept)', j7.key === null && j7.url === 'https://seed.test/v1/chat/completions' && j7.model === 'seed-model' && j7.input === '', JSON.stringify(j7));

  // T8: "Remove" on the endpoint clears ONLY the url
  await evaluate(RESET_AND_SPY); await evaluate(SEED);
  await evaluate(`rmUrl.click()`); await sleep(200);
  const j8 = JSON.parse(await evaluate(`JSON.stringify({ key: localStorage.getItem('sc-api-key'), url: localStorage.getItem('sc-api-url'), model: localStorage.getItem('sc-model') })`));
  check('Remove endpoint clears only the url (key/model kept)', j8.url === null && j8.key === 'sk-seed' && j8.model === 'seed-model', JSON.stringify(j8));

  // T9: "Remove" on the model clears ONLY the model
  await evaluate(RESET_AND_SPY); await evaluate(SEED);
  await evaluate(`rmModel.click()`); await sleep(200);
  const j9 = JSON.parse(await evaluate(`JSON.stringify({ key: localStorage.getItem('sc-api-key'), url: localStorage.getItem('sc-api-url'), model: localStorage.getItem('sc-model') })`));
  check('Remove model clears only the model (key/url kept)', j9.model === null && j9.key === 'sk-seed' && j9.url === 'https://seed.test/v1/chat/completions', JSON.stringify(j9));

  // T10: "Remove API (reset)" clears everything + setup flag and reopens setup
  await evaluate(RESET_AND_SPY); await evaluate(SEED);
  await evaluate(`rmAll.click()`); await sleep(400);
  const j10 = JSON.parse(await evaluate(`JSON.stringify({ key: localStorage.getItem('sc-api-key'), url: localStorage.getItem('sc-api-url'), model: localStorage.getItem('sc-model'), setupDone: localStorage.getItem('sc-setup-done'), setupVisible: setupView.classList.contains('show'), settingsOpen: settingsModal.classList.contains('show') })`));
  check('Remove API clears all four keys', j10.key === null && j10.url === null && j10.model === null && j10.setupDone === null, JSON.stringify(j10));
  check('Remove API reopens the setup screen', j10.setupVisible === true && j10.settingsOpen === false, JSON.stringify(j10));

  // T11: connecting fetches the provider's model list so models "already exist"
  await evaluate(RESET_AND_SPY);
  await evaluate(`showSetup(); suKey.value='sk-mods'; suUrl.value='https://models.test/v1/chat/completions'; suModel.value='m'; suSave.click();`);
  for (let i = 0; i < 20 && await evaluate(`localStorage.getItem('sc-setup-done') !== '1'`); i++) await sleep(200);
  const j11 = JSON.parse(await evaluate(`JSON.stringify({ calls: window.__calls.slice(), cached: cachedModels('https://models.test/v1/chat/completions'), list: modelsForUrl('https://models.test/v1/chat/completions') })`));
  check('connect fetches provider models (GET .../models)', modelGets(j11.calls).some(c => c.method === 'GET' && c.url === 'https://models.test/v1/models'), JSON.stringify(j11.calls));
  check('provider models are cached and appear in the model list', j11.cached.includes('model-a') && j11.list.includes('model-a') && j11.list.includes('model-b'), JSON.stringify(j11));

  // T12: quiz custom instructions are injected verbatim and marked highest-priority
  const j12 = JSON.parse(await evaluate(`(() => { const p = quizPrompt(5,'mixed','ONLY about chapter 3, in English'); return JSON.stringify({ hasExtra: p.includes('ONLY about chapter 3, in English'), priority: /HIGHEST PRIORITY/.test(p) && /word for word/i.test(p), noneWhenBlank: !quizPrompt(5,'mixed','').includes('HIGHEST PRIORITY') }); })()`));
  check('quiz: custom instructions injected verbatim', j12.hasExtra, JSON.stringify(j12));
  check('quiz: custom instructions marked highest-priority / word-for-word', j12.priority, JSON.stringify(j12));
  check('quiz: no priority block when no instructions given', j12.noneWhenBlank, JSON.stringify(j12));

  // T13: question count is a free number (not a capped 5/8/10 dropdown)
  const j13 = JSON.parse(await evaluate(`(() => {
    showQuizSetup();
    const c = document.getElementById('qzCount');
    const p25 = quizPrompt(25,'mixed','');
    return JSON.stringify({ type: c.type, max: c.max, promptHas25: p25.includes('exactly 25 questions'), clampBig: clamp(Math.round(+'999')||5,1,50), clampMid: clamp(Math.round(+'25')||5,1,50) });
  })()`));
  check('quiz count is a free number input (min 1, max 50)', j13.type === 'number' && j13.max === '50', JSON.stringify(j13));
  check('quiz prompt honors an arbitrary count (e.g. 25)', j13.promptHas25, JSON.stringify(j13));
  check('quiz count clamps to 1..50 (999→50, 25→25)', j13.clampBig === 50 && j13.clampMid === 25, JSON.stringify(j13));

  // T14: "Redo Quiz" does nothing when there is no saved quiz
  const j14 = JSON.parse(await evaluate(`(() => { delete doc.lastQuiz; quizModal.classList.remove('show'); redoLastQuiz(); return JSON.stringify({ modal: quizModal.classList.contains('show') }); })()`));
  check('Redo Quiz is a no-op with no saved quiz', j14.modal === false, JSON.stringify(j14));

  // T15: a quiz posts a persistent chat message with a working "Redo Quiz" button
  const j15 = JSON.parse(await evaluate(`(() => {
    doc.lastQuiz = { questions:[{type:'short',question:'q1',expected:'a1',source:'s'},{type:'mc',question:'q2',options:['x','y'],answer:0,source:'s'}], createdAt:Date.now() };
    const before = activeChat().messages.length;
    addQuizChatMessage(2);
    const msgs = activeChat().messages, last = msgs[msgs.length-1];
    const btnTexts = [...document.querySelectorAll('#chatLog .actions button')].map(b => b.textContent);
    quizModal.classList.remove('show');
    redoLastQuiz();
    return JSON.stringify({ pushed: msgs.length === before+1, isQuizMsg: !!last.quiz, hasRedoBtn: btnTexts.includes('Redo Quiz'), modalOpen: quizModal.classList.contains('show'), qCount: quiz && quiz.questions.length, atStart: quiz && quiz.i === 0 });
  })()`));
  check('quiz drops a persistent chat message (flagged quiz)', j15.pushed && j15.isQuizMsg, JSON.stringify(j15));
  check('chat shows a "Redo Quiz" button on that message', j15.hasRedoBtn, JSON.stringify(j15));
  check('Redo Quiz reopens the saved quiz from the start', j15.modalOpen && j15.qCount === 2 && j15.atStart, JSON.stringify(j15));

  // T16: randomizer — redo reorders questions and shuffles MC options, keeping answers correct
  const j16 = JSON.parse(await evaluate(`(() => {
    const src = Array.from({length:100}, (_,i)=>i);
    const sh = shuffled(src);
    const isPerm = sh.length===100 && sh.slice().sort((a,b)=>a-b).join()===src.join();
    const orderChanged = sh.join() !== src.join();
    // MC option shuffle keeps the correct option text (try many times)
    let shuffleQOk = true;
    const q = { type:'mc', question:'Q', options:['A','B','C','D'], answer:2 };
    for (let t=0;t<25;t++){ const s=shuffleQuestion(q); if (s.options[s.answer]!=='C' || s.options.slice().sort().join()!=='A,B,C,D'){ shuffleQOk=false; break; } }
    // redo keeps the same question SET and MC integrity
    doc.lastQuiz = { questions:[
      {type:'short',question:'S1',expected:'a'},{type:'short',question:'S2',expected:'b'},
      {type:'mc',question:'M1',options:['w','x','y','z'],answer:1},
      {type:'short',question:'S3',expected:'c'},{type:'short',question:'S4',expected:'d'},{type:'short',question:'S5',expected:'e'}
    ]};
    quizModal.classList.remove('show'); redoLastQuiz();
    const set = quiz.questions.map(x=>x.question).sort().join(',');
    const mc = quiz.questions.find(x=>x.type==='mc');
    const mcOk = !!mc && mc.options[mc.answer]==='x' && mc.options.slice().sort().join()==='w,x,y,z';
    // redo a few times: the original stays intact and at least one order differs
    const orig = doc.lastQuiz.questions.map(x=>x.question).join(',');
    let anyDifferent = false;
    for (let t=0;t<6;t++){ redoLastQuiz(); if (quiz.questions.map(x=>x.question).join(',') !== orig) anyDifferent = true; }
    const originalIntact = doc.lastQuiz.questions.map(x=>x.question).join(',') === 'S1,S2,M1,S3,S4,S5';
    return JSON.stringify({ isPerm, orderChanged, shuffleQOk, sameSet: set==='M1,S1,S2,S3,S4,S5' && quiz.questions.length===6, mcOk, anyDifferent, originalIntact });
  })()`));
  check('randomizer: shuffle is a permutation (no lost/dup items)', j16.isPerm, JSON.stringify(j16));
  check('randomizer: shuffle actually changes the order', j16.orderChanged, JSON.stringify(j16));
  check('randomizer: MC options shuffle keeps the correct answer', j16.shuffleQOk && j16.mcOk, JSON.stringify(j16));
  check('redo keeps the same question set', j16.sameSet, JSON.stringify(j16));
  check('redo reorders questions (order differs across redos)', j16.anyDifferent, JSON.stringify(j16));
  check('redo does not mutate the saved original order', j16.originalIntact, JSON.stringify(j16));

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
