# Who's Bluffing? brand kit

The mark is a hand of two cards, fanned, with a square turned 45° cut out of the front card: the diamond pip. Each
card is two of the game's five result squares fused; the pip is the fifth, the only one that is turned. Bluffing is a
card-table word, and the pip is the one piece that does not sit straight.

## Files

| File | Use |
|---|---|
| `icon.svg` | App icon: dark tile `#111827`, corner radius 14/64, back card `#7A95FF`, front card `#F5F3EE`, pip cut to the tile colour. Favicon, Discord and Slack app icon, GitHub avatar, social preview. |
| `icon-light.svg` | Same on the paper tile `#FBFAF7` (back `#2F5BFF`, front `#111827`). |
| `icon-square.svg` | Square corners, for platforms that apply their own mask (iOS, some bot lists). |
| `mark.svg` | Bare mark for light backgrounds (front ink, back accent, pip paper). |
| `mark-white.svg` | Bare mark for dark backgrounds (front `#F5F3EE`, back `#7A95FF`, pip navy). |
| `mark-mono.svg` | One colour (`currentColor`), pip white. |
| `mark-inline.svg` | The snippet the site uses: classes `back`, `front`, `pip` take `var(--accent)`, `var(--text)` and `var(--bg)`; rotations sit on `<g>` wrappers so CSS can animate the inner rects. |
| `png/icon-{16…1024}.png` | Raster exports of `icon.svg`. Discord wants 512 or larger; Slack 512–2000; GitHub 500 or larger. |
| `png/icon-square-1024.png`, `png/icon-light-1024.png`, `png/mark-1024.png`, `png/mark-white-1024.png` | Raster exports of the other masters. |
| `preview.png` | Icon at several sizes, the lockups, a home-screen mock. |
| `emblems/{bluffer,hot_headed,calibrated,modest,hedger}.png` | 3D emblem for each result type (cards and chips, balloon, target, violet, safe), 1024 px on transparent. The site shows 320 px WebP copies (`web/public/img/types/`) on the result card. `emblems/make_emblems.py` rebuilds all of them in Blender. |

## Geometry (viewBox 0 0 38 44)

| Piece | Rect | Rotation |
|---|---|---|
| back card | centre (16.5, 20), 25 × 35, rx 5.5 | −14° about its centre |
| front card | centre (22.5, 24), 25 × 35, rx 5.5 | +9° about its centre |
| pip | centre (22.5, 24), 9.5 × 9.5, rx 1.6, drawn inside the front card's group | +45° about its centre (so 54° in total) |

Draw order: back card, front card, pip. In the 64×64 tile the mark is scaled to 68% of the tile height and centred.

## Lockup

Bare mark at about 1.2× the cap height, 8px gap, then `Who's Bluffing?` in the site's 800-weight system font stack.
The typed question mark stays.

## Rules

- Never show five equal squares in a row, or the earlier blocky question mark, as a logo; both are retired.
- Keep the pip cut out (background colour), never filled; keep the fan angles.
- Clear space around the tile: at least a quarter of the tile on every side.
- Minimum sizes: tile 16px, bare mark 16px tall.
- The SVG masters are the source. Edit them directly and re-export the PNGs with any SVG rasteriser; the site renders
  what it needs with `web/design/render.js assets`.
