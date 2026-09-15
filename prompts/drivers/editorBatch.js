/**
 * Drivers — Editor Batch.
 *
 * The constraints close every scene prompt; the Nano Editor limitations for the
 * same account are appended after them on the server.
 */
export const EDITOR_BATCH_CONSTRAINTS = `Non-negotiable visual constraints — never violate:
- This is a Cabify Drivers creative: a white rounded copy card and a rounded image panel side by side on a flat purple ground. Only the image panel changes. The purple ground, both panels' sizes, positions and rounded corners, and the copy card with its "cabify" wordmark, headline and CTA button stay exactly as in the source.
- The headline keeps its two colours: the purple lead-in and the near-black continuation. Never merge them into one colour and never move the colour change to another word.
- All text stays inside the white copy card. Never place text, logos or buttons on the image panel. All text must remain fully contained within the card; nothing may overflow or be cropped.
- Keep the white rounded badge with the purple steering-wheel icon in the same corner of the image panel when the source has one. Do not add it when the source does not.
- The subject is a Cabify driver: an Argentinian adult, roughly 30 to 55 years old, who looks like a real, diverse person from Buenos Aires, Córdoba, Neuquén or another Argentine city. No foreigners, no models, no overly styled individuals.
- Women and men are drivers alike. Never cast a woman as the passenger of a man's car.
- Inside the car, the driver sits in the driver's seat of a left-hand-drive car, as in Argentina. Never in a passenger seat or the back seat.
- The seatbelt is always fastened across the driver's chest whenever they are in the car. No exceptions, no creative workarounds.
- While the car is moving, both of the driver's hands stay on the steering wheel. A phone appears only when the car is parked or the driver is standing outside it.
- The driver looks confident, warm and approachable: a genuine smile, often looking at the camera. No serious expressions, no sadness, no melancholy, no neutral blank stares.
- One driver is the protagonist. A passenger may appear only in the back seat, secondary and out of focus.
- Never include taxis in the image. The car is a clean, modern private sedan or hatchback in a neutral colour (white, grey, silver or black). No yellow cabs, no taxi signage, no roof lights, no livery.
- Car doors must open like standard sedan doors (hinged at the front, swinging outward). No sliding doors, no van-style doors, no bus doors.
- The driver and the car are the protagonists. Outside the car, the street or buildings are context and occupy no more than 30% of the image panel.
- The background must always be slightly blurred.
- NOTHING in a photograph may be orange. No orange clothing, no orange cars, no orange backgrounds. Flat illustrations keep their own approved palette, orange skin tones included.
- A flat illustration stays a flat illustration in the same style, and a photograph stays a photograph.
- No photo filters, no color grading effects, no vignettes, no Instagram-style treatments. Raw, natural photographic look only.
- Always use the current Cabify logo — never the old logo.
- Preserve the exact typography, text colors, and font sizes from the reference. Do not alter typeface, weight, color values, or sizing under any circumstances.`;

/**
 * Scenes offered in the Editor Batch selector. `stage` also picks the badge
 * colour in the UI (Entrada, Trayecto, Salida). For Drivers they read as the
 * shift: getting ready, driving, and wrapping up.
 */
