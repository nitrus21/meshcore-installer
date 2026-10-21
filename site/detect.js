// Détection de la carte branchée, quel que soit le firmware présent :
//  1. identifiant USB (VID:PID)               → toujours disponible, parfois ambigu
//  2. interrogation Meshtastic (protobuf)     → si Meshtastic tourne dessus
//  3. commande « board » de la console MeshCore → si un répéteur MeshCore tourne dessus
//  4. INFO_UF2.TXT du lecteur bootloader      → carte vide / inconnue / en mode flash
// Les identifiants de cartes sont ceux du catalogue (préfixes des releases MeshCore).

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const RAK = ['RAK_4631', 'RAK_WisMesh_Tag', 'RAK_3401', 'GAT562_30S_Mesh_Kit', 'GAT562_Mesh_Tracker_Pro', 'GAT562_Mesh_EVB_Pro', 'GAT562_Mesh_Watch13', 'R1Neo'];
const HELTEC = ['Heltec_t114', 'Heltec_t114_without_display', 'Heltec_t096', 'Heltec_t1', 'Heltec_mesh_solar'];
const THINKNODE = ['ThinkNode_M1', 'ThinkNode_M3', 'ThinkNode_M4', 'ThinkNode_M6', 'ThinkNode_M8'];
const ADAFRUIT_FAMILY = [...RAK, ...HELTEC, 't1000e', 'LilyGo_T-Echo', 'LilyGo_T-Echo-Lite', 'LilyGo_T-Echo_Card', 'LilyGo_T_Impulse_Plus', 'Meshtiny', 'Minewsemi_me25ls01', 'MeshTracker_X1', 'Nano_G2_Ultra'];

// VID:PID (application ou bootloader) → cartes possibles
const USB_IDS = {
  '239a:00b3': ['ProMicro', 'KeepteenLT1'],
  '239a:8029': ADAFRUIT_FAMILY,
  '239a:0029': ADAFRUIT_FAMILY,
  '239a:002a': ADAFRUIT_FAMILY,
  '239a:802a': ADAFRUIT_FAMILY,
  '239a:4405': [...THINKNODE, 'Heltec_tower_v2', 'Mesh_pocket', 'muzi_base_uno', 'muzi_base_duo'],
  '239a:0071': ['Heltec_tower_v2'],
  '2886:8044': ['Xiao_nrf52', 'ikoka_handheld_nrf_e22_30dbm', 'ikoka_handheld_nrf_e22_30dbm_096'],
  '2886:0044': ['Xiao_nrf52', 'ikoka_handheld_nrf_e22_30dbm', 'ikoka_handheld_nrf_e22_30dbm_096'],
  '2886:0059': ['SenseCap_Solar'],
  '2886:1667': ['WioTrackerL1', 'WioTrackerL1Eink', 'WioTrackerL1-1W'],
  '2886:1668': ['WioTrackerL1', 'WioTrackerL1Eink', 'WioTrackerL1-1W'],
  '2886:0057': ['t1000e', 'MeshTracker_X1'],
};

// Meshtastic HardwareModel (mesh.proto) → cartes MeshCore équivalentes
const MESHTASTIC_HW = {
  7: ['LilyGo_T-Echo'], 9: RAK, 18: ['Nano_G2_Ultra'], 63: ['ProMicro', 'KeepteenLT1'],
  69: ['Heltec_t114', 'Heltec_t114_without_display'], 71: ['t1000e'], 75: ['Minewsemi_me25ls01'],
  88: ['Xiao_nrf52'], 89: ['ThinkNode_M1'], 93: ['muzi_base_uno', 'muzi_base_duo'], 94: ['Mesh_pocket'],
  95: ['SenseCap_Solar'], 99: ['WioTrackerL1'], 100: ['WioTrackerL1Eink'], 101: ['R1Neo'],
  105: ['RAK_WisMesh_Tag'], 108: ['Heltec_mesh_solar'], 109: ['LilyGo_T-Echo-Lite'], 115: ['ThinkNode_M3'],
  117: ['RAK_3401'], 119: ['ThinkNode_M4'], 120: ['ThinkNode_M6'], 127: ['Heltec_t096'], 130: ['ThinkNode_M8'],
  133: ['Heltec_t1'], 135: ['LilyGo_T_Impulse_Plus'], 136: ['LilyGo_T-Echo_Card'], 139: ['Heltec_tower_v2'],
  144: ['WioTrackerL1-1W'], 152: ['Mesh_pocket'],
};

