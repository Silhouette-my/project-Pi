#!/usr/bin/env python3
"""Derive PI-Desktop platform icon resources from the Icon Composer document.

Source of truth: ``apps/desktop/build/icon.icon`` (Icon Composer document, two
layer images ``pi-black.svg`` / ``pi-white.svg``). It is monochrome: white tile
with a black Pi mark in the light appearance, black tile with a white mark in
the dark appearance. electron-builder compiles it into ``Assets.car`` for
macOS 26 appearance-aware icons. This script renders the same document into
the legacy, pre-macOS-26 resources (padded tile with shadow, which the OS does
not draw for us there):

  apps/desktop/build/icon_1024.png       - light legacy master (Dock, runtime)
  apps/desktop/build/icon-dark_1024.png  - dark legacy master (runtime Dock)
  apps/desktop/build/icon.icns           - light, via `iconutil` (fallback/DMG)
  apps/desktop/build/icon.ico            - Windows (light)
  apps/desktop/build/icon.png            - 512px Windows/Linux (light)
  apps/desktop/build/tray-icon-mac.png   - black mark on transparent, used as a
                                           template image (menu bar tints it)

Needs macOS with Xcode 26 (Icon Composer's `ictool`) and Pillow.
Run: python3 scripts/make-icon.py
"""

from __future__ import annotations

import shutil
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / "apps" / "desktop" / "build"
ICON_DOC = BUILD / "icon.icon"
ICTOOL = Path(
    "/Applications/Xcode.app/Contents/Applications/Icon Composer.app"
    "/Contents/Executables/ictool"
)

BASE = 1024
TILE = 824  # macOS icon grid: 824pt tile centred in a 1024pt canvas
MARK = (165.29, 165.29, 634.72, 634.72)  # Pi mark bounds in its 800-unit space


def render(rendition: str, size: int) -> Image.Image:
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "out.png"
        subprocess.run(
            [
                str(ICTOOL), str(ICON_DOC), "--export-image",
                "--output-file", str(out), "--platform", "macOS",
                "--rendition", rendition, "--width", str(size),
                "--height", str(size), "--scale", "1",
            ],
            check=True,
            capture_output=True,
        )
        return Image.open(out).convert("RGBA")


def legacy(rendition: str, shadow_opacity: int) -> Image.Image:
    """Tile on the macOS grid with the drop shadow pre-Tahoe icons carry."""
    tile = render(rendition, TILE)
    offset = (BASE - TILE) // 2
    canvas = Image.new("RGBA", (BASE, BASE), (0, 0, 0, 0))
    shadow = Image.new("RGBA", (BASE, BASE), (0, 0, 0, 0))
    shadow.paste((0, 0, 0, shadow_opacity), (offset, offset + 10), tile.split()[3])
    canvas.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(10)))
    canvas.alpha_composite(tile, (offset, offset))
    return canvas


def tray_mark() -> Image.Image:
    """Black Pi mark on transparent; macOS recolours template images."""
    tile = render("Default", 4096)
    flat = Image.new("RGBA", tile.size, (255, 255, 255, 255))
    flat.alpha_composite(tile)
    # The light tile is white, so inverted luminance is 255 only on the mark.
    mark = flat.convert("L").point(lambda v: 255 - v)
    alpha = mark.crop(mark.getbbox()).resize((768, 768), Image.LANCZOS)
    out = Image.new("RGBA", (BASE, BASE), (0, 0, 0, 0))
    out.paste((0, 0, 0, 255), (128, 128), alpha)
    return out


def main() -> None:
    if not ICTOOL.is_file():
        raise FileNotFoundError(f"Icon Composer ictool is missing: {ICTOOL}")

    light = legacy("Default", 70)
    dark = legacy("Dark", 150)
    light.save(BUILD / "icon_1024.png")
    dark.save(BUILD / "icon-dark_1024.png")
    light.resize((512, 512), Image.LANCZOS).save(BUILD / "icon.png")
    light.save(
        BUILD / "icon.ico",
        format="ICO",
        sizes=[(s, s) for s in (16, 32, 48, 64, 128, 256)],
    )
    tray_mark().save(BUILD / "tray-icon-mac.png")

    iconset = BUILD / "icon.iconset"
    if iconset.exists():
        shutil.rmtree(iconset)
    iconset.mkdir()
    for sz in (16, 32, 128, 256, 512):
        light.resize((sz, sz), Image.LANCZOS).save(iconset / f"icon_{sz}x{sz}.png")
        light.resize((sz * 2, sz * 2), Image.LANCZOS).save(
            iconset / f"icon_{sz}x{sz}@2x.png"
        )
    iconutil = shutil.which("iconutil")
    if iconutil is None:
        print("skipped icon.icns (iconutil is unavailable)")
    else:
        subprocess.run(
            [iconutil, "-c", "icns", str(iconset), "-o", str(BUILD / "icon.icns")],
            check=True,
        )
    shutil.rmtree(iconset)
    print("wrote icon_1024.png, icon-dark_1024.png, icon.png, icon.ico, "
          "tray-icon-mac.png, icon.icns")


if __name__ == "__main__":
    main()
