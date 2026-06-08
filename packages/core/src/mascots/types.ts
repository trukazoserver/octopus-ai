export const MASCOT_IDS = [
	"abeja-bibi",
	"anemona-anita",
	"arana-ari",
	"calamar-cali",
	"cangrejo-crabby",
	"estrella-estelita",
	"langosta-langi",
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
	| "estrategico"
	| "analitico";

export type MascotSpecialty =
	| "bienvenida-y-orientacion"
	| "investigacion-profunda"
	| "debugging-y-diagnostico"
	| "planificacion-creativa"
	| "automatizacion-fluida"
	| "arquitectura-y-coordinacion"
	| "control-de-calidad"
	| "multimedia-cinematica"
	| "sintesis-y-comunicacion";

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
