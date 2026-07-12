# Design Direction — the full rebrand & overhaul

Status: **awaiting two user inputs** — (1) name pick, (2) generated image assets from the
prompts in §5. Everything else here is ready to execute.

---

## 1. The name

Requirement: shorter, historical, influential, "big bang" energy. All checked free on npm
(2026-07-11).

| Name | Story | Why it hits |
|---|---|---|
| **Fiscus** ⭐ | The Roman emperor's personal treasury. Latin *fiscus* = the rush **basket** money was carried in. It is literally the root of the word "fiscal". | 6 letters, pronounceable in every language, exactly on-domain (AI-spend governance = fiscal control), and nobody in dev tooling has it. "The fiscus for your AI spend." |
| **Exchequer** | The medieval English treasury — audited the kingdom's money on a checkered cloth and issued **split tally sticks as receipts** (our signed Value Receipts are the same idea, 800 years later). | Iconic word, deep story tie-in to the receipts feature. Longer (9 letters). |
| **Sesterce** | The Roman coin of daily accounting — ledgers were kept in sesterces. | Beautiful word, coin = unit of spend. Slightly obscure to pronounce. |
| Aerarium | Rome's *state* treasury (vs the emperor's fiscus). | Great story, but 8 letters and harder to say. |
| Drachm / Denar | Greek/Balkan coin names. | Short, clean, less story. |

**Recommendation: Fiscus.** The basket etymology also gives the mascot a wink: the griffin
guards the basket.

## 2. The mascot — a griffin

Herodotus wrote that **griffins guard hoards of gold**. That is this product: a mythological
guardian watching the gold (your AI spend). A mascot gives the brand a face no competitor
has (Linear/Vercel/Stripe are all faceless), and it animates naturally: idle blink, wing
ruffle on hover, pounce when a budget cap blocks a request, sleeping when spend is $0.

Tone: not cute-corporate, not grimdark — a **woodcut-meets-modern** creature: sharp,
heraldic, a little intimidating, secretly friendly.

## 3. Visual direction — "Night Vault"

Recycled from the proven patterns (Linear's cinematic dark + Stripe's living gradient +
fintech scroll-morph), not invented:

- **Base**: deep indigo-black night (#0B0D14 → #11142033 panels), silver-fog text (#C7CBD6),
  hairline borders (#1E2230).
- **Accent**: **molten gold** (#E8B33C) reserved exclusively for *value/return* — the gold the
  griffin guards. Spend/neutral data in cool silver; alerts in signal red (#E25D4A); pass in
  sage (#63C593). One accent used sparingly = premium.
- **Type**: display in the system serif stack (Fraunces/Iowan/Palatino fallbacks — no external
  fonts, CSP stays clean); numerals in ui-monospace; UI in system-ui.
- **Texture**: generated hero plates (§5) + a 2% CSS grain overlay so the dark never reads flat.

## 4. Motion plan (all self-contained, zero external requests)

1. **Hero gradient drift** — CSS-only slow hue/position drift on the hero plate (Stripe
   pattern), `prefers-reduced-motion` respected everywhere.
2. **Cursor spotlight** — a soft radial glow that follows the pointer over the hero and cards
   (the "cursor-top animation"); pure JS + one absolutely-positioned div.
3. **Scroll reveals** — IntersectionObserver staggered fade/rise for sections and stat cards
   (Linear pattern).
4. **Living numerals** — dashboard money counts tween to new values; landing hero counts up
   on first view.
5. **Griffin states** — layered PNG/SVG parts (body/head/wings exported separately, §5) so CSS
   transforms animate blink/ruffle/pounce without a sprite engine or Lottie.
6. **Section parallax** — translateY at 0.9× scroll on hero art only; subtle, not a theme park.

## 5. Asset prompts — paste into ChatGPT image generation

Keep the STYLE LOCK line identical across prompts so assets match. Request PNG,
transparent background where noted.

**STYLE LOCK (prepend to every prompt):**
> Style: modern heraldic woodcut-engraving hybrid; confident single-weight linework;
> deep indigo-black night palette (#0B0D14) with molten-gold accents (#E8B33C) and
> silver-fog details (#C7CBD6); dramatic rim lighting; clean silhouette; no text,
> no watermark.

1. **Logo mark** *(transparent PNG, 2048×2048, also ask for a simplified 64×64-legible pass)*
   > A minimal emblem of a griffin head in profile facing right, formed from a few
   > continuous engraved strokes, encircled by a thin ring like a coin's rim; reads
   > clearly at favicon size; flat vector-like rendering, single gold stroke on
   > transparent background.

2. **Griffin mascot — master pose** *(transparent PNG, 2048×2048)*
   > A regal griffin perched atop a woven roman basket overflowing with gold coins,
   > wings half-raised, tail curled around the basket, gaze alert and forward;
   > three-quarter view; body in deep indigo-black with silver engraved feather
   > linework, coins and eye glints in molten gold.

3. **Griffin — sleeping pose** *(transparent PNG — used when spend is $0 / all clear)*
   > The same griffin curled asleep around the coin basket, wings folded like a
   > blanket, one ear alert; peaceful, softly glowing gold coins beneath its wing.

4. **Griffin — guardian pounce** *(transparent PNG — used on budget-block / critical alert)*
   > The same griffin mid-pounce with wings fully spread and talons extended,
   > protective and fierce, gold light flaring off the wing edges; dynamic diagonal
   > composition.

5. **Hero background plate** *(3840×2160 dark PNG, no transparency)*
   > A vast dark treasury vault interior seen from low angle: faint colossal columns
   > dissolving into indigo darkness, a subtle river of molten-gold light flowing
   > across the polished black floor toward the viewer, atmospheric haze, extremely
   > dark overall — background art that text can sit on; no focal creature.

6. **OG / social banner plate** *(1600×840, room on the left third for a wordmark)*
   > The griffin from prompt 2 small on the right third overlooking a dark horizon
   > with a thin molten-gold dawn line; left two-thirds nearly black and empty for
   > typography.

Ask ChatGPT for **separated layers** on prompt 2 if it can (body / head / front wing) — that
unlocks the CSS part-animation in §4.5. If not, one flat PNG still works with
whole-sprite transforms.

## 6. Execution order (once name + assets land)

1. Rename pass: package name, bin name, repo strings, docs, CLI banner, dashboard title.
2. Token swap in `src/dashboard/web/index.html` (`:root` variables) + logo/mascot slots.
3. Landing page rebuild in `web/index.html`: new hero (plate + cursor spotlight + count-up),
   griffin states wired to demo data, scroll reveals.
4. CLI palette echo (the `C` object in `src/cli/ui.ts`): gold reserved for value lines.
5. README badges/wordmark, npm republish under the new name.
