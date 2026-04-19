declare module "sql.js" {
	export interface SqlJsStatic {
		Database: new (data?: ArrayLike<number>) => Database;
	}

	export interface Database {
		run(sql: string, params?: unknown[]): Database;
		exec(sql: string): { columns: string[]; values: unknown[][] }[];
		prepare(sql: string): Statement;
		export(): Uint8Array;
		close(): void;
		getRowsModified(): number;
	}

	export interface Statement {
		bind(params?: unknown[]): boolean;
		step(): boolean;
		getAsObject(): Record<string, unknown>;
		free(): boolean;
		reset(): boolean;
	}

	export default function initSqlJs(config?: {
		locateFile?: (file: string) => string;
	}): Promise<SqlJsStatic>;
}
