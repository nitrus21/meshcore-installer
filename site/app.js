import { NordicDfu, touch1200 } from './dfu.js?v=dev';
import { flashEsp32, ESP32_APP_ADDRESS } from './esp32.js?v=dev';
import { usbCandidates, probeSerial, meshtasticCandidates, meshcoreCandidates, uf2Candidates, parseUf2Info, usbBridge, isNrf52Usb, portFilters } from './detect.js?v=dev';

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hasSerial = 'serial' in navigator;
const HIGH_POWER = /30dbm|33dbm|1W|RAK_3401|ProMicro|e22/i;

let catalog = null;
let busy = false;
let detectedPort = null; // port choisi pendant la détection, réutilisé pour l'installation
let mode = 'update';     // onglet : 'update' (conserve les paramètres) ou 'reset' (efface tout)

function setMode(m) {
  mode = m;
  document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === m)));
  document.body.classList.toggle('mode-reset', m === 'reset');
  if (catalog) update();
  else {
    document.querySelectorAll('[data-mode], [data-chip]').forEach((el) => {
      el.hidden = (el.dataset.mode && el.dataset.mode !== m) || (el.dataset.chip && el.dataset.chip !== 'nrf52');
    });
  }
}

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
    ['Cartes nRF52', catalog.boards.filter((b) => !b.featured && b.chip !== 'esp32' && match(b))],
    ['Cartes ESP32', catalog.boards.filter((b) => !b.featured && b.chip === 'esp32' && match(b))],
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
const chip = () => board()?.chip || 'nrf52';

function update() {
  const b = board();

  // Rôles proposés par la carte : on grise ceux qui n'existent pas et on bascule si besoin
  const radios = [...document.querySelectorAll('input[name=role]')];
  for (const r of radios) {
    r.disabled = !!b && !b.firmware[r.value];
    r.closest('.role').classList.toggle('unavailable', r.disabled);
  }
  if (b && !b.firmware[role()]) radios.find((r) => !r.disabled).checked = true;

  // N'afficher que les sections utiles au rôle, à l'onglet et à la puce choisis
  const r = role();
  const c = chip();
  document.querySelectorAll('[data-role], [data-mode], [data-chip]').forEach((el) => {
    el.hidden = (el.dataset.role && el.dataset.role !== r) || (el.dataset.mode && el.dataset.mode !== mode) ||
      (el.dataset.chip && el.dataset.chip !== c);
  });
  if (r !== 'repeater' && con.port) conDisconnect();
  $(r === 'companion' ? 'done-repeater' : 'done-companion').hidden = true;

  const highPower = !!b && HIGH_POWER.test(b.id);
  const notes = [];
  if (c === 'esp32') {
    notes.push(r === 'repeater'
      ? '⚠ Carte ESP32 : elle consomme beaucoup plus qu’une carte nRF52 (plusieurs fois plus au repos). Déconseillée pour un répéteur solaire ou sur batterie : préférez-la alimentée sur secteur.'
      : '⚠ Carte ESP32 : elle consomme beaucoup plus qu’une carte nRF52, l’autonomie sur batterie sera nettement plus courte.');
  }
  if (highPower) {
    notes.push(r === 'companion'
      ? '⚠ Carte avec amplificateur possible (E22 30 dBm / 1 W) : réduisez la puissance TX dans l’application après installation.'
      : '⚠ Carte avec amplificateur possible (E22 30 dBm / 1 W) : réduisez la puissance TX dans la console après installation.');
  }
  $('board-note').hidden = !notes.length;
  $('board-note').textContent = notes.join(' ');
  document.querySelectorAll('[data-highpower]').forEach((el) => { el.hidden = !highPower; });

  const fw = firmware();
  if (!fw) {
    $('fw-info').textContent = b ? 'Ce rôle n’est pas disponible pour cette carte.' : 'Aucune carte trouvée.';
    $('install').disabled = true;
    $('uf2').hidden = true;
    return;
  }
  $('fw-info').textContent = `MeshCore ${fw.version} · ${(fw.size / 1024).toFixed(0)} Ko`;

  const resetBlocked = mode === 'reset' && c === 'nrf52' && !b.erase;
  $('reset-unavailable').hidden = !resetBlocked;
  if (resetBlocked) {
    $('reset-unavailable').innerHTML = r === 'repeater'
      ? '<b>Effacement automatique non disponible pour cette carte.</b> Faites une « Mise à jour », puis dans la console du répéteur (étape 4) tapez <code>erase</code> puis <code>reboot</code>.'
      : '<b>Effacement automatique non disponible pour cette carte.</b> Utilisez l’onglet « Mise à jour » ; pour repartir de zéro, réinitialisez l’appareil depuis l’application MeshCore.';
  }
  $('install').textContent = mode === 'reset' ? '🧹 Effacer et installer' : '🔄 Mettre à jour';
  $('install').disabled = busy || !hasSerial || resetBlocked;
  $('uf2').hidden = !fw.uf2 || mode === 'reset';
  if (fw.uf2) {
    $('uf2').href = fw.uf2;
    $('uf2').download = fw.uf2.split('/').pop();
  }
}

