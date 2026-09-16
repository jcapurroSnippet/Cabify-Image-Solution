/**
 * Corp — Editor Batch.
 *
 * The constraints close every scene prompt; the Nano Editor limitations for the
 * same account are appended after them on the server.
 */
export const EDITOR_BATCH_CONSTRAINTS = `Non-negotiable visual constraints — never violate:
- This is a Cabify para empresas creative: a white rounded copy card and a rounded photo panel side by side on a flat dark navy ground. Only the photo panel changes. The navy ground, both panels' sizes, positions and rounded corners, the "cabify para empresas" signature on the ground and the copy card with its headline and CTA stay exactly as in the source.
- The headline keeps its two colours: the purple part and the near-black part. Never merge them into one colour and never move the colour change to another word.
- All text stays inside the white copy card, except the "cabify para empresas" signature, which stays on the navy ground exactly where it is. Never place text or logos on the photo panel.
- The subject is a business traveller: an Argentinian adult, roughly 28 to 55 years old, who looks like a real, diverse professional from Buenos Aires, Córdoba or another Argentine city. No foreigners, no models, no overly styled individuals.
- Women and men travel for work alike. Never cast a woman as the assistant of a man.
- The traveller rides in the BACK seat. Never in the driver's seat, never driving.
- The seatbelt is always fastened across the traveller's chest. No exceptions, no creative workarounds.
- Work in transit reads as work: a laptop, a phone, a tablet or printed documents, handled naturally. Screens stay unreadable — no legible interfaces, logos or data.
- Dress is business or business casual: blazers, shirts, knitwear, neat tailoring. No ties required, no formalwear, no uniforms, no gym or beach clothes.
- Expressions are calm, focused and confident, with an easy smile where it fits. No exaggerated laughter, no stress, no sadness, no neutral blank stares.
- One traveller is the protagonist. A colleague may share the back seat when the scene is about a team, interacting naturally. The driver is never the subject and appears only from behind, out of focus.
- Never include taxis in the image. The car is a clean, modern private sedan with a premium, uncluttered interior in black, grey or beige. No yellow cabs, no taxi signage, no roof lights, no livery.
- Car doors must open like standard sedan doors (hinged at the front, swinging outward). No sliding doors, no van-style doors, no bus doors.
- The traveller is the protagonist. Outside the car, corporate buildings, glass facades or the street are context and occupy no more than 30% of the photo panel.
- The background must always be slightly blurred.
- NOTHING must be orange. No orange clothing, no orange cars, no orange backgrounds, no orange sunset light.
- No photo filters, no color grading effects, no vignettes, no Instagram-style treatments. Raw, natural photographic look only.
- Always use the current Cabify logo — never the old logo.
- Preserve the exact typography, text colors, and font sizes from the reference. Do not alter typeface, weight, color values, or sizing under any circumstances.`;

/**
 * Scenes offered in the Editor Batch selector. `stage` also picks the badge
 * colour in the UI (Entrada, Trayecto, Salida). For Corp they read as the
 * corporate trip: boarding, travelling and arriving.
 */
