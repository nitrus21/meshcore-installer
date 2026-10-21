import { NordicDfu, touch1200 } from './dfu.js?v=dev';
import { usbCandidates, probeSerial, meshtasticCandidates, meshcoreCandidates, uf2Candidates, parseUf2Info, usbBridge, NRF52_PORT_FILTERS } from './detect.js?v=dev';

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hasSerial = 'serial' in navigator;
const HIGH_POWER = /30dbm|33dbm|1W|RAK_3401|ProMicro|e22/i;

let catalog = null;
let busy = false;
let detectedPort = null; // port choisi pendant la détection, réutilisé pour l'installation

// ---------- Catalogue ----------

async function loadCatalog() {
  const res = await fetch('firmware/catalog.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error(`catalogue introuvable (${res.status})`);
  catalog = await res.json();
  const { companion, repeater } = catalog.roles;
  $('catalog-info').textContent =
    `Companion ${companion.tag.replace('companion-', '')} (${companion.date}) · ` +
    `Répéteur ${repeater.tag.replace('repeater-', '')} (${repeater.date}) · ${catalog.boards.length} cartes`;
  renderBoards();
  const wanted = new URLSearchParams(location.search).get('board');
  if (wanted && catalog.boards.some((b) => b.id === wanted)) $('board').value = wanted;
  update();
}

function renderBoards(filter = '') {
  const sel = $('board');
  const prev = sel.value;
  const q = filter.trim().toLowerCase();
  const match = (b) => !q || b.name.toLowerCase().includes(q) || b.id.toLowerCase().includes(q);
  sel.innerHTML = '';
  const groups = [
    ['Recommandé', catalog.boards.filter((b) => b.featured && match(b))],
    ['Toutes les cartes nRF52', catalog.boards.filter((b) => !b.featured && match(b))],
  ];
  for (const [label, list] of groups) {
    if (!list.length) continue;
    const og = document.createElement('optgroup');
    og.label = label;
    for (const b of list) og.append(new Option(b.name, b.id));
    sel.append(og);
  }
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

const board = () => catalog?.boards.find((b) => b.id === $('board').value);
const role = () => document.querySelector('input[name=role]:checked').value;
const firmware = () => board()?.firmware[role()];

function update() {
  const b = board();

  // Rôles proposés par la carte : on grise ceux qui n'existent pas et on bascule si besoin
  const radios = [...document.querySelectorAll('input[name=role]')];
  for (const r of radios) {
    r.disabled = !!b && !b.firmware[r.value];
    r.closest('.role').classList.toggle('unavailable', r.disabled);
  }
  if (b && !b.firmware[role()]) radios.find((r) => !r.disabled).checked = true;

  // N'afficher que les sections utiles au rôle choisi
  const r = role();
  document.querySelectorAll('[data-role]').forEach((el) => { el.hidden = el.dataset.role !== r; });
  if (r !== 'repeater' && con.port) conDisconnect();
  $(r === 'companion' ? 'done-repeater' : 'done-companion').hidden = true;

  const highPower = !!b && HIGH_POWER.test(b.id);
  $('board-note').hidden = !highPower;
  $('board-note').textContent = r === 'companion'
    ? '⚠ Carte avec amplificateur possible (E22 30 dBm / 1 W) : réduisez la puissance TX dans l’application après installation.'
    : '⚠ Carte avec amplificateur possible (E22 30 dBm / 1 W) : réduisez la puissance TX dans la console après installation.';
  document.querySelectorAll('[data-highpower]').forEach((el) => { el.hidden = !highPower; });

  const fw = firmware();
  if (!fw) {
    $('fw-info').textContent = b ? 'Ce rôle n’est pas disponible pour cette carte.' : 'Aucune carte trouvée.';
    $('install').disabled = true;
    $('uf2').hidden = true;
    return;
  }
  $('fw-info').textContent = `MeshCore ${fw.version} · ${(fw.size / 1024).toFixed(0)} Ko`;
  $('install').disabled = busy || !hasSerial;
  $('uf2').hidden = !fw.uf2;
  if (fw.uf2) {
    $('uf2').href = fw.uf2;
    $('uf2').download = fw.uf2.split('/').pop();
  }
}

// ---------- Port série ----------

// Par défaut on ne propose que les ports des cartes nRF52 (évite de choisir un ESP32 / CH340 par erreur)
function pickPort() {
  const filters = $('all-ports').checked ? [] : NRF52_PORT_FILTERS;
  return navigator.serial.requestPort({ filters });
}

function bridgeMessage(name) {
  return `Ce port est un adaptateur USB-série ${name} : c’est un autre appareil (ESP32, Arduino…), pas une carte nRF52. ` +
    'Choisissez l’autre port, souvent nommé « USB Serial Device » ou du nom de la carte.';
}

// ---------- Journal / progression ----------

function log(msg) {
  const el = $('log');
  el.hidden = false;
  el.textContent += `${msg}\n`;
  el.scrollTop = el.scrollHeight;
}

function setProgress(p) {
  $('progress-wrap').hidden = false;
  $('progress').value = p;
  $('progress-label').textContent = `${Math.round(p * 100)} %`;
}

async function fetchBytes(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`téléchargement impossible : ${url} (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

// ---------- Installation ----------

// Après le "touch" 1200 bauds la carte se reconnecte avec un nouveau port série.
// Si le navigateur l'a déjà autorisé on le récupère seul, sinon on demande un clic.
function waitBootloaderPort(timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const btn = $('pick-bootloader');
    let done = false;
    const finish = (port) => {
      if (done) return;
      done = true;
      navigator.serial.removeEventListener('connect', onConnect);
      btn.hidden = true;
      btn.onclick = null;
      resolve(port);
    };
    const onConnect = (e) => finish(e.target);
    navigator.serial.addEventListener('connect', onConnect);
    setTimeout(() => {
      if (done) return;
      log('Cliquez sur « Sélectionner le port du bootloader » et choisissez le nouveau port de la carte.');
      btn.hidden = false;
      btn.onclick = async () => {
        try { finish(await pickPort()); }
        catch { log('Aucun port choisi. Réessayez, ou double-appuyez sur RESET puis relancez avec la case « déjà en mode bootloader ».'); }
      };
    }, timeoutMs);
  });
}

async function install() {
  const fw = firmware();
  const r = role();
  if (!fw || busy) return;
  busy = true;
  update();
  $('log').textContent = '';
  $('done-companion').hidden = $('done-repeater').hidden = true;
  setProgress(0);

  try {
    log(`Carte : ${board().name} — ${r === 'companion' ? 'Companion Bluetooth' : 'Répéteur'} ${fw.version}`);
    const filesP = Promise.all([fetchBytes(`${fw.bin}?v=${fw.version}`), fetchBytes(`${fw.dat}?v=${fw.version}`)]);
    let port = detectedPort || await pickPort();
    detectedPort = null;
    const bridge = usbBridge(port.getInfo());
    if (bridge) throw new Error(bridgeMessage(bridge));
    const [bin, dat] = await filesP;

    if (!$('in-bootloader').checked) {
      log('Redémarrage de la carte en mode bootloader (1200 bauds)…');
      await touch1200(port);
      port = await waitBootloaderPort();
      await sleep(500);
      log('Bootloader détecté.');
    }

    const dfu = new NordicDfu(port, { log, progress: setProgress });
    await dfu.open();
    try {
      await dfu.flash(dat, bin);
    } finally {
      await dfu.close();
    }
    setProgress(1);
    log('✅ Installation terminée. La carte redémarre sous MeshCore.');
    $(r === 'companion' ? 'done-companion' : 'done-repeater').hidden = false;
    if (r === 'repeater') $('console-card').scrollIntoView({ behavior: 'smooth' });
  } catch (e) {
    if (e?.name === 'NotFoundError') log('Aucun port sélectionné.');
    else {
      log(`❌ Erreur : ${e.message || e}`);
      if (!/adaptateur USB-série/.test(e.message)) log('Astuce : double-appuyez sur RESET, cochez « déjà en mode bootloader » et recommencez.');
    }
  } finally {
    busy = false;
    $('pick-bootloader').hidden = true;
    update();
  }
}

// ---------- Détection ----------

const boardName = (id) => catalog.boards.find((b) => b.id === id)?.name || id;

function selectBoard(id) {
  $('board-search').value = '';
  renderBoards();
  $('board').value = id;
  update();
}

// sources : [{ label, ids, strong }] du plus fiable au moins fiable
function showDetection(sources, notes = []) {
  const known = new Set(catalog.boards.map((b) => b.id));
  const el = $('detect-result');
  el.hidden = false;
  el.innerHTML = '';

  const best = sources.find((s) => s.ids.some((id) => known.has(id)));
  const ids = best ? best.ids.filter((id) => known.has(id)) : [];
  const confident = best && (best.strong || ids.length <= 2);

  const title = document.createElement('div');
  if (confident) {
    selectBoard(ids[0]);
    title.innerHTML = `✅ <b>Carte détectée :</b> ${boardName(ids[0])}`;
    el.className = 'detect ok';
  } else if (ids.length) {
    title.innerHTML = '🤔 <b>Plusieurs cartes possibles.</b> Choisissez la vôtre, ou mettez la carte en mode bootloader (double RESET) puis « Lire INFO_UF2.TXT ».';
    el.className = 'detect warn';
  } else {
    title.innerHTML = '❓ <b>Carte non reconnue.</b> Choisissez-la dans la liste, ou essayez « Lire INFO_UF2.TXT ».';
    el.className = 'detect warn';
  }
  el.append(title);

  const ul = document.createElement('ul');
  for (const line of [...sources.map((s) => s.label), ...notes]) {
    const li = document.createElement('li');
    li.className = 'src';
    li.textContent = line;
    ul.append(li);
  }
  el.append(ul);

  const others = confident ? ids.slice(1) : ids;
  if (others.length) {
    const chips = document.createElement('div');
    chips.className = 'chips';
    for (const id of others) {
      const b = document.createElement('button');
      b.textContent = boardName(id);
      b.onclick = () => { selectBoard(id); title.innerHTML = `✅ <b>Carte choisie :</b> ${boardName(id)}`; el.className = 'detect ok'; };
      chips.append(b);
    }
    el.append(chips);
  }
}

async function detect() {
  if (busy) return;
  let port;
  try { port = await pickPort(); } catch { return; }
  const bridge = usbBridge(port.getInfo());
  if (bridge) {
    showDetectError('Ce n’est pas une carte nRF52.', bridgeMessage(bridge));
    return;
  }
  busy = true;
  $('detect').disabled = true;
  $('detect').textContent = '⏳ Détection…';
  const sources = [];
  const notes = [];
  try {
    let probe = null;
    try {
      probe = await probeSerial(port);
    } catch (e) {
      notes.push(`Port série inaccessible (${e.message || e}). Fermez les autres logiciels qui l’utilisent.`);
    }
    if (probe?.meshcore) {
      const { board: name, version } = probe.meshcore;
      sources.push({ label: `MeshCore ${version || ''} présent — carte « ${name || '?'} »`, ids: meshcoreCandidates(name), strong: true });
      document.querySelector('input[name=role][value=repeater]').checked = true;
    }
    if (probe?.meshtastic) {
      const { firmware, hwModel } = probe.meshtastic;
      sources.push({ label: `Meshtastic ${firmware || ''} présent — modèle matériel n°${hwModel}`, ids: meshtasticCandidates(hwModel), strong: true });
    }
    if (probe && !probe.meshcore && !probe.meshtastic) {
      notes.push('Aucun firmware ne répond sur le port série (Companion Bluetooth, carte vide ou firmware inconnu).');
    }
    const usb = usbCandidates(port.getInfo());
    if (usb.id) sources.push({ label: `Identifiant USB ${usb.id}`, ids: usb.boards, strong: false });
    detectedPort = port;
    showDetection(sources, notes);
  } finally {
    busy = false;
    $('detect').disabled = false;
    $('detect').textContent = '🔍 Détecter ma carte';
    update();
  }
}

function showDetectError(title, detail) {
  const el = $('detect-result');
  el.hidden = false;
  el.className = 'detect warn';
  el.innerHTML = '';
  const t = document.createElement('div');
  t.innerHTML = `⚠ <b>${title}</b>`;
  const p = document.createElement('div');
  p.className = 'src';
  p.textContent = detail;
  el.append(t, p);
}

// Sélecteur de fichier classique : fonctionne dans tous les navigateurs (Brave, Firefox, Safari…)
async function detectUf2(e) {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  const info = parseUf2Info(await file.text());
  if (!info) {
    showDetectError('Ce n’est pas le bon fichier.',
      `« ${file.name} » ne contient pas de modèle de carte. Choisissez INFO_UF2.TXT à la racine du lecteur USB de la carte (ex. PROMICRO, NICENANO, RAK4631…).`);
    return;
  }
  const text = `${info.model || ''} ${info.boardId || ''}`;
  showDetection([{ label: `Bootloader : ${info.model || '?'} (${info.boardId || '?'})`, ids: uf2Candidates(text), strong: true }]);
}

// ---------- Console répéteur ----------

const con = { port: null, reader: null, writer: null, loop: null };

function conPrint(text) {
  const el = $('con-out');
  el.textContent += text;
  el.scrollTop = el.scrollHeight;
}

async function conConnect() {
  try {
    const port = await pickPort();
    await port.open({ baudRate: 115200 });
    con.port = port;
    con.writer = port.writable.getWriter();
    con.reader = port.readable.getReader();
    const dec = new TextDecoder();
    con.loop = (async () => {
      for (;;) {
        let res;
        try { res = await con.reader.read(); } catch { break; }
        if (res.done) break;
        conPrint(dec.decode(res.value, { stream: true }).replace(/\r(?!\n)/g, '\n'));
      }
    })();
    $('con-ui').hidden = false;
    $('con-connect').hidden = true;
    $('con-disconnect').hidden = false;
    conPrint('— connecté —\n');
    await send('ver');
    await send('get name');
    await send('get radio');
    await send('get tx');
  } catch (e) {
    if (e?.name !== 'NotFoundError') conPrint(`Erreur : ${e.message || e}\n`);
  }
}

async function conDisconnect() {
  try { await con.reader?.cancel(); } catch {}
  try { con.reader?.releaseLock(); } catch {}
  try { con.writer?.releaseLock(); } catch {}
  try { await con.loop; } catch {}
  try { await con.port?.close(); } catch {}
  Object.assign(con, { port: null, reader: null, writer: null, loop: null });
  $('con-ui').hidden = true;
  $('con-connect').hidden = false;
  $('con-disconnect').hidden = true;
}

async function send(cmd) {
  if (!con.writer) return;
  await con.writer.write(new TextEncoder().encode(`${cmd}\r`));
  await sleep(350);
}

async function applyConfig() {
  const cmds = [];
  const v = (id) => $(id).value.trim();
  if (v('cfg-name')) cmds.push(`set name ${v('cfg-name')}`);
  if (v('cfg-pass')) cmds.push(`password ${v('cfg-pass')}`);
  if (v('cfg-preset')) cmds.push(`set radio ${v('cfg-preset')}`);
  if (v('cfg-tx')) cmds.push(`set tx ${parseInt(v('cfg-tx'), 10)}`);
  if (v('cfg-lat')) cmds.push(`set lat ${v('cfg-lat').replace(',', '.')}`);
  if (v('cfg-lon')) cmds.push(`set lon ${v('cfg-lon').replace(',', '.')}`);
  if (!cmds.length) return conPrint('Rien à appliquer : remplissez au moins un champ.\n');
  for (const c of cmds) await send(c);
  $('cfg-pass').value = '';
  if (v('cfg-preset') || v('cfg-tx')) conPrint('→ Cliquez sur « Redémarrer » pour appliquer les réglages radio.\n');
}

// ---------- Initialisation ----------

if (!hasSerial) {
  $('unsupported').hidden = false;
  $('con-connect').disabled = true;
  $('detect').disabled = true;
}
$('detect').addEventListener('click', detect);
$('detect-uf2').addEventListener('click', () => $('uf2-file').click());
$('uf2-file').addEventListener('change', detectUf2);
$('board').addEventListener('change', update);
$('board-search').addEventListener('input', (e) => { renderBoards(e.target.value); update(); });
document.querySelectorAll('input[name=role]').forEach((el) => el.addEventListener('change', update));
$('install').addEventListener('click', install);
$('con-connect').addEventListener('click', conConnect);
$('con-disconnect').addEventListener('click', conDisconnect);
$('cfg-apply').addEventListener('click', applyConfig);
document.querySelectorAll('[data-cmd]').forEach((b) => b.addEventListener('click', () => send(b.dataset.cmd)));
$('con-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const c = $('con-input').value.trim();
  if (c) { $('con-input').value = ''; await send(c); }
});

loadCatalog().catch((e) => {
  $('fw-info').textContent = `Impossible de charger le catalogue : ${e.message}`;
  $('install').disabled = true;
});
