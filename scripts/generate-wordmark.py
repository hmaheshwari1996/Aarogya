#!/usr/bin/env python3
"""
Renders every Aarogya lockup: the heart-and-ECG mark with the wordmark beneath it.

Four outputs, all of them mark-plus-word:

    splash-logo.png        light splash   teal word on the warm page
    splash-logo-dark.png   dark splash    the dark scheme's teal, on charcoal
    icon.png               legacy launcher icon, full-bleed teal rounded square
    adaptive-icon.png      adaptive foreground, transparent, fitted to the safe circle

WHY THIS IS A SEPARATE SCRIPT FROM generate-icons.js

`generate-icons.js` is deliberately dependency-free — it rasterises the mark from an
implicit curve and encodes PNG with Node's built-in zlib, so anyone can regenerate the
geometry with nothing installed. Text is where that stops being reasonable: drawing seven
letterforms by hand produces exactly the amateurish result a wordmark cannot afford, and
a TrueType rasteriser is not worth writing for one string.

So the split is by responsibility, not by convenience: **geometry lives in the JS script,
anything carrying the WORD lives here.** This script never draws a heart. It takes the
mark's alpha channel and repaints it, so the silhouette is defined in exactly one place
and cannot drift.

    pip install Pillow && npm run gen:brand

`gen:brand` runs both scripts in the right order. Running generate-icons.js ALONE leaves
icon.png and adaptive-icon.png as mark-only intermediates — correct images, but without
the name. This script overwrites them. Their outputs are committed; a normal build never
runs either script.

WHY TWO SPLASH FILES, LIGHT AND DARK

The mark alone could be one teal image on transparent: at ~3:1 against the dark page it
is a graphic, and 3:1 is the floor for non-text. The moment a WORD is under it that stops
being acceptable — text needs 4.5:1, and dark-theme teal on a warm charcoal page does not
get there. `expo-splash-screen` takes a separate `dark.image`, so each theme gets the
wordmark in its own primary and both are comfortably legible.

━━━ THE NAME IN THE LAUNCHER ICON: A DELIBERATE OVERRIDE ━━━

An earlier revision of this file argued the launcher icon should NOT carry the name, and
the argument was sound: Android already draws "Aarogya" under the icon on the home screen
and in the drawer, so the name appears twice; and seven letters inside a 48dp square is a
handful of pixels.

It is in anyway, by the app owner's explicit and repeated instruction. Given that, the
job is to make it as legible as the format allows rather than to shrink the splash lockup
proportionally and call it done:

  • The word is sized to a target WIDTH, not to a font size, so it fills the space it has
    whatever the font's metrics happen to be.
  • The word is set WIDER than the mark. In a lockup that must survive being 48dp tall,
    the readable element deserves the space, and a heart is recognisable far smaller than
    a word is.
  • `icon.png` fits the lockup to an inset square, because a legacy icon is never masked.
  • `adaptive-icon.png` fits it to the INSCRIBED SAFE CIRCLE, not the safe square. Android
    guarantees only the inner 72dp of 108dp, and a circular launcher mask clips to the
    circle inside that. Fitting to the square would give a visibly larger word and clip
    the ends off the app's own name on any launcher using round icons — which is a worse
    outcome than a small word, so the circle wins. That is why the adaptive variant's
    word is smaller than the legacy one's; it is the geometry, not an oversight.
"""

from __future__ import annotations

import math
import os
import subprocess
import sys

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:  # pragma: no cover - a human running this without Pillow
    sys.exit("Pillow is required: pip install Pillow")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "assets", "images")

# The bare mark, white on transparent, written by generate-icons.js. Only its ALPHA is
# ever read, so its colour is irrelevant.
MARK_SRC = os.path.join(OUT, "splash-logo.src.png")

# From src/theme/index.ts. `primary` of each scheme, so the lockup belongs to the app it
# opens rather than floating in a colour nothing else uses.
LIGHT_INK = (0x0A, 0x62, 0x54)
DARK_INK = (0x5F, 0xD3, 0xBC)

