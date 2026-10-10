# paperclub artwork

The community banner is original artwork generated with the built-in image-generation tool on October 9, 2026. The production asset is `apps/web/public/art/community-manga.webp`, encoded at 1,400 pixels wide for a fast initial page load. Source output remains in the local Codex generated-images directory; the website depends only on its tracked production asset.

## Generation prompt

Use case: illustration-story. Asset type: original editorial banner artwork for a manga-inspired public trading community dashboard called Paperdash. Create a beautifully composed, hand-inked manga illustration, wide landscape about 2:1. One original adult anime woman with short tousled dark hair and over-ear headphones, relaxed and curious, sitting at a rooftop desk overlooking a dense Japanese-inspired city, a few loose paper sheets and a small folded paper crane beside her. She is on the right half, viewed in three-quarter profile, looking toward the skyline; the left has airy negative space with distant buildings, clouds and a thin diagonal architectural line. Restrained expressive pen strokes, authentic black ink hatching and sparse halftone screentone on warm ivory paper, only subtle pale lavender accents in the sky and headphones. Premium independent manga magazine, artistic and calm with a playful spark. Strong composition, tactile analog linework, no shiny 3D, no photorealism, no UI, no charts, no logos, absolutely no letters, words or watermarks. Keep fine details crisp and the overall silhouette readable when cropped to a short horizontal banner.

## Display

The artwork is decorative context for the community, never a depiction of a real wallet owner. Financial content remains live HTML, with no values baked into the image. The original banner is retained as a source asset. The decorative cutout used an empty alternative so it did not interrupt screen-reader navigation. Neither retained image is currently rendered by the interface.

## Divider character

An earlier interface iteration used `apps/web/public/art/observer-cutout.webp` (640 × 662, about 120 KB, preserved alpha), created with the built-in image-generation tool using the original banner as its edit target. That iteration placed the character on the first data divider. The current interface leads with TVL and wallet metrics and does not render the character; the asset is retained for future use.

### Final edit prompt

Use case: background-extraction. Edit target: the attached original manga illustration. Create a clean transparent cutout of ONLY the same adult woman wearing lavender over-ear headphones, preserving her face, short black wavy hair, head angle looking left, expression, tank top, loose cardigan, hands, and elegant fine ink/halftone art style. Keep her existing pose: chin resting on her right hand, that elbow resting on a surface, her other forearm and relaxed hand lying horizontally on the same surface. Remove the entire city, sky, table, mug, stationery, cat, plants, objects, buildings and all background; do not draw a replacement surface or any floor/shadow. Her resting forearm and elbow should align on one horizontal baseline at the very bottom of the cutout so a website can place her directly on its horizontal divider line as if it is her desk. Crop below that resting baseline; don't show lower body. The whole head/hair and both arms/hands must fit, no clipped hair. Tight comfortable framing around upper body, centered in a roughly square canvas with minimal transparent padding. Preserve warm cream skin/clothing fill and the restrained lavender headphones. All space outside the woman and spaces between her arms/body are genuinely transparent alpha. No text, no frame, no border, no background rectangle.

## Browser identity and link previews

Browser and saved-link icons use an origami crane in lavender on an ink tile. The angular wing, bent neck and broad folded facets keep the silhouette legible at small sizes. The canonical icon source is `apps/web/public/favicon.svg`, with the same crane geometry as the header and empty-state marks. Run `node scripts/generate-icons.mjs` to regenerate PNG/ICO variants with the installed Playwright Chromium. Explicit icon URLs are versioned to refresh older cached marks.

The character remains in the larger shared-link preview, while the dashboard itself stays compact. That illustration was edited with the built-in image-generation tool using the existing original illustration and cutout, then encoded as a 1200 × 630 JPEG. The earlier portrait is retained as source artwork and is no longer used as an icon.

- `apps/web/public/art/observer-avatar.webp`: retained 512px portrait master.
- `apps/web/public/favicon-16.png`, `favicon-32.png`, `favicon-192.png`, and `favicon.ico`: browser icons.
- `apps/web/public/apple-touch-icon.png`: 180px icon for saved home-screen links.
- `apps/web/public/art/paperclub-social-v1.jpg`: current shared-link preview artwork, 1200 × 630 JPEG.
- `apps/web/public/art/paperdash-social.jpg`: retained earlier preview so cached image links remain valid.

### Portrait edit prompt

Use case: identity-preserve. Edit target: attached original adult manga woman. Asset: square browser favicon and app icon for Paperdash. Create a simplified portrait of this SAME woman suitable for a tiny 16 or 32 pixel browser tab icon: short wavy black bob, face looking to the left in three-quarter profile, the same distinctive lavender over-ear headphones and headband, ivory face, calm thoughtful expression. Tightly frame only her head and upper neck, no arms or torso. Keep the face and large lavender earcup immediately recognizable. Reduce the fine hatching into a few bold clean black ink shapes, substantial outlines, and very sparse halftone. Center and fill most of a warm ivory rounded-square tile with the head; leave a narrow safe margin so no headphones or hair are clipped. Square icon, no text, no letters, no symbols, no border, no shadows. Tile background #f5f2e9 with generously rounded corners; pixels outside the rounded-square tile are transparent. Maintain the original character identity, ink manga style and restrained black/cream/lavender palette.

### Shared-link edit prompt

Use case: compositing. Edit target: attached original manga illustration. Asset: polished social sharing / Open Graph link preview for the Paperdash website, wide landscape 1200 by 630 layout (1.91:1). Preserve the original adult woman at her desk on the RIGHT half: same face, short dark hair, lavender headphones, chin resting on hand, delicate expressive manga penwork, paper crane and subtle city scene behind her. On the LEFT half create generous clean warm ivory #f5f2e9 negative space for crisp typography; let faint city linework remain only at the very bottom left. Put exactly two text lines in the clean left space: large bold lowercase geometric sans-serif 'paperdash.' and underneath much smaller regular sans-serif 'Papertrade analytics'. Dark charcoal #252922 lettering. Give the large brand name the strongest hierarchy and comfortable left margin around 70 pixels at 1200px width. The woman is a supporting brand illustration, her entire head fits inside the top/right margins. Overall premium ink manga editorial identity, cream paper, black ink, very restrained lavender. No extra slogan or narrative copy, no fake statistics, no other text, no UI, no device mockup, no outer frame, no watermark. This is the actual flat image asset, not a screenshot of a browser card.

### paperclub wordmark update — October 10, 2026

Edited the existing shared-link preview with the built-in image-generation tool, then encoded it as a 1200 × 630 JPEG. The new filename lets social crawlers fetch the updated artwork without reusing the earlier image URL. Final prompt:

Use case: text-localization.

Asset type: website Open Graph and social link preview, wide landscape 1200 by 630 pixels.

Input image: the provided paperdash-social.jpg is the edit target.

Primary request: Replace ONLY the large top-left wordmark "paperdash." with exactly "paperclub." in the same bold lowercase geometric sans-serif style, ink color, scale and left alignment. Keep the smaller subtitle exactly "Papertrade analytics".

Constraints: Preserve the original composition, illustration, face, adult woman with short dark hair and lavender headphones, her seated pose, desk, paper crane, sleeping cat, hanging plants, city skyline, mountain, manga linework, warm ivory paper background and lavender accents. Preserve all existing illustrated details and placement as closely as possible. Do not add anything or crop the scene. Only the wordmark changes. Output opaque wide landscape 1200x630.
