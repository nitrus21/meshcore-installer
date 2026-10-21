#!/usr/bin/env python3
"""Télécharge les derniers firmwares MeshCore (Companion BLE + Repeater) des cartes nRF52
et ESP32 depuis les releases GitHub et prépare le dossier publié sur GitHub Pages.

usage: python scripts/build_catalog.py <dossier_de_sortie>
Le dossier de sortie reçoit firmware/catalog.json et firmware/<carte>/<rôle>/…
"""
import io
import json
import os
import re
import sys
import urllib.request
import zipfile
from datetime import datetime, timezone

REPO = "meshcore-dev/MeshCore"
ROLES = {
    "companion": {"tag": "companion-v", "pattern": r"^(?P<board>.+)_companion_radio_ble-(?P<ver>v[\d.]+)-[0-9a-f]+\.zip$"},
    "repeater": {"tag": "repeater-v", "pattern": r"^(?P<board>.+)_repeater-(?P<ver>v[\d.]+)-[0-9a-f]+\.zip$"},
}
# ESP32 : image complète « -merged.bin » (bootloader + partitions + application, écrite en 0x0)
# et application seule « .bin » (écrite en 0x10000, conserve les données).
ESP32_PATTERNS = {
    "companion": r"^(?P<board>.+)_companion_radio_ble-(?P<ver>v[\d.]+)-[0-9a-f]+-merged\.bin$",
    "repeater": r"^(?P<board>.+)_repeater-(?P<ver>v[\d.]+)-[0-9a-f]+-merged\.bin$",
}
# Cartes ESP32 proposées (les autres restent à valider une par une).
ESP32_BOARDS = {"Heltec_v3"}

# Noms lisibles ; les cartes absentes gardent leur identifiant de release.
NAMES = {
    "ProMicro": "ProMicro nRF52840 (FakeTec / nice!nano DIY)",
    "RAK_4631": "RAK WisBlock 4631",
    "RAK_3401": "RAK WisBlock 3401 (1 W)",
    "RAK_WisMesh_Tag": "RAK WisMesh Tag",
    "Heltec_t114": "Heltec Mesh Node T114",
    "Heltec_t114_without_display": "Heltec Mesh Node T114 (sans écran)",
    "Heltec_t096": "Heltec T096",
    "Heltec_t1": "Heltec T1",
    "Heltec_tower_v2": "Heltec Mesh Tower v2",
    "Heltec_mesh_solar": "Heltec Mesh Solar",
    "t1000e": "Seeed SenseCAP T1000-E",
    "SenseCap_Solar": "Seeed SenseCAP Solar Node",
    "Xiao_nrf52": "Seeed XIAO nRF52840 + Wio-SX1262",
    "WioTrackerL1": "Seeed Wio Tracker L1",
    "WioTrackerL1Eink": "Seeed Wio Tracker L1 E-Ink",
    "WioTrackerL1-1W": "Seeed Wio Tracker L1 (1 W)",
    "LilyGo_T-Echo": "LilyGO T-Echo",
    "LilyGo_T-Echo-Lite": "LilyGO T-Echo Lite",
    "LilyGo_T-Echo-Lite_non_shell": "LilyGO T-Echo Lite (sans boîtier)",
    "LilyGo_T-Echo_Card": "LilyGO T-Echo Card",
    "LilyGo_T_Impulse_Plus": "LilyGO T-Impulse Plus",
    "Nano_G2_Ultra": "B&Q Nano G2 Ultra",
    "Mesh_pocket": "Heltec MeshPocket",
    "Meshtiny": "Meshtiny",
    "MeshTracker_X1": "MeshTracker X1",
    "Minewsemi_me25ls01": "Minewsemi ME25LS01",
    "KeepteenLT1": "Keepteen LT1",
    "R1Neo": "R1 Neo",
    "ThinkNode_M1": "Elecrow ThinkNode M1",
    "ThinkNode_M3": "Elecrow ThinkNode M3",
    "ThinkNode_M4": "Elecrow ThinkNode M4",
    "ThinkNode_M6": "Elecrow ThinkNode M6",
    "ThinkNode_M8": "Elecrow ThinkNode M8",
    "Heltec_v3": "Heltec WiFi LoRa 32 V3",
}
FEATURED = ["ProMicro"]


def http_get(url, accept="application/octet-stream"):
    headers = {"User-Agent": "meshcore-installer", "Accept": accept}
    token = os.environ.get("GITHUB_TOKEN")
    if token and "api.github.com" in url:
        headers["Authorization"] = f"Bearer {token}"
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=120) as r:
        return r.read()


def latest_release(prefix):
    releases = json.loads(http_get(f"https://api.github.com/repos/{REPO}/releases?per_page=40", "application/vnd.github+json"))
    for rel in releases:
        if rel["tag_name"].startswith(prefix) and not rel["prerelease"] and not rel["draft"]:
            return rel
    raise SystemExit(f"Aucune release {prefix}* trouvée")


def extract_dfu(zip_bytes):
    """Retourne (bin, dat) si le zip ne contient qu'une application, sinon None."""
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as z:
        manifest = json.loads(z.read("manifest.json"))["manifest"]
        if set(manifest) - {"application", "dfu_version"} or "application" not in manifest:
            return None
        app = manifest["application"]
        return z.read(app["bin_file"]), z.read(app["dat_file"])


FLASHER = "https://flasher.meshcore.io"