// ---------- Port série ----------

// Par défaut on ne propose que les ports du type de carte choisi : USB natif pour les nRF52,
// adaptateurs USB-série (CP210x, CH340…) pour les ESP32. 'any' : les deux (détection).
function pickPort(c = chip()) {
  const filters = $('all-ports').checked ? [] : portFilters(c);
  return navigator.serial.requestPort({ filters });
}

function bridgeMessage(name) {
  return `Ce port est un adaptateur USB-série ${name} : c’est un autre appareil (carte ESP32, Arduino…), pas une carte nRF52. ` +
    'Choisissez l’autre port, souvent nommé « USB Serial Device » ou du nom de la carte. Si c’est une carte ESP32, sélectionnez-la dans la liste.';
}

// Message d'erreur si le port ne correspond pas à la puce de la carte choisie, sinon null
function portMismatch(port, c) {
  const info = port.getInfo();
  const bridge = usbBridge(info);
  if (c === 'nrf52' && bridge) return bridgeMessage(bridge);
  if (c === 'esp32' && isNrf52Usb(info)) {
    return 'Ce port appartient à une carte nRF52, pas à une carte ESP32. Choisissez votre carte dans la liste, ou le port de l’ESP32 (souvent « CP210x » ou « USB-SERIAL CH340 »).';
  }
  return null;
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

// Après un redémarrage la carte se reconnecte avec un nouveau port série.
// Si le navigateur l'a déjà autorisé on le récupère seul, sinon on demande un clic.
// settleMs : attendre que la carte ne se reconnecte plus (plusieurs redémarrages d'affilée).
function waitBootloaderPort(timeoutMs = 8000, settleMs = 0) {
  return new Promise((resolve) => {
    const btn = $('pick-bootloader');
    let done = false;
    let settle = null;
    const finish = (port) => {
      if (done) return;
      done = true;
      clearTimeout(settle);
      navigator.serial.removeEventListener('connect', onConnect);
      btn.hidden = true;
      btn.onclick = null;
      resolve(port);
    };
    const onConnect = (e) => {
      if (!settleMs) return finish(e.target);
      clearTimeout(settle);
      settle = setTimeout(() => finish(e.target), settleMs);
    };
    navigator.serial.addEventListener('connect', onConnect);
    setTimeout(() => {
      if (done || settle) return;
      log('Cliquez sur « Sélectionner le port du bootloader » et choisissez le nouveau port de la carte.');
      btn.hidden = false;
      btn.onclick = async () => {
        try { finish(await pickPort()); }
        catch { log('Aucun port choisi. Réessayez, ou double-appuyez sur RESET puis relancez avec la case « déjà en mode bootloader ».'); }
      };
    }, timeoutMs);
  });
}

async function dfuFlash(port, dat, bin) {
  const dfu = new NordicDfu(port, { log, progress: setProgress });
  await dfu.open();
  try {
    await dfu.flash(dat, bin);
  } finally {
    await dfu.close();
  }
}

async function toBootloader(port) {
  log('Redémarrage de la carte en mode bootloader (1200 bauds)…');
  await touch1200(port);
  port = await waitBootloaderPort();
  await sleep(500);
  log('Bootloader détecté.');
  return port;
}

// Après l'effaceur, la carte formate son stockage puis redémarre (souvent directement en bootloader).
// On réessaie jusqu'à tomber sur le bootloader, en relançant le « touch » 1200 bauds si besoin.
async function flashAfterErase(port, dat, bin) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await dfuFlash(port, dat, bin);
    } catch (e) {
      if (attempt >= 3) throw e;
      if (/ne répond pas/.test(e.message)) {
        try { port = await toBootloader(port); continue; } catch {}
      }
      log('La carte redémarre, nouvelle tentative…');
      port = await waitBootloaderPort(10000, 1500);
      await sleep(500);
    }
  }
}

