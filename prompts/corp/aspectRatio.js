/**
 * Corp — Aspect Ratio (Single Image and Batch from Sheets).
 *
 * Gemini only produces the picture here: the frame, logo, card and copy are
 * composed afterwards by server/services/aspectRatioTemplate.js, so none of
 * these prompts may ask the model to draw them.
 *
 * Corp sources put a white copy card beside the picture on a dark navy ground,
 * sign it "cabify para empresas" on that ground, and set the headline in two
 * colours. The passenger is a business traveller working in the back seat.
 */

/**
 * First call per source image. Its answer is parsed against
 * CARD_COPY_EXTRACTION_SCHEMA in server/services/imageGenerator.js, so every
 * field named below must still exist there.
 */
export const CARD_COPY_EXTRACTION_PROMPT = `
The image is the source creative.

It is a Cabify para empresas creative: a white rounded copy card and a separate rounded photo panel side by side on a flat dark navy ground. Either panel can be on the left. The white "cabify para empresas" signature sits on the navy ground above the card, OUTSIDE it. The card holds a headline set in two colours (a purple part followed by a near-black part) and, sometimes, a purple CTA button or a small journey graphic.

Read that copy card and extract the literal copy.

Return JSON with exactly these fields:
- "cardText": every headline word inside the copy card, in reading order, joining the purple and the near-black parts into one text. Preserve punctuation, accents, capitalization and separators exactly. Join visual line wrapping with a single space: line breaks caused by the card's width are NOT content, and neither is the colour change between the two parts. Use "\\n" only for genuinely separate paragraphs or text blocks. Never include the "cabify para empresas" signature, which is not inside the card, and never include the CTA label.
- "buttonPresent": true if the copy card includes a CTA button, otherwise false.
- "buttonLabel": the CTA button text exactly as shown (for example "Más información"). Return an empty string if there is no button.
- "cardBackgroundColor": the hex colour of the copy card itself (usually white), sampled from a flat area away from its edges. Never the navy ground around the card.
- "cardTextColor": the hex colour of the headline's near-black part. If the whole headline is a single colour, that colour.
- "cardBrandMarks": any partner, product or sub-brand logo shown inside the copy card - name it and describe its container briefly. Do NOT list the "cabify para empresas" signature. Empty string if there is none.
- "cardTextBox": the bounding box that tightly encloses the HEADLINE only, both colours included, as [ymin, xmin, ymax, xmax] normalised to 0-1000 over the whole image. Wrap the text itself, not the card's empty margins. Exclude the CTA button and any journey graphic below it.
- "cardExtrasBox": the bounding box enclosing everything else INSIDE the copy card - the CTA button, the journey graphic with its stops and car, option pills, promo codes, partner logos - as [ymin, xmin, ymax, xmax] over the same 0-1000 grid. Include all of them in one box. Return [0, 0, 0, 0] when the card holds nothing but its headline. Never include the headline, the card's empty margins, the signature or anything on the photo panel.
- "buttonFontWeight": the CTA label's weight: "Light", "Book", "SemiBold", "Bold", "ExtraBold" or "Black". Empty string if there is no button or you cannot tell.
- "cardTextAccent": the exact words of "cardText" that are set in PURPLE, copied character for character from "cardText" (usually its opening words, e.g. "Tu empresa ahorra,"). Empty string if the whole headline is a single colour.

Rules:
- Extract text only from the copy card. Ignore the photo panel, the people, the navy ground and the signature on it.
- Do NOT translate, rewrite, summarize, normalize, fix spelling, or infer missing words.
- Do NOT borrow copy from any other image.
- If a word is partially obscured, return the visible characters only.
- Return JSON only.
`.trim();

// Blocks shared by both ratios below.

const BACKGROUND_ONLY_GENERATION = `
## BACKGROUND-ONLY GENERATION - CRITICAL
- Return only the photograph from the source's photo panel, rebuilt edge to edge. A deterministic compositor adds the template frame, logo, text box and OTF-rendered text after this model call.
- The source is a two-panel Cabify para empresas layout: a white copy card and a rounded photo panel side by side on a flat dark navy ground. ONLY the photo panel is scene content. The navy ground, the white copy card with its headline and CTA, the "cabify para empresas" signature, the gap between the panels and the photo panel's rounded corners are layout, not scene: discard all of them.
- Build the full canvas by continuing the photograph's own content beyond its edges. Nothing from the navy ground or the white card may survive: no navy margins, no white areas, no rounded panel edge, no split-screen.
- Remove every logo, wordmark, badge, promo code and text overlay from the photograph. Rebuild the pixels behind them as a plausible continuation of the same scene.
- Do NOT draw a replacement frame, logo, card, placeholder, solid-colour band or split-screen layout. Do not leave an empty area reserved for them; the photograph must continue edge to edge.
- Preserve the main subject and the source scene. Do NOT add filters, blur, gradients or colour shifts.
`.trim();