# The launcher's own teal. MUST equal android.adaptiveIcon.backgroundColor in
# app.config.ts — the legacy icon paints this itself while the adaptive icon receives it
# from the config, and the two sitting side by side in a drawer would expose any drift.
ICON_BG = (0x0E, 0x7C, 0x6B)
ICON_INK = (0xFF, 0xFF, 0xFF)

WORD = "Aarogya"

# Avenir Next: humanist, generously open apertures, and a tall x-height — the qualities
# that survive presbyopia. A geometric sans (Futura and friends) closes its apertures and
# is measurably harder to read at a glance, which is the wrong trade for this audience.
FONT_CANDIDATES = [
    ("/System/Library/Fonts/Avenir Next.ttc", 2),   # Demi Bold
    ("/System/Library/Fonts/Avenir.ttc", 5),
    ("/System/Library/Fonts/HelveticaNeue.ttc", 2),
    ("/System/Library/Fonts/Helvetica.ttc", 1),
]

# ── Splash geometry ──────────────────────────────────────────────────────────
CANVAS = 512
MARK_TARGET = 300      # the mark's drawn height inside the canvas
GAP = 34               # mark baseline → cap height of the word
FONT_SIZE = 92

# ── Launcher geometry ────────────────────────────────────────────────────────
ICON_CANVAS = 1024
# 0.22 of the half-extent, matching the rounded square generate-icons.js draws for the
# mark-only intermediate. The two must agree or the corner radius jumps when this script
# overwrites that file.
ICON_CORNER = round(0.22 * ICON_CANVAS / 2)
# How much of the legacy icon the lockup may occupy. A launcher icon with no margin looks
# larger than its neighbours and reads as unfinished.
ICON_INSET = 0.84
# Android guarantees the inner 72dp of a 108dp adaptive icon. A round mask clips to the
# circle inscribed in that square, so this is a RADIUS as a fraction of the full canvas.
ADAPTIVE_SAFE_RADIUS = (72 / 108) / 2
# The word is set wider than the mark, because at launcher sizes the word is the element
# that runs out of legibility first. See the header.
WORD_TO_MARK_WIDTH = 1.5
# Vertical air between mark and word, as a fraction of the mark's height.
LOCKUP_GAP_RATIO = 0.13


def load_font(size: int) -> ImageFont.FreeTypeFont:
    for path, index in FONT_CANDIDATES:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size, index=index)
            except OSError:
                continue
    sys.exit("No usable system font found — checked: " + ", ".join(p for p, _ in FONT_CANDIDATES))


def word_ink(font: ImageFont.FreeTypeFont) -> tuple[int, int, int, int]:
    """
    The word's DRAWN extents, not its declared box.

    A font's nominal size says nothing about where the glyphs actually land, and centring
    on the declared box leaves the word visibly off-centre. `Aarogya` makes this concrete:
    it has a cap A at the top and descenders on g and y, so its ink box is nothing like
    its em box.
    """
    probe = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
    return probe.textbbox((0, 0), WORD, font=font)


def font_for_width(target_width: int) -> ImageFont.FreeTypeFont:
    """
    Sizes the font so the word's INK is `target_width` wide.

    Sizing by width rather than by point size is what keeps the lockup stable across the
    font fallback list above: Helvetica set at 92pt is a different width from Avenir Next
    at 92pt, and a lockup that changes proportion depending on which fonts a machine
    happens to have is not a lockup. Glyph advances scale linearly with size, so one probe
    measurement plus one correction lands within a pixel.
    """
    probe_size = 200
    font = load_font(probe_size)
    left, _, right, _ = word_ink(font)
    measured = right - left
    if measured <= 0:
        sys.exit("The font measured the wordmark as zero-width — check the font list.")
    return load_font(max(8, round(probe_size * target_width / measured)))


