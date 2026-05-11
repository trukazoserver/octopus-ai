export const MASCOT_IDS = [
	"anemona-anita",
	"calamar-cali",
	"cangrejo-crabby",
	"estrella-estelita",
	"medusa-medi",
	"pulpo-octavio",
] as const;

export type MascotId = (typeof MASCOT_IDS)[number];

export type MascotTone =
	| "sereno"
	| "curioso"
	| "ingenioso"
	| "protector"
	| "creativo"
	| "estrategico";

export type MascotSpecialty =
	| "bienvenida-y-orientacion"
	| "investigacion-profunda"
	| "debugging-y-diagnostico"
	| "planificacion-creativa"
	| "automatizacion-fluida"
	| "arquitectura-y-coordinacion";

export interface MascotProfile {
	id: MascotId;
	nombre: string;
	animal: string;
	fileName: string;
	assetPath: string;
	personalidad: string;
	historia: string;
	tone: MascotTone;
	especialidad: MascotSpecialty;
	tagline: string;
}
