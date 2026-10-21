// Flash des cartes ESP32 avec esptool-js (bootloader ROM Espressif). Passage en mode programmation
// automatique : DTR/RTS du pont USB-série, ou reset USB-JTAG pour l'USB natif des S3 / C3 / C6.
//  - mise à jour      : application seule (partition app), le reste de la flash (réglages, identité) est conservé
//  - réinitialisation : effacement complet puis image « merged » (bootloader + partitions + application) en 0x0

const ESPTOOL_URL = 'https://cdn.jsdelivr.net/npm/esptool-js@0.6.1/bundle.js';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function flashEsp32(port, data, { address, eraseAll, log, progress }) {
  const { ESPLoader, Transport } = await import(ESPTOOL_URL);
  const transport = new Transport(port, false);
  const terminal = {
    clean() {},
    write() {},
    // esptool écrit une ligne par bloc : la barre de progression suffit
    writeLine: (line) => { if (!/^esptool\.js$|^Writing at|^Took|^Wrote|^Hash of data/.test(line)) log(line); },
  };
  const loader = new ESPLoader({ transport, baudrate: 460800, romBaudrate: 115200, terminal, enableTracing: false });

  try {
    try {
      log('Connexion au bootloader ESP32…');
      await loader.main();
    } catch (e) {
      throw new Error(`l’ESP32 ne répond pas (${e.message || e}). Maintenez le bouton BOOT (ou PRG), appuyez sur RST (ou rebranchez le câble), relâchez BOOT puis recommencez.`);
    }
    if (eraseAll) log('Effacement complet de la flash (≈ 20 s)…');
    await loader.writeFlash({
      fileArray: [{ data, address }],
      flashMode: 'keep', flashFreq: 'keep', flashSize: 'keep',
      eraseAll, compress: true,
      reportProgress: (_, written, total) => progress(written / total),
    });
    log('Redémarrage de la carte…');
    let otg = false; // USB-OTG (TinyUSB) : reset plus lent
    try { otg = !!(await loader.chip.usingUsbOtg?.(loader)); } catch {}
    await loader.after('hard_reset', otg);
  } finally {
    // Impulsion RTS : certaines cartes restent sinon bloquées en reset après la déconnexion
    try {
      await transport.setRTS(true);
      await sleep(100);
      await transport.setRTS(false);
    } catch {}
    try { await transport.disconnect(); } catch {}
  }
}