def recoloured_mark(ink: tuple[int, int, int]) -> Image.Image:
    """
    Takes the mark's ALPHA only and repaints it, cropped to its ink.

    The alpha channel is the whole design — the heart is solid and the ECG is a hole
    punched through it — so repainting is a channel swap, not a redraw. That keeps this
    script from owning any geometry: the shape stays defined in exactly one place,
    `scripts/generate-icons.js`, and cannot drift from the icons.

    Cropping to the ink matters as much. The mark is rendered into a square with a
    transparent margin whose size is an implementation detail of the other script;
    measuring anything from the canvas edge inflates every gap by that margin and leaves
    the word visibly adrift from the mark rather than locked to it.
    """
    mark = Image.open(MARK_SRC).convert("RGBA")
    alpha = mark.getchannel("A")
    solid = Image.new("RGBA", mark.size, (*ink, 255))
    solid.putalpha(alpha)
    box = solid.getbbox()
    return solid.crop(box) if box else solid


def compose_lockup(ink: tuple[int, int, int]) -> Image.Image:
    """
    Mark above word, centred on each other, cropped tight to the ink.

    Returned at whatever size the constants imply; every caller scales it to fit its own
    frame, so this function never needs to know about launcher masks or canvas sizes.
    """
    mark = recoloured_mark(ink)
    mark_h = 600  # working resolution — every output scales down from here
    mark = mark.resize(
        (max(1, round(mark.width * mark_h / mark.height)), mark_h), Image.LANCZOS
    )

    font = font_for_width(round(mark.width * WORD_TO_MARK_WIDTH))
    left, top, right, bottom = word_ink(font)
    word_w, word_h = right - left, bottom - top

    gap = round(mark_h * LOCKUP_GAP_RATIO)
    width = max(mark.width, word_w)
    canvas = Image.new("RGBA", (width, mark_h + gap + word_h), (0, 0, 0, 0))
    canvas.alpha_composite(mark, ((width - mark.width) // 2, 0))

    draw = ImageDraw.Draw(canvas)
    draw.text(((width - word_w) // 2 - left, mark_h + gap - top), WORD, font=font, fill=(*ink, 255))

    box = canvas.getbbox()
    return canvas.crop(box) if box else canvas


def ink_radius(image: Image.Image) -> float:
    """
    The greatest distance from the image's centre to any meaningfully opaque pixel.

    The alpha threshold is 8 rather than 0 on purpose: LANCZOS resampling leaves a haze of
    single-digit alpha around every edge, and treating that haze as ink would make the
    measured radius depend on the resampling filter instead of on the artwork.
    """
    alpha = image.getchannel("A").load()
    cx, cy = image.width / 2, image.height / 2
    worst = 0.0
    for y in range(image.height):
        row = [x for x in range(image.width) if alpha[x, y] > 8]
        if not row:
            continue
        # Only the extreme columns of a row can be the furthest point in that row, so two
        # distance computations per row replace width-many. On a 1000px lockup that is the
        # difference between a thousand operations and a million.
        for x in (row[0], row[-1]):
            worst = max(worst, math.hypot(x - cx, y - cy))
    return max(worst, 1.0)


def scaled(image: Image.Image, factor: float) -> Image.Image:
    return image.resize(
        (max(1, round(image.width * factor)), max(1, round(image.height * factor))),
        Image.LANCZOS,
    )


def report(dest: str, image: Image.Image, note: str = "") -> None:
    print(
        f"  {os.path.basename(dest):<24} {image.width}x{image.height}"
        f"  {os.path.getsize(dest) / 1024:6.1f} kB  {note}"
    )


# ── Splash lockups ───────────────────────────────────────────────────────────

def build_splash(ink: tuple[int, int, int], dest: str) -> None:
    font = load_font(FONT_SIZE)
    mark = recoloured_mark(ink)
    mark = mark.resize(
        (max(1, round(mark.width * MARK_TARGET / mark.height)), MARK_TARGET), Image.LANCZOS
    )

    left, top, right, bottom = word_ink(font)
    word_w, word_h = right - left, bottom - top

    canvas = Image.new("RGBA", (CANVAS, MARK_TARGET + GAP + word_h), (0, 0, 0, 0))
    canvas.alpha_composite(mark, ((CANVAS - mark.width) // 2, 0))
    ImageDraw.Draw(canvas).text(
        ((CANVAS - word_w) // 2 - left, MARK_TARGET + GAP - top), WORD, font=font, fill=(*ink, 255)
    )

    canvas.save(dest)
    report(dest, canvas)


# ── Launcher lockups ─────────────────────────────────────────────────────────

def build_legacy_icon(dest: str) -> None:
    """
    The full-bleed rounded square used by launchers that do not mask.

    Nothing clips here, so the lockup gets the whole inset box.
    """
    lockup = compose_lockup(ICON_INK)
    box = round(ICON_CANVAS * ICON_INSET)
    lockup = scaled(lockup, min(box / lockup.width, box / lockup.height))

    canvas = Image.new("RGBA", (ICON_CANVAS, ICON_CANVAS), (0, 0, 0, 0))
    ImageDraw.Draw(canvas).rounded_rectangle(
        (0, 0, ICON_CANVAS - 1, ICON_CANVAS - 1), radius=ICON_CORNER, fill=(*ICON_BG, 255)
    )
    canvas.alpha_composite(
        lockup, ((ICON_CANVAS - lockup.width) // 2, (ICON_CANVAS - lockup.height) // 2)
    )
    canvas.save(dest)
    report(dest, canvas, f"word ~{word_cap_px(lockup)}px at 1024")


def build_adaptive_icon(dest: str) -> None:
    """
    The adaptive foreground: transparent, background supplied by app.config.ts.

    Fitted so the furthest INK sits on the safe circle — not the furthest corner of the
    bounding box.

    That distinction is worth the extra pass. The obvious fit solves
    (w/2)² + (h/2)² = r² for the bounding box, but this lockup's box corners are empty:
    the mark is a heart, the word is centred, and nothing at all is drawn in the four
    corners. Fitting the box therefore reserves circle for pixels that do not exist and
    costs about 7% of the word's height — which, in an icon where the whole complaint was
    that the name is too small, is not a rounding error.

    So we measure the real thing: the greatest distance from the lockup's centre to any
    pixel that is meaningfully opaque, and scale so that distance lands on the radius.
    """
    lockup = compose_lockup(ICON_INK)
    radius = ICON_CANVAS * ADAPTIVE_SAFE_RADIUS
    lockup = scaled(lockup, radius / ink_radius(lockup))

    canvas = Image.new("RGBA", (ICON_CANVAS, ICON_CANVAS), (0, 0, 0, 0))
    canvas.alpha_composite(
        lockup, ((ICON_CANVAS - lockup.width) // 2, (ICON_CANVAS - lockup.height) // 2)
    )
    canvas.save(dest)
    report(dest, canvas, f"word ~{word_cap_px(lockup)}px at 1024, inside the safe circle")


def word_cap_px(lockup: Image.Image) -> int:
    """
    Rough cap height of the word as placed, for the console report.

    Derived from the composition ratios rather than measured off the pixels: the point of
    printing it is to let a human sanity-check legibility at 48dp without opening the file.
    """
    mark_share = 1 / (1 + LOCKUP_GAP_RATIO + 0.30)
    word_band = lockup.height * (1 - mark_share * (1 + LOCKUP_GAP_RATIO))
    return round(word_band * 0.72)


def main() -> None:
    # The mark is generated, never stored twice. Ask its owner for a fresh copy if it is
    # missing — and note that this ALSO rewrites icon.png and adaptive-icon.png as
    # mark-only intermediates, which the two builders below then overwrite.
    if not os.path.exists(MARK_SRC):
        subprocess.run(["node", os.path.join(ROOT, "scripts", "generate-icons.js")], check=True)

    build_splash(LIGHT_INK, os.path.join(OUT, "splash-logo.png"))
    build_splash(DARK_INK, os.path.join(OUT, "splash-logo-dark.png"))
    build_legacy_icon(os.path.join(OUT, "icon.png"))
    build_adaptive_icon(os.path.join(OUT, "adaptive-icon.png"))
    print("\n  two splash lockups + two launcher icons, all carrying the name")
    print("  notification-icon.png is left mark-only on purpose: Android tints it and")
    print("  draws it at 24dp, where a word is not a word.")


if __name__ == "__main__":
    main()