const CONTENT_LOCK = `
## CONTENT LOCK - THE SOURCE IS THE ONLY TRUTH
- The output must contain ONLY what already exists in the source photo panel. Do NOT add any object, vehicle, person, animal, building, or prop that is not visible in it.
- If the source has no vehicle, the output has no vehicle. If the source is an interior, it stays an interior.
- Do NOT change the subject's identity, face, pose, clothing, hair, or skin tone.
- Do NOT change the setting, time of day, weather, or colour palette of the scene.
- Any extended background must be a plausible continuation of the SAME scene: same materials, same lighting direction, same depth of field. Never a new environment.
- Do NOT add a CTA, button, promo code, coupon, badge or any other element the source does not already contain.
- The subject is a business traveller riding in the back seat. They stay in the back seat with their seatbelt fastened across the chest, and whatever they are working with - laptop, phone, documents - stays exactly as the source has it. Never move them to the driver's seat, never add passengers, never remove the seatbelt.
- The car interior keeps its upholstery, trim and finish. Never add a taxi sign, livery or roof light.
`.trim();

const IMMUTABLE_TEMPLATE_LAYERS = `
## IMMUTABLE TEMPLATE LAYERS
- This model call owns ONLY the photograph.
- The server, not the model, adds the reference template's frame, signature and text box at exact pixel coordinates.
- Do not imitate, reserve space for, redraw or include any of those layers in this output.
- The server also renders the approved copy with a real Cabify OTF. Return no text of any kind.
`.trim();

/**
 * One background prompt per ratio. The three variations of a ratio share this
 * single photograph and differ only by template.
 */
export const SCENE_PROMPTS = {
  '1:1': `
**TASK:** Rebuild the source's photo panel as a 1:1 square canvas - scene only, no UI card.

${BACKGROUND_ONLY_GENERATION}

${CONTENT_LOCK}

${IMMUTABLE_TEMPLATE_LAYERS}

## LAYOUT
- Canvas: 1:1 square.
## TEMPLATE APERTURE - 1:1
- Generate a continuous square photograph all the way to every canvas edge.
- Do NOT render the rounded photo aperture, outer frame, local signature notch, logo or text box. The server applies those immutable pixels from the 1:1 reference template afterward.
- Logo: do NOT render one. The deterministic target template adds the locked "cabify para empresas" signature later at its exact pixel size and position.
- Subject: prominent, full face visible, with the work in their hands still readable as a laptop, phone or document.
- Bottom portion: clean scene/background only (a UI card will be added later by the system).

## GEOMETRY
- The source photo panel is already close to square. Reach 1:1 by EXTENDING its shorter side, not by cropping into the subject.
- Do NOT crop the subject's face or the device they are working on.
`.trim(),

  '9:16': `
**TASK:** Rebuild the source's photo panel as a 9:16 vertical canvas - scene only, no UI card.

${BACKGROUND_ONLY_GENERATION}

${CONTENT_LOCK}

${IMMUTABLE_TEMPLATE_LAYERS}

## LAYOUT
- Canvas: 9:16 vertical.
## TEMPLATE APERTURE - 9:16
- Generate a continuous vertical photograph all the way to every canvas edge.
- Do NOT render a frame, signature, logo tab or text box. The server applies the immutable 9:16 reference template afterward.
- Logo: do NOT render one. The deterministic target template adds the locked "cabify para empresas" signature later at its exact pixel size and position.
## 9:16 SUBJECT COMPOSITION - NON-NEGOTIABLE
- Reframe horizontally so the primary person's face and upper torso are centred around x=50% and remain inside the central x=42%-58% band. The person must read as centred, not pressed against either side.
- When an arm, laptop, phone or other held object extends sideways, centre the person's face and torso rather than the combined silhouette. The extended hand or object may remain off-centre.
- Add or extend the same background on the side that needs room to achieve this balance. Horizontal translation/reframing of the complete unchanged subject is required when needed and is not a subject redesign.
- Preserve the person's exact identity, pose, anatomy, clothing, scale and photographic detail. Do not mirror, redraw, warp or crop the person.
- Bottom portion: clean scene/background only (a UI card will be added later by the system).

## GEOMETRY
- Reach 9:16 by EXTENDING (outpainting) the photograph itself above and/or below the subject. The source panel is close to square, so most of the vertical canvas is new: continue the car interior (roof lining and grab handle above; seat, lap and door trim below) and the street beyond the windows.
- The photograph continues behind the future template overlays. Do NOT reserve empty ground above or below it and do not draw a frame, signature or card placeholder.
- Do NOT rescale or re-shoot the subject to make it fit. The subject keeps its original scale and detail; the photograph grows around it, and the subject should still occupy roughly 45-60% of the canvas height.
- Do NOT crop the subject's face.
`.trim(),
};
