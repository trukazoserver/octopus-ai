import type { DatabaseAdapter } from "../database.js";
import * as migration001 from "./001_initial.js";

export interface Migration {
  version: number;
  up: (db: DatabaseAdapter) => Promise<void>;
  down: (db: DatabaseAdapter) => Promise<void>;
}

export const migrations: Migration[] = [
  {
    version: 1,
    up: migration001.up,
    down: migration001.down,
  },
];