export const EDITOR_BATCH_SCENES = [
  {
    id: 1,
    title: "Cabify Mujer al volante",
    stage: "Trayecto",
    scene: "Una conductora de 42 años maneja con las dos manos en el volante y el cinturón abrochado. Gira apenas la cabeza hacia la cámara con una sonrisa cálida y segura. Lleva una camisa de lino verde oliva y aros pequeños.",
    background: "Interior oscuro y prolijo del auto, con los asientos de atrás desenfocados. Luz natural suave que entra por la ventanilla del conductor.",
    designSpace: "Plano medio desde el asiento del acompañante. Encuadre centrado para el panel de imagen casi cuadrado; el texto va en la tarjeta blanca, así que no hace falta dejar aire para titulares. Esquina inferior derecha despejada para el badge del volante.",
  },
  {
    id: 2,
    title: "Toda la ganancia es para vos",
    stage: "Trayecto",
    scene: "Un conductor de 48 años, con barba canosa y chaleco acolchado azul marino sobre una remera beige, maneja con las dos manos en el volante y el cinturón abrochado. Mira a cámara con una sonrisa tranquila de satisfacción.",
    background: "Interior del auto con asientos negros desenfocados y la ventanilla trasera luminosa. Luz de mediodía blanca y limpia.",
    designSpace: "Plano medio desde el asiento del acompañante, rostro en el centro del panel. Esquina inferior derecha despejada para el badge del volante.",
  },
  {
    id: 3,
    title: "Antes de salir a la calle",
    stage: "Entrada",
    scene: "Un hombre de 45 años, con campera gris y remera blanca, está de pie apoyado en su auto blanco estacionado. Sostiene el celular con una mano después de abrir la app y mira hacia la calle con expresión serena y optimista.",
    background: "Edificios de oficinas vidriados desenfocados detrás. Luz de mañana nublada, pareja y sin sombras duras.",
    designSpace: "Plano medio-largo. El conductor ocupa el centro y el capó del auto asoma abajo. Esquina superior izquierda despejada para el badge del volante.",
  },
  {
    id: 4,
    title: "Lista para arrancar",
    stage: "Entrada",
    scene: "Una conductora de 36 años, sentada al volante con el auto estacionado y el cinturón abrochado, ajusta el espejo retrovisor con una mano mientras sonríe a cámara. La otra mano descansa sobre el volante.",
    background: "A través del parabrisas se ve una calle de barrio arbolada y desenfocada. Luz de mañana temprana, clara y fresca.",
    designSpace: "Plano medio desde el asiento del acompañante. Rostro y volante centrados en el panel casi cuadrado.",
  },
  {
    id: 5,
    title: "Revisando las ganancias",
    stage: "Salida",
    scene: "Un conductor de 39 años, con el auto estacionado y el motor apagado, mira el celular con una sonrisa de satisfacción al ver sus ganancias de la semana. Tiene el cinturón abrochado y el brazo apoyado en el volante.",
    background: "Interior del auto con la ventanilla del conductor enmarcando una avenida desenfocada. Luz de tarde temprana, blanca, no anaranjada.",
    designSpace: "Primer plano lateral. El celular y el rostro quedan en el centro del panel; nada de la pantalla del celular es legible.",
  },
  {
    id: 6,
    title: "Sin auto propio",
    stage: "Entrada",
    scene: "Un hombre de 33 años, con buzo azul, de pie junto a un auto gris recién lavado. Sostiene las llaves en la mano y mira a cámara con una sonrisa entusiasta, listo para su primer día manejando con Cabify.",
    background: "Un estacionamiento amplio y luminoso con otros autos neutros desenfocados en fila.",
    designSpace: "Plano medio. El conductor y la puerta delantera del auto llenan el centro del panel. Esquina superior izquierda despejada para el badge del volante.",
  },
  {
    id: 7,
    title: "Pasajero a bordo",
    stage: "Trayecto",
    scene: "Una conductora de 44 años maneja con las dos manos en el volante y el cinturón abrochado, con una sonrisa amable. En el asiento de atrás, desenfocado, se adivina un pasajero mirando por la ventanilla.",
    background: "A través del parabrisas, una avenida arbolada desenfocada con luz de mediodía.",
    designSpace: "Plano medio desde el asiento del acompañante. La conductora es el foco nítido; el pasajero queda como contexto suave detrás.",
  },
  {
    id: 8,
    title: "Mi ciudad, mi horario",
    stage: "Trayecto",
    scene: "Un conductor de 52 años, con camisa celeste arremangada, maneja relajado con las dos manos en el volante y el cinturón abrochado. Mira de reojo a cámara con una media sonrisa confiada.",
    background: "Por la ventanilla pasa una avenida ancha de una ciudad del interior, con árboles y edificios bajos bajo un cielo despejado, desenfocada.",
    designSpace: "Plano medio lateral. Rostro centrado y volante visible en la parte inferior del panel.",
  },
  {
    id: 9,
    title: "Una pausa con mate",
    stage: "Salida",
    scene: "Un conductor de 37 años hace una pausa de pie junto a su auto negro estacionado. Sostiene un mate en una mano y sonríe a cámara de forma natural, descansado y de buen humor.",
    background: "Una plaza de barrio con árboles y bancos, desenfocada. Luz de media tarde clara.",
    designSpace: "Plano medio. El conductor en el centro del panel y el costado del auto como contexto. Esquina inferior derecha despejada para el badge del volante.",
  },
  {
    id: 10,
    title: "Auto impecable",
    stage: "Entrada",
    scene: "Una conductora de 40 años repasa con un paño de microfibra el espejo lateral de su auto blanco antes de empezar la jornada. Mira a cámara con una sonrisa orgullosa.",
    background: "Una calle residencial tranquila con casas bajas desenfocadas. Luz de mañana limpia.",
    designSpace: "Plano medio corto. Rostro y espejo lateral en el centro del panel.",
  },
  {
    id: 11,
    title: "Fin de jornada",
    stage: "Salida",
    scene: "Un conductor de 50 años cierra la puerta delantera de su auto estacionado frente a su casa. Se da vuelta hacia la cámara con una sonrisa de satisfacción por el día trabajado.",
    background: "Fachada de una casa de barrio con rejas bajas y plantas. Luz de tarde temprana, blanca, no anaranjada.",
    designSpace: "Plano medio-largo. El conductor y la puerta del auto centrados en el panel.",
  },
  {
    id: 12,
    title: "Confianza al volante",
    stage: "Trayecto",
    scene: "Un conductor de 31 años, con camisa blanca, maneja con las dos manos en el volante y el cinturón abrochado. Mira hacia adelante con una expresión relajada y una sonrisa leve.",
    background: "Interior claro del auto con la luz del sol entrando por el parabrisas. Afuera, una calle urbana desenfocada.",
    designSpace: "Plano medio de tres cuartos desde el asiento del acompañante. Rostro y manos en el volante centrados en el panel.",
  },
];
