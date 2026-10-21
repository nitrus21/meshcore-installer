// Nordic "legacy" serial DFU (protocole d'adafruit-nrfutil `dfu serial`)
// utilisé par le bootloader Adafruit nRF52 (nice!nano, ProMicro, RAK4631, T114…).
// Fonctionne avec n'importe quel objet compatible Web Serial (SerialPort).

const DFU_INIT_PACKET = 1;
const DFU_START_PACKET = 3;
const DFU_DATA_PACKET = 4;
const DFU_STOP_DATA_PACKET = 5;
const MODE_APPLICATION = 4;

const DFU_PACKET_MAX_SIZE = 512;
const FLASH_PAGE_SIZE = 4096;
const FLASH_PAGE_ERASE_TIME = 0.0897; // s
const FLASH_PAGE_WRITE_TIME = 0.1024; // s
const ACK_TIMEOUT_MS = 1000;
const MAX_ATTEMPTS = 4;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const u32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];

export function crc16(data, crc = 0xffff) {
  for (const b of data) {
    crc = ((crc >> 8) & 0x00ff) | ((crc << 8) & 0xff00);
    crc ^= b;
    crc ^= (crc & 0x00ff) >> 4;
    crc ^= (crc << 12) & 0xffff;
    crc ^= ((crc & 0x00ff) << 5) & 0xffff;
  }
  return crc & 0xffff;
}

function slipEscape(bytes) {
  const out = [];
  for (const b of bytes) {
    if (b === 0xc0) out.push(0xdb, 0xdc);
    else if (b === 0xdb) out.push(0xdb, 0xdd);
    else out.push(b);
  }
  return out;
}

function slipUnescape(bytes) {
  const out = [];
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0xdb && bytes[i + 1] === 0xdc) { out.push(0xc0); i++; }
    else if (bytes[i] === 0xdb && bytes[i + 1] === 0xdd) { out.push(0xdb); i++; }
    else out.push(bytes[i]);
  }
  return out;
}

// Paquet HCI "three-wire UART" : en-tête 4 octets + données + CRC16, encodé SLIP.
export function hciPacket(seq, payload) {
  const len = payload.length;
  const h = [
    seq | (((seq + 1) % 8) << 3) | (1 << 6) | (1 << 7), // integrity check + reliable
    14 | ((len & 0x000f) << 4),                          // type 14 = vendor specific
    (len & 0x0ff0) >> 4,
    0,
  ];
  h[3] = (~(h[0] + h[1] + h[2]) + 1) & 0xff;
  const body = [...h, ...payload];
  const crc = crc16(body);
  body.push(crc & 0xff, (crc >> 8) & 0xff);
  return new Uint8Array([0xc0, ...slipEscape(body), 0xc0]);
}

export class NordicDfu {
  constructor(port, { log = () => {}, progress = () => {} } = {}) {
    this.port = port;
    this.log = log;
    this.progress = progress;
    this.seq = 0;
    this.frames = [];
    this.waiters = [];
    this.current = [];
  }

  async open() {
    await this.port.open({ baudRate: 115200, flowControl: 'none' });
    this.writer = this.port.writable.getWriter();
    this.reader = this.port.readable.getReader();
    this.readLoop = this.#readLoop();
  }

  async close() {
    try { await this.reader?.cancel(); } catch {}
    try { this.reader?.releaseLock(); } catch {}
    try { this.writer?.releaseLock(); } catch {}
    try { await this.readLoop; } catch {}
    try { await this.port.close(); } catch {}
  }

  async #readLoop() {
    for (;;) {
      let res;
      try { res = await this.reader.read(); } catch { break; }
      if (res.done) break;
      for (const b of res.value) {
        if (b === 0xc0) {
          if (this.current.length) {
            this.frames.push(slipUnescape(this.current));
            this.current = [];
            this.#wake();
          }
        } else {
          this.current.push(b);
        }
      }
    }
  }

  #wake() {
    while (this.waiters.length && this.frames.length) this.waiters.shift()(this.frames.shift());
  }

  #nextFrame(timeoutMs) {
    if (this.frames.length) return Promise.resolve(this.frames.shift());
    return new Promise((resolve) => {
      const w = (f) => { clearTimeout(t); resolve(f); };
      const t = setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== w);
        resolve(null);
      }, timeoutMs);
      this.waiters.push(w);
    });
  }

  async #send(payload) {
    this.seq = (this.seq + 1) % 8;
    const pkt = hciPacket(this.seq, payload);
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await this.writer.write(pkt);
      const ack = await this.#nextFrame(ACK_TIMEOUT_MS);
      if (ack && ack.length) return (ack[0] >> 3) & 0x07;
      this.log(`Pas d'accusé de réception (tentative ${attempt}/${MAX_ATTEMPTS})…`);
    }
    throw new Error("La carte ne répond pas. Est-elle bien en mode bootloader ?");
  }

  // init = contenu du .dat, firmware = contenu du .bin (application seule)
  async flash(init, firmware) {
    const total = firmware.length;
    this.log(`Démarrage DFU : application de ${(total / 1024).toFixed(1)} Ko`);
    await this.#send([...u32(DFU_START_PACKET), ...u32(MODE_APPLICATION), ...u32(0), ...u32(0), ...u32(total)]);

    const eraseMs = Math.max(500, (Math.floor(total / FLASH_PAGE_SIZE) + 1) * FLASH_PAGE_ERASE_TIME * 1000);
    this.log(`Effacement de la zone application (~${(eraseMs / 1000).toFixed(1)} s)…`);
    await sleep(eraseMs);

    this.log('Envoi du paquet d’initialisation');
    await this.#send([...u32(DFU_INIT_PACKET), ...init, 0x00, 0x00]);

    this.log('Écriture du firmware…');
    const count = Math.ceil(total / DFU_PACKET_MAX_SIZE);
    for (let i = 0; i < count; i++) {
      const chunk = firmware.subarray(i * DFU_PACKET_MAX_SIZE, (i + 1) * DFU_PACKET_MAX_SIZE);
      await this.#send([...u32(DFU_DATA_PACKET), ...chunk]);
      if (i % 8 === 7) await sleep(FLASH_PAGE_WRITE_TIME * 1000);
      this.progress((i + 1) / count);
    }
    await sleep(FLASH_PAGE_WRITE_TIME * 1000);

    this.log('Validation et redémarrage de la carte…');
    await this.#send(u32(DFU_STOP_DATA_PACKET));
  }
}

// "Touch" 1200 bauds : demande au firmware Adafruit de redémarrer en mode DFU série.
export async function touch1200(port) {
  await port.open({ baudRate: 1200 });
  try { await port.setSignals({ dataTerminalReady: true }); } catch {}
  await sleep(100);
  try { await port.setSignals({ dataTerminalReady: false }); } catch {}
  await sleep(100);
  await port.close();
}