// Réponse de la commande MeshCore « board » (getManufacturerName)
const MESHCORE_BOARD = [
  [/ProMicro DIY/i, ['ProMicro']], [/Keepteen LT1/i, ['KeepteenLT1']],
  [/RAK WisMesh Tag/i, ['RAK_WisMesh_Tag']], [/RAK 4631/i, ['RAK_4631']], [/RAK 3401/i, ['RAK_3401']],
  [/GAT562 30S/i, ['GAT562_30S_Mesh_Kit']], [/GAT562 EVB/i, ['GAT562_Mesh_EVB_Pro']],
  [/GAT562 Mesh Tracker/i, ['GAT562_Mesh_Tracker_Pro']], [/GAT562 Mesh Watch/i, ['GAT562_Mesh_Watch13']],
  [/R1 Neo/i, ['R1Neo']], [/Heltec T114/i, ['Heltec_t114', 'Heltec_t114_without_display']],
  [/Heltec T096/i, ['Heltec_t096']], [/Heltec T1\b/i, ['Heltec_t1']], [/Heltec Mesh Solar/i, ['Heltec_mesh_solar']],
  [/Heltec Tower V2/i, ['Heltec_tower_v2']], [/MeshPocket/i, ['Mesh_pocket']],
  [/T1000-E/i, ['t1000e']], [/SenseCap Solar/i, ['SenseCap_Solar']], [/MeshTracker X1/i, ['MeshTracker_X1']],
  [/Ikoka Handheld/i, ['ikoka_handheld_nrf_e22_30dbm']], [/Xiao-nrf52/i, ['Xiao_nrf52']],
  [/Wio Tracker L1/i, ['WioTrackerL1', 'WioTrackerL1-1W', 'WioTrackerL1Eink']],
  [/T-Echo Card/i, ['LilyGo_T-Echo_Card']], [/T-Echo Lite/i, ['LilyGo_T-Echo-Lite']], [/T-Echo/i, ['LilyGo_T-Echo']],
  [/T-Impulse/i, ['LilyGo_T_Impulse_Plus']], [/Nano G2 Ultra/i, ['Nano_G2_Ultra']], [/Meshtiny/i, ['Meshtiny']],
  [/Minewsemi/i, ['Minewsemi_me25ls01']], [/ThinkNode-?\s?M1\b/i, ['ThinkNode_M1']], [/ThinkNode M3/i, ['ThinkNode_M3']],
  [/ThinkNode M4/i, ['ThinkNode_M4']], [/ThinkNode M6/i, ['ThinkNode_M6']], [/ThinkNode-?\s?M8/i, ['ThinkNode_M8']],
  [/muzi works R1 Neo/i, ['R1Neo']], [/muzi/i, ['muzi_base_uno', 'muzi_base_duo']],
];

// INFO_UF2.TXT (Model / Board-ID du bootloader)
const UF2_IDS = [
  [/nice!?nano|promicro|supermini/i, ['ProMicro', 'KeepteenLT1']],
  [/T1000/i, ['t1000e']], [/SeeedXiao|XIAO/i, ['Xiao_nrf52']], [/Wio.?Tracker/i, ['WioTrackerL1', 'WioTrackerL1-1W', 'WioTrackerL1Eink']],
  [/SenseCAP.*Solar|Solar.?Node/i, ['SenseCap_Solar']], [/RAK3401/i, ['RAK_3401']], [/RAK4631|WisBlock|WisCore/i, RAK],
  [/T114|HT-n5262/i, HELTEC], [/MeshPocket|Mesh.?Pocket/i, ['Mesh_pocket']], [/Tower/i, ['Heltec_tower_v2']],
  [/ThinkNode|Elecrow/i, THINKNODE], [/TTGO|T-?Echo|eink/i, ['LilyGo_T-Echo', 'LilyGo_T-Echo-Lite', 'LilyGo_T-Echo_Card']],
  [/Impulse/i, ['LilyGo_T_Impulse_Plus']], [/Nano.?G2/i, ['Nano_G2_Ultra']], [/muzi/i, ['muzi_base_uno', 'muzi_base_duo']],
  [/me25ls01|Minew/i, ['Minewsemi_me25ls01']], [/X1-BOOT|MeshTracker/i, ['MeshTracker_X1']],
];

const hex4 = (n) => n.toString(16).padStart(4, '0');

// Fabricants USB des cartes nRF52 du catalogue (Adafruit / Seeed / Nordic) : filtre du sélecteur de port
export const NRF52_PORT_FILTERS = [0x239a, 0x2886, 0x1915].map((usbVendorId) => ({ usbVendorId }));

// Adaptateurs USB-série : jamais une carte nRF52 (ESP32, Arduino, câble FTDI…)
const USB_BRIDGES = {
  '1a86:7523': 'CH340', '1a86:55d4': 'CH9102', '1a86:7522': 'CH340',
  '10c4:ea60': 'CP210x', '0403:6001': 'FTDI', '0403:6015': 'FTDI',
  '303a:1001': 'ESP32-S3 (USB natif)', '303a:4001': 'ESP32-S3 (USB natif)',
};

export function usbBridge(info) {
  if (!info?.usbVendorId) return null;
  return USB_BRIDGES[`${hex4(info.usbVendorId)}:${hex4(info.usbProductId)}`] || null;
}

export function usbCandidates(info) {
  if (!info?.usbVendorId) return { id: null, boards: [] };
  const id = `${hex4(info.usbVendorId)}:${hex4(info.usbProductId)}`;
  return { id, boards: USB_IDS[id] || [] };
}

// ---------- protobuf minimal ----------

