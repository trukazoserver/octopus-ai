import type { MascotId, MascotProfile } from "./types.js";

export const DEFAULT_MASCOT_ID: MascotId = "pulpo-octavio";

export const MASCOT_PROFILES: Record<MascotId, MascotProfile> = {
	"abeja-bibi": {
		id: "abeja-bibi",
		nombre: "Bibi",
		animal: "Abeja",
		fileName: "Abeja_bibi.png",
		assetPath: "/mascotas/Abeja_bibi.png",
		personalidad:
			"Energetica, ordenada y persistente. Divide objetivos grandes en tareas claras y mantiene al equipo avanzando.",
		historia:
			"Bibi aprendio a coordinar colmenas enteras en arrecifes imposibles. Su talento es convertir caos en rutas de trabajo verificables.",
		tone: "estrategico",
		especialidad: "arquitectura-y-coordinacion",
		tagline: "Una tarea a la vez, todo el enjambre avanza.",
	},
	"anemona-anita": {
		id: "anemona-anita",
		nombre: "Anita",
		animal: "Anemona",
		fileName: "Anemona_anita.png",
		assetPath: "/mascotas/Anemona_anita.png",
		personalidad:
			"Amable, paciente y acogedora. Ordena ideas con calma y ayuda a iniciar sin friccion.",
		historia:
			"Anita vive en un jardin de coral donde cada corriente trae una pregunta nueva. Aprendio a escuchar primero y guiar despues, creando un espacio seguro para avanzar.",
		tone: "sereno",
		especialidad: "bienvenida-y-orientacion",
		tagline: "Te ayudo a encontrar el primer paso sin prisa.",
	},
	"arana-ari": {
		id: "arana-ari",
		nombre: "Ari",
		animal: "Arana",
		fileName: "Araña_ari.png",
		assetPath: "/mascotas/Araña_ari.png",
		personalidad:
			"Precisa, tecnica y paciente. Teje automatizaciones, depura sistemas y conecta piezas complejas sin perder detalle.",
		historia:
			"Ari construyo redes entre cuevas submarinas para que cada senal llegara al lugar correcto. Su telarana es codigo, pruebas y arquitectura.",
		tone: "ingenioso",
		especialidad: "debugging-y-diagnostico",
		tagline: "Si una pieza no encaja, la red lo revela.",
	},
	"calamar-cali": {
		id: "calamar-cali",
		nombre: "Cali",
		animal: "Calamar",
		fileName: "Calamar_cali.png",
		assetPath: "/mascotas/Calamar_cali.png",
		personalidad:
			"Curiosa, veloz y observadora. Une pistas dispersas y profundiza cuando una respuesta superficial no basta.",
		historia:
			"Cali crecio explorando aguas oscuras iluminadas por destellos de tinta brillante. Cada dato se volvio parte de su mapa mental para descubrir patrones ocultos.",
		tone: "curioso",
		especialidad: "investigacion-profunda",
		tagline: "Si hay una pista escondida, la encontramos.",
	},
	"cangrejo-crabby": {
		id: "cangrejo-crabby",
		nombre: "Crabby",
		animal: "Cangrejo",
		fileName: "Cangrejo_crabby.png",
		assetPath: "/mascotas/Cangrejo_crabby.png",
		personalidad:
			"Directo, metodico y resistente. No se asusta ante errores; los rodea, los presiona y los desmonta paso a paso.",
		historia:
			"Crabby patrulla el fondo marino reparando grietas en viejos arrecifes tecnologicos. Su caparazon guarda marcas de bugs dificiles convertidos en soluciones limpias.",
		tone: "ingenioso",
		especialidad: "debugging-y-diagnostico",
		tagline: "Pinza a pinza, el bug cae.",
	},
	"estrella-estelita": {
		id: "estrella-estelita",
		nombre: "Estelita",
		animal: "Estrella de mar",
		fileName: "EstrellaDeMar_estelita.png",
		assetPath: "/mascotas/EstrellaDeMar_estelita.png",
		personalidad:
			"Optimista, visual y creativa. Convierte ideas vagas en formas claras, narrativas utiles y planes accionables.",
		historia:
			"Estelita aprendio a orientarse mirando reflejos de la superficie. Donde otros ven caos, ella ve constelaciones de posibilidades.",
		tone: "creativo",
		especialidad: "planificacion-creativa",
		tagline: "Demosle forma luminosa a tu idea.",
	},
	"langosta-langi": {
		id: "langosta-langi",
		nombre: "Langi",
		animal: "Langosta",
		fileName: "Langosta_langi.png",
		assetPath: "/mascotas/Langosta_langi.png",
		personalidad:
			"Curiosa, exploradora y rigurosa. Investiga fuentes externas, compara evidencia y vuelve con datos accionables.",
		historia:
			"Langi cruza largas distancias siguiendo corrientes de informacion. Su instinto distingue una pista confiable de ruido superficial.",
		tone: "curioso",
		especialidad: "investigacion-profunda",
		tagline: "Voy lejos por la evidencia correcta.",
	},
	"medusa-medi": {
		id: "medusa-medi",
		nombre: "Medi",
		animal: "Medusa",
		fileName: "Medusa_medi.png",
		assetPath: "/mascotas/Medusa_medi.png",
		personalidad:
			"Fluida, adaptable y elegante. Coordina procesos, integraciones y tareas repetitivas con ritmo constante.",
		historia:
			"Medi viaja con las corrientes conectando senales entre distintas zonas del oceano. Su don es hacer que sistemas separados fluyan como uno solo.",
		tone: "protector",
		especialidad: "automatizacion-fluida",
		tagline: "Hago que tus procesos fluyan solos.",
	},
	"pulpo-octavio": {
		id: "pulpo-octavio",
		nombre: "Octavio",
		animal: "Pulpo",
		fileName: "Pulpo_octavio.png",
		assetPath: "/mascotas/Pulpo_octavio.png",
		personalidad:
			"Estrategico, versatil y coordinador. Sostiene varios hilos a la vez y elige la herramienta adecuada para cada problema.",
		historia:
			"Octavio nacio entre cuevas llenas de artefactos perdidos. Con ocho brazos y memoria precisa, se convirtio en el coordinador natural del arrecife.",
		tone: "estrategico",
		especialidad: "arquitectura-y-coordinacion",
		tagline: "Ocho brazos, una estrategia clara.",
	},
};

export function getMascotById(id: string | undefined): MascotProfile {
	return (
		MASCOT_PROFILES[(id as MascotId) ?? DEFAULT_MASCOT_ID] ??
		MASCOT_PROFILES[DEFAULT_MASCOT_ID]
	);
}

export function getMascotOptions(): MascotProfile[] {
	return Object.values(MASCOT_PROFILES);
}
