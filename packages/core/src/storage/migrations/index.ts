import type { DatabaseAdapter } from "../database.js";
import * as migration001 from "./001_initial.js";
import * as migration002 from "./002_chat_enhancements.js";
import * as migration003 from "./003_agents.js";
import * as migration004 from "./004_tasks_automations.js";
import * as migration005 from "./005_env_vars.js";
import * as migration006 from "./006_learning.js";
import * as migration007 from "./007_chat_executions.js";
import * as migration008 from "./008_skill_schema.js";
import * as migration009 from "./009_advanced_memory_brain.js";

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
	{ version: 6, up: migration006.up, down: migration006.down },
	{ version: 7, up: migration007.up, down: migration007.down },
	{ version: 8, up: migration008.up, down: migration008.down },
	{ version: 9, up: migration009.up, down: migration009.down },
];
