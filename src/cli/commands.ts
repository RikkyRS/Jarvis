import { COMMANDS, type CommandName } from "../shared/commands.js";
import { handle } from "../core/runtime.js";

export { COMMANDS, type CommandName };

export function runCommand(
  command: CommandName,
  projectRoot: string,
  options: {
    objective?: string;
    approve?: boolean;
    session?: string;
    deep?: boolean;
    commit?: boolean;
    port?: number;
    host?: string;
    remote?: boolean;
    checks?: boolean;
    limit?: number;
    path?: string;
  },
): unknown {
  return handle(command, projectRoot, options);
}
