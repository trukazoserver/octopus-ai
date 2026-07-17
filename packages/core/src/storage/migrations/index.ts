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
import * as migration010 from "./010_chat_task_ledger.js";
import * as migration011 from "./011_conversation_context_snapshots.js";
import * as migration012 from "./012_octopus_arms_workflows.js";
import * as migration013 from "./013_workflow_recovery_indexes.js";
import * as migration014 from "./014_subtask_verification.js";
import * as migration015 from "./015_kanban_swarm_dependencies.js";
import * as migration016 from "./016_task_model_column.js";
import * as migration017 from "./017_tool_health.js";
import * as migration018 from "./018_ai_usage_and_agent_model_profiles.js";
import * as migration019 from "./019_provider_quota_cache.js";
import * as migration020 from "./020_chat_tool_actions.js";
import * as migration021 from "./021_chat_execution_outcomes.js";
import * as migration022 from "./022_atomic_chat_tool_actions.js";
import * as migration023 from "./023_workflow_run_leases.js";
import * as migration024 from "./024_memory_vector_outbox.js";
import * as migration025 from "./025_memory_vector_outbox_leases.js";
import * as migration026 from "./026_memory_relation_owner.js";
import * as migration027 from "./027_learning_scopes.js";
import * as migration028 from "./028_temporal_claims_learning_evidence.js";
import * as migration029 from "./029_memory_operations_ann.js";
import * as migration030 from "./030_resumable_memory_operations.js";
import * as migration031 from "./031_memory_operation_control.js";
import * as migration032 from "./032_memory_benchmarks.js";

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
	{ version: 10, up: migration010.up, down: migration010.down },
	{ version: 11, up: migration011.up, down: migration011.down },
	{ version: 12, up: migration012.up, down: migration012.down },
	{ version: 13, up: migration013.up, down: migration013.down },
	{ version: 14, up: migration014.up, down: migration014.down },
	{ version: 15, up: migration015.up, down: migration015.down },
	{ version: 16, up: migration016.up, down: migration016.down },
	{ version: 17, up: migration017.up, down: migration017.down },
	{ version: 18, up: migration018.up, down: migration018.down },
	{ version: 19, up: migration019.up, down: migration019.down },
	{ version: 20, up: migration020.up, down: migration020.down },
	{ version: 21, up: migration021.up, down: migration021.down },
	{ version: 22, up: migration022.up, down: migration022.down },
	{ version: 23, up: migration023.up, down: migration023.down },
	{ version: 24, up: migration024.up, down: migration024.down },
	{ version: 25, up: migration025.up, down: migration025.down },
	{ version: 26, up: migration026.up, down: migration026.down },
	{ version: 27, up: migration027.up, down: migration027.down },
	{ version: 28, up: migration028.up, down: migration028.down },
	{ version: 29, up: migration029.up, down: migration029.down },
	{ version: 30, up: migration030.up, down: migration030.down },
	{ version: 31, up: migration031.up, down: migration031.down },
	{ version: 32, up: migration032.up, down: migration032.down },
];
