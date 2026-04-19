import type { DatabaseAdapter } from "../database.js";
import * as migration001 from "./001_initial.js";
import * as migration002 from "./002_chat_enhancements.js";
import * as migration003 from "./003_agents.js";
import * as migration004 from "./004_tasks_automations.js";
import * as migration005 from "./005_env_vars.js";

export interface Migration {
	version: number;
	up: (db: DatabaseAdapter) => Promise<void>;
	down: (db: DatabaseAdapter) => Promise<void>;
}

export const migrations: Migration[] = [
	{ version: 1, up: migration001.up, down: migration001.down },
	{ version: 2, up: migration002.up, down: migration002.down },
	{ version: 3, up: migration003.up, down: migration003.down },
	{ version: 4, up: migration004.up, down: migration004.down },
	{ version: 5, up: migration005.up, down: migration005.down },
];
