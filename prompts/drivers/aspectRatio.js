/**
 * Drivers — Aspect Ratio (Single Image and Batch from Sheets).
 *
 * Gemini only produces the picture here: the frame, logo, card and copy are
 * composed afterwards by server/services/aspectRatioTemplate.js, so none of
 * these prompts may ask the model to draw them.
 *
 * Drivers sources differ from Riders ones: the copy sits on a WHITE card beside
 * the picture, not on a purple card over it; the headline has two colours; the
 * wordmark lives inside that card; the picture is a rounded panel on a purple
 * ground, often an illustration, and carries a steering-wheel badge.
 */

/**
 * First call per source image. Its answer is parsed against
 * CARD_COPY_EXTRACTION_SCHEMA in server/services/imageGenerator.js, so every
 * field named below must still exist there.
 */
export const CARD_COPY_EXTRACTION_PROMPT = `
The image is the source creative.

It is a Cabify Drivers creative: a white rounded copy card and a separate rounded image panel (a photograph or a flat illustration) side by side on a flat purple ground. Either panel can be on the left. The copy card holds the purple "cabify" wordmark at the top, a headline set in two colours (a purple lead-in followed by a near-black continuation) and, sometimes, a purple CTA button.

Read that copy card and extract the literal copy.

Return JSON with exactly these fields:
- "cardText": every headline word inside the copy card, in reading order, joining the purple lead-in and the near-black continuation into one text. Preserve punctuation, accents, capitalization, quotation marks and separators exactly. Join visual line wrapping with a single space: line breaks caused by the card's width are NOT content, and neither is the colour change between the two parts. Use "\\n" only for genuinely separate paragraphs or text blocks. Never include the "cabify" wordmark or the CTA label.
- "buttonPresent": true if the copy card includes a CTA button, otherwise false.
- "buttonLabel": the CTA button text exactly as shown. Return an empty string if there is no button.
- "cardBackgroundColor": the hex colour of the copy card itself (usually white), sampled from a flat area away from its edges. Never the purple ground around the card.
- "cardTextColor": the hex colour of the headline's near-black continuation. If the whole headline is a single colour, that colour.
- "cardBrandMarks": any partner, product or sub-brand logo shown inside the copy card - name it and describe its container briefly. Do NOT list the "cabify" wordmark, and do NOT list the steering-wheel badge on the image panel. Empty string if there is none.
- "cardTextBox": the bounding box that tightly encloses the HEADLINE only, both colours included, as [ymin, xmin, ymax, xmax] normalised to 0-1000 over the whole image. Wrap the text itself, not the card's empty margins. Exclude the wordmark above it and the CTA button below it.
- "cardExtrasBox": the bounding box enclosing everything else INSIDE the copy card except the wordmark - the CTA button, option pills and their icons, promo codes, partner logos - as [ymin, xmin, ymax, xmax] over the same 0-1000 grid. Include all of them in one box. Return [0, 0, 0, 0] when the card holds nothing but the wordmark and its headline. Never include the headline, the wordmark, the card's empty margins or anything on the image panel, such as the steering-wheel badge.
- "buttonFontWeight": the CTA label's weight: "Light", "Book", "SemiBold", "Bold", "ExtraBold" or "Black". Empty string if there is no button or you cannot tell.
- "cardTextAccent": the exact words of "cardText" that are set in PURPLE, copied character for character from "cardText" (usually its opening words, e.g. "En Neuquén,"). Empty string if the whole headline is a single colour.

Rules:
- Extract text only from the copy card. Ignore the image panel and its badge, the people, cars and illustrations, and the purple ground.
- Do NOT translate, rewrite, summarize, normalize, fix spelling, or infer missing words.
- Do NOT borrow copy from any other image.
- If a word is partially obscured, return the visible characters only.
- Return JSON only.
`.trim();

// Blocks shared by both ratios below.

const BACKGROUND_ONLY_GENERATION = `
## BACKGROUND-ONLY GENERATION - CRITICAL
- Return only the picture from the source's image panel, rebuilt edge to edge. A deterministic compositor adds the template frame, logo, text box and OTF-rendered text after this model call.
- The source is a two-panel Cabify Drivers layout: a white copy card and a rounded image panel side by side on a flat purple ground. ONLY the image panel is scene content. The purple ground, the white copy card with its wordmark, headline and CTA, the gap between the panels and the image panel's rounded corners are layout, not scene: discard all of them.
- Build the full canvas by continuing the image panel's own content beyond its edges. Nothing from the purple ground or the white card may survive: no purple margins, no white areas, no rounded panel edge, no split-screen.
- Remove the white rounded badge with the purple steering-wheel icon from the image panel, together with any other logo, wordmark, badge, promo code or text overlay. Rebuild the pixels behind them as a plausible continuation of the same scene.
- Do NOT draw a replacement frame, logo, card, placeholder, solid-colour band or split-screen layout. Do not leave an empty area reserved for them; the picture must continue edge to edge.
- Preserve the main subject and the source scene. Do NOT add filters, blur, gradients or colour shifts.
`.trim();