export const EDITOR_BATCH_SCENES = [
  {
    id: 1,
    title: "Camino a la reunión",
    stage: "Trayecto",
    scene: "Una ejecutiva de 36 años viaja en el asiento trasero con el cinturón puesto y una notebook abierta sobre las piernas. Revisa la pantalla con expresión concentrada y tranquila. Lleva un blazer claro sobre una camisa blanca.",
    background: "Interior premium del auto con tapizado oscuro. Por la ventanilla se ven edificios de oficinas desenfocados bajo luz de mañana.",
    designSpace: "Plano medio desde el asiento del acompañante. Encuadre centrado para el panel de imagen casi cuadrado; el texto va en la tarjeta blanca, así que no hace falta dejar aire para titulares.",
  },
  {
    id: 2,
    title: "Llamada en viaje",
    stage: "Trayecto",
    scene: "Un hombre de 44 años, con saco azul y camisa sin corbata, habla por teléfono mientras viaja en el asiento trasero con el cinturón puesto. Mira hacia la ventanilla con gesto atento y una sonrisa leve.",
    background: "Interior del auto con luz natural lateral. Afuera, una avenida con edificios corporativos desenfocados.",
    designSpace: "Plano medio lateral. Rostro y teléfono centrados en el panel.",
  },
  {
    id: 3,
    title: "Rumbo al aeropuerto",
    stage: "Entrada",
    scene: "Una mujer de 40 años sube al asiento trasero con un bolso de mano y una valija de cabina que el conductor ya guardó. Se acomoda con una sonrisa serena, lista para salir.",
    background: "La puerta abierta del auto y, detrás, la entrada de un edificio corporativo desenfocada. Luz de mañana temprana, limpia.",
    designSpace: "Plano medio corto desde afuera del auto. La puerta enmarca a la protagonista en el centro del panel.",
  },
  {
    id: 4,
    title: "Equipo en movimiento",
    stage: "Trayecto",
    scene: "Dos colegas de unos 34 años comparten el asiento trasero, ambos con el cinturón puesto. Uno sostiene una tablet y le muestra algo al otro; conversan con naturalidad, enfocados en el trabajo.",
    background: "Interior amplio y prolijo del auto, con la ciudad desenfocada a través de las ventanillas.",
    designSpace: "Plano medio desde el ángulo del acompañante. Los dos rostros quedan dentro del centro del panel.",
  },
  {
    id: 5,
    title: "Llegada a la oficina",
    stage: "Salida",
    scene: "Un hombre de 47 años baja del auto frente a un edificio corporativo, con un portafolios en la mano. Se gira apenas hacia la cámara con expresión decidida y cordial.",
    background: "Fachada vidriada de oficinas, desenfocada. Luz de media mañana, blanca y pareja.",
    designSpace: "Plano medio-largo. El protagonista y la puerta del auto ocupan el centro del panel.",
  },
  {
    id: 6,
    title: "Últimos apuntes",
    stage: "Trayecto",
    scene: "Una mujer de 43 años repasa notas en una libreta apoyada sobre su cartera mientras viaja en el asiento trasero con el cinturón puesto. Gesto concentrado, sin apuro.",
    background: "Interior del auto en penumbra suave, con luz natural entrando por la ventanilla y la calle desenfocada.",
    designSpace: "Primer plano medio lateral. Rostro y libreta centrados en el panel.",
  },
  {
    id: 7,
    title: "Traslado nocturno",
    stage: "Trayecto",
    scene: "Un ejecutivo de 50 años viaja de noche en el asiento trasero con el cinturón puesto, el saco apoyado al lado y el teléfono en la mano. Expresión relajada después de una jornada larga.",
    background: "Luces blancas y frías de la ciudad desenfocadas a través de la ventanilla. Nada de tonos anaranjados.",
    designSpace: "Plano medio. El rostro, iluminado por la luz de la calle, queda en el centro del panel.",
  },
  {
    id: 8,
    title: "Café y agenda",
    stage: "Trayecto",
    scene: "Un hombre de 37 años con sweater fino sostiene un vaso de café reutilizable y revisa su agenda en el celular, en el asiento trasero y con el cinturón puesto. Se lo ve cómodo y de buen humor.",
    background: "Interior claro del auto con la ciudad desenfocada por la ventanilla. Luz de mañana.",
    designSpace: "Plano medio corto. Rostro, café y teléfono dentro del centro del panel.",
  },
  {
    id: 9,
    title: "Salida del hotel",
    stage: "Entrada",
    scene: "Una mujer de 39 años sale de un hotel con su valija de cabina y sube al auto que la espera. Mira hacia adelante con seguridad y una sonrisa breve.",
    background: "Entrada de un hotel corporativo con columnas y vidrio, desenfocada. Luz de mañana.",
    designSpace: "Plano general corto. La protagonista en el centro y el lateral del auto abajo.",
  },
  {
    id: 10,
    title: "Reunión resuelta",
    stage: "Salida",
    scene: "Un hombre de 41 años baja del auto con la notebook bajo el brazo y saluda al conductor con un gesto breve de agradecimiento. Expresión satisfecha.",
    background: "Vereda de un distrito de oficinas con árboles bajos, desenfocada. Luz de tarde temprana, blanca.",
    designSpace: "Plano medio-largo. El protagonista y la puerta abierta ocupan el centro del panel.",
  },
  {
    id: 11,
    title: "Trabajo en el asiento trasero",
    stage: "Trayecto",
    scene: "Una mujer de 33 años trabaja con la notebook apoyada sobre las piernas en el asiento trasero, con el cinturón puesto y auriculares pequeños. Escribe concentrada, cómoda.",
    background: "Interior del auto con tapizado claro y la calle desenfocada por la ventanilla lateral.",
    designSpace: "Plano medio desde el asiento del acompañante. Rostro y notebook centrados en el panel.",
  },
  {
    id: 12,
    title: "Entre dos reuniones",
    stage: "Trayecto",
    scene: "Un hombre de 45 años mira por la ventanilla con el teléfono apoyado en la pierna, tomándose un respiro entre reuniones. Cinturón puesto, postura relajada.",
    background: "Avenida con edificios corporativos desenfocados bajo un cielo despejado.",
    designSpace: "Plano medio lateral. El rostro queda en el centro del panel, con aire sobre la cabeza.",
  },
];
