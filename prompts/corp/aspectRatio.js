/**
 * Corp — Aspect Ratio (Single Image and Batch from Sheets).
 *
 * Gemini only produces the photograph here: the frame, logo, card and copy are
 * composed afterwards by server/services/aspectRatioTemplate.js, so none of
 * these prompts may ask the model to draw them.
 */

/**
 * First call per source image. Its answer is parsed against
 * CARD_COPY_EXTRACTION_SCHEMA in server/services/imageGenerator.js, so every
 * field named below must still exist there.
 */
export const CARD_COPY_EXTRACTION_PROMPT = `
The image is the source creative.

Read its promotional card and extract the literal copy.

Return JSON with exactly these fields:
- "cardText": every non-button word that appears inside the promotional card, in reading order. Preserve punctuation, accents, capitalization, and separators exactly. Join visual line wrapping with a single space: line breaks caused by the source card's narrow width are NOT content. Use "\\n" only for genuinely separate paragraphs or text blocks.
- "buttonPresent": true if the card includes a CTA/button, otherwise false.
- "buttonLabel": the CTA/button text exactly as shown. Return an empty string if there is no button.
- "cardBackgroundColor": the hex colour of the card/panel the copy sits on, sampled from a flat area away from any shadow or gradient.
- "cardTextColor": the hex colour of that copy.
- "cardBrandMarks": any partner, product or sub-brand logo shown inside the card - name it and describe its container briefly. Do NOT list the main Cabify wordmark. Empty string if there is none.
- "cardTextBox": the bounding box that tightly encloses the card's HEADLINE text only, as [ymin, xmin, ymax, xmax] normalised to 0-1000 over the whole image. Wrap the text itself, not the card panel's empty margins. Exclude buttons, pills, icons and partner logos.
- "cardExtrasBox": the bounding box enclosing everything else INSIDE the card - CTA buttons, option pills and their icons, promo codes, partner logos - as [ymin, xmin, ymax, xmax] over the same 0-1000 grid. Include all of them in one box. Return [0, 0, 0, 0] when the card holds nothing but its headline. Never include the headline, the card's empty margins, the Cabify wordmark or anything outside the card.
- "buttonFontWeight": the CTA label's weight: "Light", "Book", "SemiBold", "Bold", "ExtraBold" or "Black". Empty string if there is no button or you cannot tell.

Rules:
- Extract text only from the card. Ignore the rest of the scene, logo, people, cars, and background.
- Do NOT translate, rewrite, summarize, normalize, fix spelling, or infer missing words.
- Do NOT borrow copy from any other image.
- If a word is partially obscured, return the visible characters only.
- Return JSON only.
`.trim();

// Blocks shared by both ratios below.

const BACKGROUND_ONLY_GENERATION = `
## BACKGROUND-ONLY GENERATION - CRITICAL
- Return only the photograph/background. A deterministic compositor adds the template frame, logo, text box and OTF-rendered text after this model call.
- Remove the COMPLETE promotional copy card/panel from the source: headline, CTA, partner mark, coloured panel, shadow and every reserved area belonging to it. Reclaim its footprint with a natural continuation of the same photograph/background.
- Remove every logo, wordmark, logo tab, frame, border, badge, promo code and text overlay from the source. Rebuild the pixels behind them as a plausible continuation of the same scene.
- Do NOT draw a replacement frame, logo, card, placeholder, solid-colour band or split-screen layout. Do not leave an empty area reserved for them; the photograph/background must continue edge to edge.
- Preserve the main subject and the source scene. Do NOT add filters, blur, gradients or colour shifts.
`.trim();

