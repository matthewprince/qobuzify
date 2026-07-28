# eq-boost (non-shipped case study)

Removed from the shipped extension catalog in the 2026-07-27 audit. It was inert everywhere: it bails
off `play.qobuz.com` (so the whole Windows bake), requires an `eq:on` storage flag nothing ever sets,
and its "the web player has no `<audio>` element" premise contradicts the proven MSE-into-element
playback model bitperfect is built on. Net result: a Marketplace toggle that did nothing on any
platform.

Kept here intact (index.js + manifest.json) as reference code for the `AudioNode.connect` patch
technique: rerouting any connection to the destination node through a filter chain, installed before
the player wires its per-play graph. If you want to build a real EQ extension, start from
`docs/writing-extensions.md`, and mind bit-perfect: an EQ is by definition not bit-perfect, and the
wrapper's direct mode plays through mpv, outside the page's audio graph entirely.

Both products build their catalog by scanning `extensions/` (`lib/apply.js`, `wrapper/payload.js`),
so removal from that directory removed it from the bake and the wrapper alike. Nothing else in the
repo references it.
