# Security-print assets for the website

Every image here ships as an alpha mask: black pixels whose opacity is the ink.
The site paints each one with CSS `mask-image` over a theme colour, so the same
file prints gold on the dark theme and bottle green on the light one. No file
carries its own colour.

## Engravings

- `griffin-engraved.webp` is the Segreant griffin as an intaglio engraving,
  computed from the traced mark (the same trace as `../brand/mark-plain.svg`): a
  depth field by repeated erosion, a raking light from the upper left, and
  parallel hatching that bows around the form, with each line's width set by
  how dark the surface is. No generated raster is involved.
- `vignette-ledger.webp`, `vignette-gate.webp` and `vignette-workshop.webp` are
  banknote-style vignettes generated with ChatGPT image generation on
  2026-09-30, from briefs written for this site. A faux signature in the gate
  vignette was removed by hand. Each was converted to an ink mask (ink density =
  1 − luminance, paper clipped to zero) and resized to 960 px.
- `mark-ink.svg` is `../brand/mark-plain.svg` without its background square, for
  use as a mask.

## Guilloche

`guilloche-rosette.svg`, `guilloche-border.svg` and `guilloche-corner.svg` are
generated geometry: families of closed hypotrochoids (rosettes) and
phase-shifted sine strands (the rope border), each curve a hair out of phase
with the next, the way a guilloche lathe builds a banknote background.

## Paper

`paper-uv.webp` (dark) and `paper-light.webp` (light) are paper-stock textures
generated with ChatGPT image generation on 2026-09-30, made tileable with a
half-offset cross-blend and resized for the web.

## The print run (motion layer)

- `griffin-emboss-hi.webp` / `griffin-emboss-lo.webp`: a blind emboss of the plate,
  computed from the engraving's own ink (blurred to a height field, lit from the
  upper left), shipped as highlight and shade masks.
- `rosette-hero.svg`: a lighter rosette whose curves the page traces in turn.
- `tear.svg` / `tear-core.svg`: the hero sheet's torn edge (midpoint-displacement
  tear with fibre jitter) and the lighter core that shows where paper tears.
- `foil.svg`: the note's foil stripe, struck metal with a hairline diffraction
  ruling and a specular band.
- `uv-fibres.webp`: fluorescent security fibres, drawn as seeded random curves.
- `latent.svg`: the plate's latent image (the four-number rule) as Castoro
  Titling glyph outlines. `uv-print.svg`: microprint of the site's own fine print.
  Both are masks revealed only under the pointer's UV lamp.

Generators: `site_assets.py`, `compact_svg.py`, `print_run_assets.py` and
`uv_text_assets.py` in the brand working folder.

## Fonts

`../fonts/` holds Castoro, Castoro Titling, Schibsted Grotesk and Spline Sans
Mono from github.com/google/fonts, subset to Latin with their weight axes kept
and converted to WOFF2. All four are under the SIL Open Font License 1.1; the
licences are in `../fonts/OFL.txt`.
