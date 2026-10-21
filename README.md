# Installateur MeshCore

Installe [MeshCore](https://github.com/meshcore-dev/MeshCore) en **Companion Bluetooth** ou en **Répéteur** sur les cartes nRF52, directement depuis le navigateur, par USB.

👉 **https://nitrus21.github.io/meshcore-installer/**

## Deux onglets

- **🔄 Mise à jour** : réécrit uniquement l'application MeshCore. Le nom, les contacts, les canaux, la clé d'identité et les réglages radio sont conservés.
- **🧹 Tout réinitialiser** : installe d'abord un firmware « effaceur » qui formate le stockage de la carte (LittleFS interne, ou flash QSPI selon la carte) et rend la main au bootloader. MeshCore est ensuite installé sur une carte vierge. À utiliser quand on vient de Meshtastic, qu'on change de rôle, ou qu'une carte se comporte mal. Les effaceurs sont ceux du [flasher officiel MeshCore](https://flasher.meshcore.io), téléchargés au moment de la publication. 35 des 50 cartes en ont un.

La détection choisit le bon onglet : Meshtastic détecté → « Tout réinitialiser », MeshCore détecté → « Mise à jour » (avec la version installée). Le lien `#reset` ouvre directement le second onglet.

## Fonctionnement

- **Navigateur** : Chrome ou Edge sur ordinateur, qui gèrent Web Serial. Firefox, Safari et iPhone ne sont pas compatibles. Le fichier `.uf2` reste téléchargeable dans tous les cas.
- **Installation** : la page envoie un « touch » 1200 bauds pour faire redémarrer la carte dans son bootloader Adafruit nRF52. Elle écrit ensuite l'application avec le protocole DFU série de Nordic, le même que `adafruit-nrfutil dfu serial` (voir [`site/dfu.js`](site/dfu.js)). Le bootloader et le SoftDevice ne sont pas modifiés.
- **Configuration du répéteur** : une console série intégrée permet de régler le nom, le mot de passe admin, le preset radio, la puissance TX et la position.
- **Firmwares** : le workflow [`pages.yml`](.github/workflows/pages.yml) s'exécute chaque jour. Il télécharge les dernières releases officielles `companion-v*` et `repeater-v*`, extrait le `.bin` et le `.dat` de chaque paquet DFU nRF52, et publie le tout sur GitHub Pages. Il faut passer par lui parce que les fichiers des releases GitHub ne sont pas accessibles directement depuis une autre page web (pas de CORS).

Pour présélectionner une carte : `?board=ProMicro` (l'identifiant correspond au préfixe des fichiers de release).

## Développement local

```bash
python scripts/build_catalog.py site
python -m http.server -d site 8000
```

Ouvrez ensuite http://localhost:8000 (Web Serial accepte `localhost`). Les firmwares téléchargés dans `site/firmware/` sont ignorés par git.

## Licence

MIT. Les firmwares MeshCore sont distribués sous leur propre licence (MIT), voir le dépôt officiel.
