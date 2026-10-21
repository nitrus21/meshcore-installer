# Installateur MeshCore

Installe [MeshCore](https://github.com/meshcore-dev/MeshCore) en **Companion Bluetooth** ou en **Répéteur** sur les cartes nRF52 et ESP32 (pour l'instant la Heltec WiFi LoRa 32 V3), directement depuis le navigateur, par USB.

👉 **https://nitrus21.github.io/meshcore-installer/**

## Deux onglets

- **🔄 Mise à jour** : réécrit uniquement l'application MeshCore. Le nom, les contacts, les canaux, la clé d'identité et les réglages radio sont conservés.
- **🧹 Tout réinitialiser** : installe d'abord un firmware « effaceur » qui formate le stockage de la carte (LittleFS interne, ou flash QSPI selon la carte) et rend la main au bootloader. MeshCore est ensuite installé sur une carte vierge. À utiliser quand on vient de Meshtastic, qu'on change de rôle, ou qu'une carte se comporte mal. Les effaceurs sont ceux du [flasher officiel MeshCore](https://flasher.meshcore.io), téléchargés au moment de la publication. 35 des 50 cartes nRF52 en ont un.

Sur ESP32, la mise à jour écrit seulement l'application (en `0x10000`) et la réinitialisation efface toute la flash avant d'écrire l'image complète `-merged.bin` (en `0x0`), comme le flasher officiel.

La détection choisit le bon onglet : Meshtastic détecté → « Tout réinitialiser », MeshCore détecté → « Mise à jour » (avec la version installée). Le lien `#reset` ouvre directement le second onglet.

## Fonctionnement

- **Navigateur** : Chrome ou Edge sur ordinateur, qui gèrent Web Serial. Firefox, Safari et iPhone ne sont pas compatibles. Le fichier `.uf2` reste téléchargeable dans tous les cas.
- **Installation** : la page envoie un « touch » 1200 bauds pour faire redémarrer la carte dans son bootloader Adafruit nRF52. Elle écrit ensuite l'application avec le protocole DFU série de Nordic, le même que `adafruit-nrfutil dfu serial` (voir [`site/dfu.js`](site/dfu.js)). Le bootloader et le SoftDevice ne sont pas modifiés.
- **ESP32** : la page utilise [esptool-js](https://github.com/espressif/esptool-js) (version figée, chargée depuis jsDelivr) via le pont USB-série de la carte (CP210x, CH340…), qui la fait passer seule en mode programmation (voir [`site/esp32.js`](site/esp32.js)). Le sélecteur de port ne propose que les ports adaptés à la puce de la carte choisie. Un ESP32 consomme beaucoup plus qu'un nRF52 : il est déconseillé pour un répéteur solaire.
- **Configuration du répéteur** : une console série intégrée permet de régler le nom, le mot de passe admin, le preset radio, la puissance TX et la position.
- **Firmwares** : le workflow [`pages.yml`](.github/workflows/pages.yml) s'exécute chaque jour. Il télécharge les dernières releases officielles `companion-v*` et `repeater-v*`, extrait le `.bin` et le `.dat` de chaque paquet DFU nRF52, récupère le `.bin` et le `-merged.bin` des cartes ESP32 retenues (`ESP32_BOARDS` dans [`build_catalog.py`](scripts/build_catalog.py)), et publie le tout sur GitHub Pages. Il faut passer par lui parce que les fichiers des releases GitHub ne sont pas accessibles directement depuis une autre page web (pas de CORS).

Pour présélectionner une carte : `?board=ProMicro` (l'identifiant correspond au préfixe des fichiers de release).

## Développement local

```bash
python scripts/build_catalog.py site
python -m http.server -d site 8000
```

Ouvrez ensuite http://localhost:8000 (Web Serial accepte `localhost`). Les firmwares téléchargés dans `site/firmware/` sont ignorés par git.

## Licence

MIT. Les firmwares MeshCore sont distribués sous leur propre licence (MIT), voir le dépôt officiel.