const CONTENT_LOCK = `
## CONTENT LOCK - THE SOURCE IS THE ONLY TRUTH
- The output must contain ONLY what already exists in the source image. Do NOT add any object, vehicle, person, animal, building, or prop that is not visible in the source.
- If the source has no vehicle, the output has no vehicle. If the source is an interior, it stays an interior.
- Do NOT change the subject's identity, face, pose, clothing, hair, or skin tone.
- Do NOT change the setting, time of day, weather, or colour palette of the scene.
- Any extended background must be a plausible continuation of the SAME scene: same materials, same lighting direction, same depth of field. Never a new environment.
- Do NOT add a CTA, button, promo code, coupon, badge or any other element the source does not already contain. If the source card has no promo code, the output has no promo code.
`.trim();

const IMMUTABLE_TEMPLATE_LAYERS = `
## IMMUTABLE TEMPLATE LAYERS
- This model call owns ONLY the photograph/background.
- The server, not the model, adds the reference template's frame, logo and text box at exact pixel coordinates.
- Do not imitate, reserve space for, redraw or include any of those layers in this output.
- The server also renders the approved copy with a real Cabify OTF. Return no text of any kind.
`.trim();

/**
 * One background prompt per ratio. The three variations of a ratio share this
 * single photograph and differ only by template.
 */
export const SCENE_PROMPTS = {
  '1:1': `
**TASK:** Reframe the source image to a 1:1 square canvas - scene only, no UI card.

${BACKGROUND_ONLY_GENERATION}

${CONTENT_LOCK}

${IMMUTABLE_TEMPLATE_LAYERS}

## LAYOUT
- Canvas: 1:1 square.
## TEMPLATE APERTURE - 1:1
- Generate a continuous square photograph/background all the way to every canvas edge.
- Do NOT render the rounded photo aperture, outer frame, local logo notch, logo or text box. The server applies those immutable pixels from the 1:1 reference template afterward.
- Logo: do NOT render one. The deterministic target template adds the locked logo later at its exact pixel size and position.
- Subject: prominent, full face visible.
- Bottom portion: clean scene/background only (a UI card will be added later by the system).

## GEOMETRY
- CROP or EXTEND the background only as needed to reach 1:1.
- Do NOT crop the subject face.
`.trim(),

  '9:16': `
**TASK:** Reframe the source image to a 9:16 vertical canvas - scene only, no UI card.

${BACKGROUND_ONLY_GENERATION}

${CONTENT_LOCK}

${IMMUTABLE_TEMPLATE_LAYERS}

## LAYOUT
- Canvas: 9:16 vertical.
## TEMPLATE APERTURE - 9:16
- Generate a continuous vertical photograph/background all the way to every canvas edge.
- Do NOT render a frame, logo, logo tab or text box. The server applies the immutable 9:16 reference template afterward.
- Logo: do NOT render one. The deterministic target template adds the locked logo later at its exact pixel size and position.
## 9:16 SUBJECT COMPOSITION - NON-NEGOTIABLE
- Reframe horizontally so the primary person's face and upper torso are centred around x=50% and remain inside the central x=42%-58% band. The person must read as centred, not pressed against either side.
- When an arm, phone or other held object extends sideways, centre the person's face and torso rather than the combined silhouette. The extended hand or object may remain off-centre.
- Add or extend the same background on the side that needs room to achieve this balance. Horizontal translation/reframing of the complete unchanged subject is required when needed and is not a subject redesign.
- Preserve the person's exact identity, pose, anatomy, clothing, scale and photographic detail. Do not mirror, redraw, warp or crop the person.
- Bottom portion: clean scene/background only (a UI card will be added later by the system).

## GEOMETRY
- Reach 9:16 by EXTENDING (outpainting) the PHOTOGRAPH itself above and/or below the subject. Return a continuous edge-to-edge background; never grow a source margin, flat ground or split-panel proportion.
- The photograph continues behind the future template overlays. Do NOT reserve empty ground above or below it and do not draw a frame, logo or card placeholder.
- Do NOT rescale or re-shoot the subject to make it fit. The subject keeps its original scale and detail; the photograph grows around it, and the subject should still occupy roughly 45-60% of the canvas height.
- Do NOT crop the subject's face.
`.trim(),
};