async function nrf52Install(port, [bin, dat, eraseBin, eraseDat], reset) {
  if (!$('in-bootloader').checked) port = await toBootloader(port);

  if (reset) {
    log('Étape 1/2 : installation du programme d’effacement…');
    await dfuFlash(port, eraseDat, eraseBin);
    log('Effacement du stockage en cours…');
    port = await waitBootloaderPort(15000, 2500);
    await sleep(500);
    log('Étape 2/2 : installation de MeshCore…');
    setProgress(0);
    await flashAfterErase(port, dat, bin);
  } else {
    await dfuFlash(port, dat, bin);
  }
}

async function install() {
  const fw = firmware();
  const b = board();
  const r = role();
  const c = chip();
  if (!fw || busy) return;
  const reset = mode === 'reset';
  if (reset && !confirm(`Tout effacer sur « ${b.name} » ?\n\nNom, contacts, canaux, clé d’identité et réglages seront supprimés, puis MeshCore sera installé.`)) return;
  busy = true;
  update();
  $('log').textContent = '';
  $('done-companion').hidden = $('done-repeater').hidden = true;
  setProgress(0);

  try {
    log(`Carte : ${b.name} — ${r === 'companion' ? 'Companion Bluetooth' : 'Répéteur'} ${fw.version}`);
    log(reset ? 'Mode : réinitialisation complète' : 'Mode : mise à jour (paramètres conservés)');
    const fileP = c === 'esp32'
      ? fetchBytes(`${reset ? fw.merged : fw.bin}?v=${fw.version}`)
      : Promise.all([
        fetchBytes(`${fw.bin}?v=${fw.version}`), fetchBytes(`${fw.dat}?v=${fw.version}`),
        ...(reset ? [fetchBytes(b.erase.bin), fetchBytes(b.erase.dat)] : []),
      ]);
    fileP.catch(() => {}); // erreur relevée plus bas, après le choix du port
    const port = detectedPort || await pickPort();
    detectedPort = null;
    const mismatch = portMismatch(port, c);
    if (mismatch) throw new Error(mismatch);

    if (c === 'esp32') {
      // Mise à jour : application seule (réglages conservés) ; réinitialisation : effacement + image complète
      await flashEsp32(port, await fileP, {
        address: reset ? 0 : ESP32_APP_ADDRESS, eraseAll: reset, log, progress: setProgress,
      });
    } else {
      await nrf52Install(port, await fileP, reset);
    }
    setProgress(1);
    log(reset
      ? '✅ Carte effacée et MeshCore installé. Elle redémarre avec une nouvelle identité.'
      : '✅ Mise à jour terminée. La carte redémarre sous MeshCore avec tous ses paramètres.');
    $(r === 'companion' ? 'done-companion' : 'done-repeater').hidden = false;
    if (r === 'repeater') $('console-card').scrollIntoView({ behavior: 'smooth' });
  } catch (e) {
    if (e?.name === 'NotFoundError') log('Aucun port sélectionné.');
    else {
      log(`❌ Erreur : ${e.message || e}`);
      if (c === 'nrf52' && !/adaptateur USB-série/.test(e.message)) log('Astuce : double-appuyez sur RESET, cochez « déjà en mode bootloader » et recommencez.');
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
  try { port = await pickPort('any'); } catch { return; }
  const bridge = usbBridge(port.getInfo());
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
      const latest = catalog.roles.repeater.tag.replace('repeater-', '');
      notes.push(version === latest
        ? `Répéteur MeshCore déjà à jour (${version}).`
        : `Répéteur MeshCore ${version || '?'} installé → ${latest} disponible : utilisez l’onglet « Mise à jour » pour garder ses paramètres.`);
      setMode('update');
    }
    if (probe?.meshtastic) {
      const { firmware, hwModel } = probe.meshtastic;
      sources.push({ label: `Meshtastic ${firmware || ''} présent — modèle matériel n°${hwModel}`, ids: meshtasticCandidates(hwModel), strong: true });
      notes.push('Meshtastic détecté : l’onglet « Tout réinitialiser » a été sélectionné pour partir d’une carte propre.');
      setMode('reset');
    }
    if (probe && !probe.meshcore && !probe.meshtastic) {
      notes.push('Aucun firmware ne répond sur le port série (Companion Bluetooth, carte vide ou firmware inconnu).');
    }
    const usb = usbCandidates(port.getInfo());
    if (usb.id) sources.push({ label: `Identifiant USB ${usb.id}${bridge ? ` (adaptateur ${bridge} : carte ESP32 probable)` : ''}`, ids: usb.boards, strong: false });
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
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => { if (!busy) setMode(t.dataset.tab); }));
setMode(location.hash === '#reset' ? 'reset' : 'update');
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
