// Child process used by the recovery tests: tries to consume an approval and prints the result.
import { ApprovalService } from "../../src/approval/service.js";
import { AuditLog } from "../../src/persistence/audit.js";
import { openDatabase } from "../../src/persistence/db.js";

const [dbFile, operationId] = process.argv.slice(2) as [string, string];
const db = openDatabase(dbFile);
const approvals = new ApprovalService(db, new AuditLog(db));
const result = approvals.consume({
  operationId,
  projectId: "p",
  workItemId: "w",
  workflowRunId: "r",
  requestedBy: { kind: "agent", id: "claude" },
  type: "GIT_COMMIT",
  target: "main",
  parameters: { diffHash: "d" },
  trust: "TRUSTED",
});
console.log(JSON.stringify({ ok: result.ok }));
db.close();