function readVarint(buf, pos) {
  let result = 0, shift = 0, b;
  do {
    if (pos >= buf.length) throw new Error('varint tronqué');
    b = buf[pos++];
    result += (b & 0x7f) * 2 ** shift;
    shift += 7;
  } while (b & 0x80);
  return [result, pos];
}

function pbFields(buf) {
  const out = [];
  let pos = 0;
  while (pos < buf.length) {
    let key;
    [key, pos] = readVarint(buf, pos);
    const field = Math.floor(key / 8), wire = key & 7;
    if (wire === 0) { let v; [v, pos] = readVarint(buf, pos); out.push({ field, value: v }); }
    else if (wire === 2) { let len; [len, pos] = readVarint(buf, pos); out.push({ field, bytes: buf.subarray(pos, pos + len) }); pos += len; }
    else if (wire === 1) pos += 8;
    else if (wire === 5) pos += 4;
    else throw new Error('wire type inconnu');
  }
  return out;
}

function varint(n) {
  const out = [];
  while (n > 0x7f) { out.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); }
  out.push(n);
  return out;
}

// FromRadio.metadata (13) → DeviceMetadata { firmware_version = 1, hw_model = 9 }
function parseFromRadio(payload) {
  for (const f of pbFields(payload)) {
    if (f.field === 13 && f.bytes) {
      const meta = { firmware: null, hwModel: null };
      for (const m of pbFields(f.bytes)) {
        if (m.field === 1 && m.bytes) meta.firmware = new TextDecoder().decode(m.bytes);
        if (m.field === 9 && m.value !== undefined) meta.hwModel = m.value;
      }
      return meta;
    }
  }
  return null;
}

// ---------- sonde série ----------

// Ouvre le port, interroge Meshtastic puis la console MeshCore, et referme.
export async function probeSerial(port, log = () => {}) {
  const result = { meshtastic: null, meshcore: null, text: '' };
  await port.open({ baudRate: 115200 });
  const writer = port.writable.getWriter();
  const reader = port.readable.getReader();
  const bytes = [];
  let text = '';
  const dec = new TextDecoder();
  const loop = (async () => {
    for (;;) {
      let r;
      try { r = await reader.read(); } catch { break; }
      if (r.done) break;
      bytes.push(...r.value);
      text += dec.decode(r.value, { stream: true });
    }
  })();

  try {
    // 1) Meshtastic : réveil + ToRadio { want_config_id = 69420 } (config seule)
    log('Interrogation Meshtastic…');
    const toRadio = [0x18, ...varint(69420)];
    await writer.write(new Uint8Array(32).fill(0xc3));
    await sleep(100);
    await writer.write(new Uint8Array([0x94, 0xc3, 0x00, toRadio.length, ...toRadio]));
    for (let t = 0; t < 25 && !result.meshtastic; t++) {
      await sleep(100);
      result.meshtastic = scanMeshtastic(bytes);
    }

    // 2) MeshCore : console texte (répéteur / room server)
    if (!result.meshtastic) {
      log('Interrogation de la console MeshCore…');
      const before = text.length;
      for (const cmd of ['', 'ver', 'board']) {
        await writer.write(new TextEncoder().encode(`${cmd}\r`));
        await sleep(400);
      }
      await sleep(300);
      const reply = text.slice(before);
      const ver = reply.match(/(v\d+\.\d+(?:\.\d+)?)[^\r\n]*Build/i);
      const boardLine = reply.match(/board\s*[\r\n]+\s*(?:->\s*)?([^\r\n]+)/i);
      if (ver || boardLine) result.meshcore = { version: ver?.[1] || null, board: boardLine?.[1]?.replace(/^->\s*/, '').trim() || null };
    }
    result.text = text;
  } finally {
    try { await reader.cancel(); } catch {}
    try { reader.releaseLock(); } catch {}
    try { writer.releaseLock(); } catch {}
    try { await loop; } catch {}
    try { await port.close(); } catch {}
  }
  return result;
}

function scanMeshtastic(bytes) {
  for (let i = 0; i + 4 <= bytes.length; i++) {
    if (bytes[i] !== 0x94 || bytes[i + 1] !== 0xc3) continue;
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    if (len > 512 || i + 4 + len > bytes.length) continue;
    try {
      const meta = parseFromRadio(new Uint8Array(bytes.slice(i + 4, i + 4 + len)));
      if (meta?.hwModel != null) return meta;
    } catch {}
  }
  return null;
}

export function meshtasticCandidates(hwModel) { return MESHTASTIC_HW[hwModel] || []; }

export function meshcoreCandidates(boardName) {
  if (!boardName) return [];
  for (const [re, ids] of MESHCORE_BOARD) if (re.test(boardName)) return ids;
  return [];
}

export function uf2Candidates(infoText) {
  for (const [re, ids] of UF2_IDS) if (re.test(infoText)) return ids;
  return [];
}

// Contenu de INFO_UF2.TXT (lecteur USB du bootloader) → { model, boardId } ou null
export function parseUf2Info(text) {
  const model = text.match(/Model:\s*(.+)/i)?.[1]?.trim();
  const boardId = text.match(/Board-ID:\s*(.+)/i)?.[1]?.trim();
  return model || boardId ? { model, boardId } : null;
}
