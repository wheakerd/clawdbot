import type { DatabaseSync } from "node:sqlite";
import {
  assertTransactionUsable,
  runSqliteImmediateTransactionSync,
} from "../../infra/sqlite-transaction.js";
import type { SqliteWorkerBackend } from "../../infra/sqlite-worker-contract.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "../../state/openclaw-state-db-contract.js";
import {
  executeContextEngineTurnOutboxCommand,
  type ContextEngineTurnOutboxWorkerOperations,
} from "./context-engine-turn-outbox.js";

/** Borrows the canonical agent connection for one admitted outbox operation. */
export function bindSqliteWorkerBackend(
  _input: undefined,
  context: {
    databasePath: string;
    database: DatabaseSync;
    admit(stage: "transaction" | "commit"): void;
  },
): SqliteWorkerBackend<ContextEngineTurnOutboxWorkerOperations> {
  const db = context.database;
  return {
    execute(command) {
      return runSqliteImmediateTransactionSync(
        db,
        () => {
          context.admit("transaction");
          return executeContextEngineTurnOutboxCommand(db, command);
        },
        {
          operationLabel: `context-engine.turn-outbox.${command.type}`,
          busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
          databaseLabel: context.databasePath,
          withCommit(commit) {
            context.admit("commit");
            commit();
          },
        },
      );
    },
    assertSettled() {
      assertTransactionUsable(db);
      if (db.isTransaction) {
        throw new Error("Context-engine turn outbox transaction did not settle");
      }
    },
    close() {},
  };
}
