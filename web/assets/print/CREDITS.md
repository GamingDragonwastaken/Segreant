# Security-print assets for the website

Every image here ships as an alpha mask (black pixels whose opacity is the ink)
and is painted in a theme colour by CSS or by the plate shader, so one file
prints bottle green on the light stock and gold on the dark one. No file
carries its own colour.

## The griffin

- `plate-griffin.webp` (1800 px) and `plate-griffin-900.webp` are an intaglio
  engraving of the Segreant griffin, generated with OpenAI's image generation
  through the Codex CLI on 2026-10-06 from a brief written for this site, with
  the traced mark (`../brand/mark-plain-512.png`) as the reference. The alpha
  channel is the line work (ink density = 1 − luminance, paper clipped to
  zero); the colour channels carry the creature's silhouette, which the dark
  theme uses to give the gold lines a faint body.
- `plate-griffin-body-900.webp` is that silhouette on its own, for the bill.
- `mark-ink.svg` is `../brand/mark-plain.svg` without its background square.

## The bill

`note-frame.webp` is an empty banknote frame (border, oval window, value panel,
corner cartouches, foil strip), generated with the same tool on 2026-10-06 from
a brief that excluded all text, numerals and portraits. Every word and figure on
the bill is live HTML set inside the frame's measured panels; the griffin in the
oval is the plate above.

## Vignettes

`vignette-ledger.webp`, `vignette-gate.webp` and `vignette-workshop.webp` are
banknote-style vignettes generated with ChatGPT image generation on 2026-09-30,
converted to ink masks and resized to 960 px. A faux signature in the gate
vignette was removed by hand. They print as the reverse of the note.

## Paper, fibres and edges

- `paper-uv.webp` (dark) and `paper-light.webp` (light) are paper-stock textures
  generated with ChatGPT image generation on 2026-09-30, made tileable with a
  half-offset cross-blend.
- `uv-fibres.webp`: fluorescent security fibres, drawn as seeded random curves.
- `tear.svg` / `tear-core.svg`: the hero sheet's torn edge (midpoint-displacement
  tear with fibre jitter) and the lighter core that shows where paper tears.
- `guilloche-border.svg`: a rope border of phase-shifted sine strands.

The generators (Python) live in the project's private studio folder; their
outputs are the files here.
