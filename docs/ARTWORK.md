# Paperdash artwork

The community banner is original artwork generated with the built-in image-generation tool on October 9, 2026. The production asset is `apps/web/public/art/community-manga.webp`, encoded at 1,400 pixels wide for a fast initial page load. Source output remains in the local Codex generated-images directory; the website depends only on its tracked production asset.

## Generation prompt

Use case: illustration-story. Asset type: original editorial banner artwork for a manga-inspired public trading community dashboard called Paperdash. Create a beautifully composed, hand-inked manga illustration, wide landscape about 2:1. One original adult anime woman with short tousled dark hair and over-ear headphones, relaxed and curious, sitting at a rooftop desk overlooking a dense Japanese-inspired city, a few loose paper sheets and a small folded paper crane beside her. She is on the right half, viewed in three-quarter profile, looking toward the skyline; the left has airy negative space with distant buildings, clouds and a thin diagonal architectural line. Restrained expressive pen strokes, authentic black ink hatching and sparse halftone screentone on warm ivory paper, only subtle pale lavender accents in the sky and headphones. Premium independent manga magazine, artistic and calm with a playful spark. Strong composition, tactile analog linework, no shiny 3D, no photorealism, no UI, no charts, no logos, absolutely no letters, words or watermarks. Keep fine details crisp and the overall silhouette readable when cropped to a short horizontal banner.

## Display

The artwork is decorative context for the community, never a depiction of a real wallet owner. Financial content remains live HTML, with no values baked into the image. The original banner is retained as a source asset. The active decorative cutout has an empty alternative so it does not interrupt screen-reader navigation, and neither image uses continuous animation.

## Divider character

The current interface uses `apps/web/public/art/observer-cutout.webp` (640 × 662, about 120 KB, preserved alpha), created with the built-in image-generation tool using the original banner as its edit target. The character rests on the first data divider; narrative banner copy and the scenery were removed at the user’s request.

### Final edit prompt

Use case: background-extraction. Edit target: the attached original manga illustration. Create a clean transparent cutout of ONLY the same adult woman wearing lavender over-ear headphones, preserving her face, short black wavy hair, head angle looking left, expression, tank top, loose cardigan, hands, and elegant fine ink/halftone art style. Keep her existing pose: chin resting on her right hand, that elbow resting on a surface, her other forearm and relaxed hand lying horizontally on the same surface. Remove the entire city, sky, table, mug, stationery, cat, plants, objects, buildings and all background; do not draw a replacement surface or any floor/shadow. Her resting forearm and elbow should align on one horizontal baseline at the very bottom of the cutout so a website can place her directly on its horizontal divider line as if it is her desk. Crop below that resting baseline; don't show lower body. The whole head/hair and both arms/hands must fit, no clipped hair. Tight comfortable framing around upper body, centered in a roughly square canvas with minimal transparent padding. Preserve warm cream skin/clothing fill and the restrained lavender headphones. All space outside the woman and spaces between her arms/body are genuinely transparent alpha. No text, no frame, no border, no background rectangle.