def erasers(out_dir):
    """Firmwares « effaceurs » du flasher officiel MeshCore : formatent le stockage (LittleFS
    interne ou flash QSPI) puis rendent la main au bootloader. Retourne {carte: chemin}."""
    config = json.loads(http_get(f"{FLASHER}/config.json", "application/json"))
    by_board, done = {}, {}
    for device in config["device"]:
        zip_name = device.get("erase")
        if not zip_name:
            continue
        # Les cartes d'un appareil se lisent dans les motifs de ses firmwares, ex. "(?:ProMicro|Faketec)_repeater.*"
        prefixes = set()
        for fw in device.get("firmware", []):
            for key, src in fw.items():
                if key.startswith("github"):
                    for pat in src.get("files", {}).values():
                        m = re.match(r"^(?:\(\?:([^)]+)\)|([A-Za-z0-9_\-]+?))_(?:\[[rR]{2}\]epeater|[rR]epeater|companion|room)", pat)
                        if m:
                            prefixes.update((m[1] or m[2]).split("|"))
        if zip_name not in done:
            dfu = extract_dfu(http_get(f"{FLASHER}/firmware/{zip_name}"))
            name = zip_name[:-4]
            rel_dir = f"firmware/erase/{name}"
            os.makedirs(os.path.join(out_dir, rel_dir), exist_ok=True)
            for fname, data in zip(("firmware.bin", "firmware.dat"), dfu):
                with open(os.path.join(out_dir, rel_dir, fname), "wb") as f:
                    f.write(data)
            done[zip_name] = {"bin": f"{rel_dir}/firmware.bin", "dat": f"{rel_dir}/firmware.dat", "name": name}
            print(f"  effaceur {name} ✓")
        for p in prefixes:
            by_board[p] = done[zip_name]
    return by_board


def main(out_dir):
    fw_root = os.path.join(out_dir, "firmware")
    os.makedirs(fw_root, exist_ok=True)
    boards, roles, chips = {}, {}, {}

    for role, spec in ROLES.items():
        rel = latest_release(spec["tag"])
        assets = {a["name"]: a for a in rel["assets"]}
        roles[role] = {"tag": rel["tag_name"], "date": rel["published_at"][:10], "url": rel["html_url"]}
        print(f"{role}: {rel['tag_name']}")

        for name, asset in sorted(assets.items()):
            m = re.match(spec["pattern"], name)
            if not m:
                continue
            board, version = m["board"], m["ver"]
            dfu = extract_dfu(http_get(asset["browser_download_url"]))
            if not dfu:
                print(f"  ignoré (pas une application seule) : {name}")
                continue
            rel_dir = f"firmware/{board}/{role}"
            os.makedirs(os.path.join(out_dir, rel_dir), exist_ok=True)
            for fname, data in zip(("firmware.bin", "firmware.dat"), dfu):
                with open(os.path.join(out_dir, rel_dir, fname), "wb") as f:
                    f.write(data)

            entry = {"version": version, "bin": f"{rel_dir}/firmware.bin", "dat": f"{rel_dir}/firmware.dat", "size": len(dfu[0])}
            uf2_name = name[:-4] + ".uf2"
            if uf2_name in assets:
                with open(os.path.join(out_dir, rel_dir, uf2_name), "wb") as f:
                    f.write(http_get(assets[uf2_name]["browser_download_url"]))
                entry["uf2"] = f"{rel_dir}/{uf2_name}"
            boards.setdefault(board, {})[role] = entry
            chips[board] = "nrf52"
            print(f"  {board} ✓")

        for name, asset in sorted(assets.items()):
            m = re.match(ESP32_PATTERNS[role], name)
            if not m or m["board"] not in ESP32_BOARDS:
                continue
            board, version = m["board"], m["ver"]
            app_name = name[: -len("-merged.bin")] + ".bin"
            if app_name not in assets:
                print(f"  ignoré (application seule absente) : {name}")
                continue
            rel_dir = f"firmware/{board}/{role}"
            os.makedirs(os.path.join(out_dir, rel_dir), exist_ok=True)
            app = http_get(assets[app_name]["browser_download_url"])
            for fname, data in (("firmware.bin", app), ("merged.bin", http_get(asset["browser_download_url"]))):
                with open(os.path.join(out_dir, rel_dir, fname), "wb") as f:
                    f.write(data)
            boards.setdefault(board, {})[role] = {"version": version, "bin": f"{rel_dir}/firmware.bin", "merged": f"{rel_dir}/merged.bin", "size": len(app)}
            chips[board] = "esp32"
            print(f"  {board} (ESP32) ✓")

    print("effaceurs :")
    erase = erasers(out_dir)

    catalog = {
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": f"https://github.com/{REPO}",
        "roles": roles,
        "boards": sorted(
            ({"id": b, "name": NAMES.get(b, b.replace("_", " ")), "chip": chips[b], "featured": b in FEATURED, "firmware": fw,
              **({"erase": erase[b]} if b in erase and chips[b] == "nrf52" else {})}
             for b, fw in boards.items()),
            key=lambda x: (not x["featured"], x["name"].lower()),
        ),
    }
    with open(os.path.join(fw_root, "catalog.json"), "w", encoding="utf-8") as f:
        json.dump(catalog, f, ensure_ascii=False, indent=1)
    print(f"{len(boards)} cartes dans le catalogue")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "_site")
