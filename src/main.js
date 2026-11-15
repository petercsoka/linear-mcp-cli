import fs from "node:fs";
import { CliError, EXIT } from "./errors.js";
import { help, parse } from "./cli.js";
import { loadConfig } from "./config.js";
import { McpClient, DEFAULT_SERVER } from "./mcp.js";
import { Linear } from "./linear.js";
import { issueCommand } from "./commands/issue.js";
import {
  teamCommand, userCommand, projectCommand, cycleCommand, milestoneCommand, documentCommand,
  labelCommand, initiativeCommand,
} from "./commands/workspace.js";
import { authCommand, configCommand, mcpCommand, completionsCommand } from "./commands/meta.js";

const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const ENVIRONMENT = `Environment:
  LINEAR_MCP_SERVER         Command that runs the Linear MCP server
                            [default: ${DEFAULT_SERVER}]
  LINEAR_MCP_TRANSPORT      auto, mcp (the mcp CLI, one call per process), or
                            stdio (one MCP session per command) [default: auto]
  LINEAR_MCP_COMMAND        The mcp CLI to run [default: mcp]
  LINEAR_TEAM_ID            Default team key
  LINEAR_DEBUG=1            Show MCP calls, server logs, and error details
  LINEAR_IGNORE_ENV_FILE=1  Do not load .env files

No API key is used: mcp-remote logs in to Linear with OAuth in your browser
the first time, and stores the token in ~/.mcp-auth.

Exit status:
  0    Success
  1    Any other failure, including MCP tool errors
  2    Usage error: bad flags or values, rejected before anything is sent
  3    Not found: an issue, team, or other entity the command looked up
  4    Authentication: not logged in, or Linear rejected the credentials
  5    Unavailable: the MCP server could not be reached or timed out
  130  Cancelled at a prompt`;

export const root = {
  name: "linear",
  description: "Work with Linear from the command line, through Linear's MCP server",
  commands: [
    issueCommand, projectCommand, milestoneCommand, cycleCommand, initiativeCommand, documentCommand,
    labelCommand, teamCommand, userCommand, authCommand, configCommand, mcpCommand, completionsCommand,
  ],
  after: ENVIRONMENT,
};

export async function main(argv) {
  if (argv.length === 0) {
    process.stdout.write(help([root]));
    return EXIT.usage;
  }
  if (argv[0] === "--version" || argv[0] === "-V") {
    process.stdout.write(`linear ${pkg.version} (mcp)\n`);
    return EXIT.ok;
  }
  let client;
  try {
    const parsed = parse(root, argv);
    if (parsed.help) {
      process.stdout.write(help(parsed.path));
      return parsed.values.help ? EXIT.ok : EXIT.usage;
    }
    const config = loadConfig();
    const ctx = {
      config,
      noInput: parsed.values.noInput,
      workspace: parsed.values.workspace ?? config.workspace,
      linear() {
        if (!this._linear) {
          const server = config.mcp_server || DEFAULT_SERVER;
          client = new McpClient({
            server,
            transport: config.mcp_transport,
            mcpCommand: config.mcp_command,
            timeoutMs: config.mcp_timeout ? Number(config.mcp_timeout) * 1000 : undefined,
          });
          this._linear = new Linear(client, { server });
        }
        return this._linear;
      },
    };
    await parsed.command.run(ctx, parsed.values, parsed.args, root);
    return EXIT.ok;
  } catch (error) {
    if (!(error instanceof CliError)) {
      process.stderr.write(`error: ${error.message}\n`);
      if (process.env.LINEAR_DEBUG) process.stderr.write(`${error.stack}\n`);
      return EXIT.failure;
    }
    process.stderr.write(`error: ${error.message}\n`);
    if (error.hint) process.stderr.write(`\n${error.hint}\n`);
    if (error.code === EXIT.auth && !error.hint) {
      process.stderr.write("\nRun `linear auth login` to authorize with Linear.\n");
    }
    return error.code;
  } finally {
    client?.close();
  }
}