const CONTENT_LOCK = `
## CONTENT LOCK - THE SOURCE IS THE ONLY TRUTH
- The output must contain ONLY what already exists in the source image panel. Do NOT add any object, vehicle, person, animal, building, or prop that is not visible in it.
- If the source has no vehicle, the output has no vehicle. If the source is an interior, it stays an interior.
- Do NOT change the subject's identity, face, pose, clothing, hair, or skin tone.
- Do NOT change the setting, time of day, weather, or colour palette of the scene.
- Any extended background must be a plausible continuation of the SAME scene: same materials, same lighting direction, same depth of field. Never a new environment.
- Do NOT add a CTA, button, promo code, coupon, badge or any other element the source does not already contain.
- The subject is a Cabify driver. A driver at the wheel stays in the driver's seat, hands where the source has them on the steering wheel and seatbelt fastened across the chest. Never move them to a passenger seat, never add passengers, never remove the steering wheel or the seatbelt.
- A car beside a standing driver keeps its model and colour. Never add a taxi sign, roof light or livery.
`.trim();

const FLAT_ILLUSTRATION_PANELS = `
## FLAT ILLUSTRATION PANELS
- Some image panels are flat vector illustrations instead of photographs. An illustration stays an illustration: same flat style, same palette, same shapes. Never turn it into a photograph, a 3D render or a textured painting.
- The pastel shape behind the illustration (for example a mint rectangle or a pink arch) is its background. Extend it as one flat colour to every canvas edge; do not draw its outline and do not bring back the purple ground around it.
- Parts of the illustration that break out of that shape - a hand, an arm, a figure - belong to the subject. Keep them whole.
- The approved illustration palette includes orange skin tones and orange hands. Keep them exactly; they are not a colour error.
`.trim();

const IMMUTABLE_TEMPLATE_LAYERS = `
## IMMUTABLE TEMPLATE LAYERS
- This model call owns ONLY the picture.
- The server, not the model, adds the reference template's frame, logo and text box at exact pixel coordinates.
- Do not imitate, reserve space for, redraw or include any of those layers in this output.
- The server also renders the approved copy with a real Cabify OTF. Return no text of any kind.
`.trim();

/**
 * One background prompt per ratio. The three variations of a ratio share this
 * single picture and differ only by template.
 */
export const SCENE_PROMPTS = {
  '1:1': `
**TASK:** Rebuild the source's image panel as a 1:1 square canvas - scene only, no UI card.

${BACKGROUND_ONLY_GENERATION}

${CONTENT_LOCK}

${FLAT_ILLUSTRATION_PANELS}

${IMMUTABLE_TEMPLATE_LAYERS}

## LAYOUT
- Canvas: 1:1 square.
## TEMPLATE APERTURE - 1:1
- Generate a continuous square picture all the way to every canvas edge.
- Do NOT render the rounded photo aperture, outer frame, local logo notch, logo or text box. The server applies those immutable pixels from the 1:1 reference template afterward.
- Logo: do NOT render one. The deterministic target template adds the locked logo later at its exact pixel size and position.
- Subject: prominent. A person keeps their full face visible; a driver at the wheel keeps the steering wheel and their hands in frame.
- Bottom portion: clean scene/background only (a UI card will be added later by the system).

## GEOMETRY
- The source image panel is already close to square. Reach 1:1 by EXTENDING its shorter side, not by cropping into the subject.
- Do NOT crop the subject's face, hands or the steering wheel.
`.trim(),

  '9:16': `
**TASK:** Rebuild the source's image panel as a 9:16 vertical canvas - scene only, no UI card.

${BACKGROUND_ONLY_GENERATION}

${CONTENT_LOCK}

${FLAT_ILLUSTRATION_PANELS}

${IMMUTABLE_TEMPLATE_LAYERS}

## LAYOUT
- Canvas: 9:16 vertical.
## TEMPLATE APERTURE - 9:16
- Generate a continuous vertical picture all the way to every canvas edge.
- Do NOT render a frame, logo, logo tab or text box. The server applies the immutable 9:16 reference template afterward.
- Logo: do NOT render one. The deterministic target template adds the locked logo later at its exact pixel size and position.
## 9:16 SUBJECT COMPOSITION - NON-NEGOTIABLE
- Reframe horizontally so the primary person's face and upper torso are centred around x=50% and remain inside the central x=42%-58% band. The person must read as centred, not pressed against either side.
- When an arm, phone, steering wheel or other object extends sideways, centre the person's face and torso rather than the combined silhouette. The extended hand or object may remain off-centre.
- If there is no person, centre the main subject (for example an illustrated hand) the same way.
- Add or extend the same background on the side that needs room to achieve this balance. Horizontal translation/reframing of the complete unchanged subject is required when needed and is not a subject redesign.
- Preserve the person's exact identity, pose, anatomy, clothing, scale and detail. Do not mirror, redraw, warp or crop the person.
- Bottom portion: clean scene/background only (a UI card will be added later by the system).

## GEOMETRY
- Reach 9:16 by EXTENDING (outpainting) the image panel itself above and/or below the subject. The source panel is close to square, so most of the vertical canvas is new: continue the car interior (roof lining above; dashboard, steering wheel and seat below), the street and buildings, or the illustration's flat background.
- The picture continues behind the future template overlays. Do NOT reserve empty ground above or below it and do not draw a frame, logo or card placeholder.
- Do NOT rescale or re-shoot the subject to make it fit. The subject keeps its original scale and detail; the picture grows around it, and the subject should still occupy roughly 45-60% of the canvas height.
- Do NOT crop the subject's face.
`.trim(),
};
