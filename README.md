# linear-mcp-cli

A reimplementation of [schpet/linear-cli](https://github.com/schpet/linear-cli): same `linear` command, same subcommands, flags, table layouts, Markdown views, `--json` shapes and exit statuses. The difference is how it reaches Linear. It never asks for an API key. Every operation is a tool call on [Linear's MCP server](https://linear.app/docs/mcp), so it works the same as:

```sh
mcp call list_issues --params '{"assignee":"me"}' npx -y mcp-remote https://mcp.linear.app/mcp
```

`mcp-remote` handles the OAuth login: the first call opens your browser and stores the token in `~/.mcp-auth`.

```bash
linear auth login           # authorize once, in the browser
linear config               # write .linear.toml for this repo (default team, workspace)

linear issue list           # unstarted issues assigned to you
linear issue query --search "login bug"
linear issue start ENG-123  # create/switch to the issue's branch, mark it started
linear issue view           # the current branch's issue, as Markdown
linear issue create -t "Title" -d "Description" -l Bug -p high
linear issue update ENG-123 -s "In Review" --add-label Frontend
linear issue pr             # gh pr create with the title and body preset
```

## install

Needs Node 20 or newer. No npm dependencies.

```sh
npm install -g .            # from this directory; puts `linear` on PATH
# or run it in place
node bin/linear.js --help
```

Optional: install the [`mcp` CLI](https://github.com/f/mcptools) (`brew tap f/mcptools && brew install mcp`). See transports below.

## transports

| `LINEAR_MCP_TRANSPORT` | what happens |
| --- | --- |
| `auto` (default) | `mcp` if the `mcp` CLI is on PATH, otherwise `stdio` |
| `mcp` | each tool call runs `mcp call <tool> --params '<json>' -f json <server command>` |
| `stdio` | the CLI speaks MCP JSON-RPC to `<server command>` itself, keeping one session open for every call a command makes |

The server command defaults to `npx -y mcp-remote https://mcp.linear.app/mcp` and can be changed with `LINEAR_MCP_SERVER` or `mcp_server` in a config file. With `mcp`, every call starts a fresh `npx mcp-remote` process, so commands that make several calls (`issue start`, `issue view` with comments) are faster on `stdio`.

`LINEAR_DEBUG=1` prints each call (the full `mcp call …` command line on the `mcp` transport) and the server's logs.

## commands

```
linear issue    list | query | view | create | update | start | id | title | url | describe
                pr | comment (list|add|update|delete) | link | relation add | delete | archive
linear project  list | view | create | update
linear milestone list | view | create | update        (alias: m)
linear cycle    list | view                              (alias: cy)
linear initiative list | view
linear document list | view | create | update           (aliases: docs, doc)
linear label    list | create
linear team     list | id | members | states
linear user     list
linear auth     login | logout | whoami | status
linear config
linear mcp      tools | call <tool> [json]              (alias: api; the MCP counterpart of `linear api`)
linear completions [bash|zsh|fish]
```

The current issue comes from the git branch name (`eng-123-…`) or, with `vcs = "jj"`, from the `Linear-issue:` trailer in the jj change, as in the original.

## configuration

The same files and precedence as the original: flag > environment (`.env` too) > `./linear.toml` / `./.linear.toml` / repo-root `.linear.toml` / `.config/linear.toml` > `~/.config/linear/linear.toml`.

| toml key | env var | |
| --- | --- | --- |
| `team_id` | `LINEAR_TEAM_ID` | default team key |
| `workspace` | `LINEAR_WORKSPACE` | workspace slug for `-w`/`-a` URLs |
| `issue_sort` | `LINEAR_ISSUE_SORT` | `priority` or `manual` |
| `issue_create_assign_self` | `LINEAR_ISSUE_CREATE_ASSIGN_SELF` | `always`, `auto`, `never` |
| `vcs` | `LINEAR_VCS` | `git` or `jj` |
| `pr_template` | `LINEAR_PR_TEMPLATE` | body template for `issue pr` |
| `mcp_server` | `LINEAR_MCP_SERVER` | MCP server command |
| `mcp_transport` | `LINEAR_MCP_TRANSPORT` | `auto`, `mcp`, `stdio` |
| `mcp_command` | `LINEAR_MCP_COMMAND` | the `mcp` CLI binary |
| `mcp_timeout` | `LINEAR_MCP_TIMEOUT` | seconds per call (default 180, which leaves time for the first OAuth login) |

## exit status

`0` success · `1` other failure · `2` usage error (nothing sent) · `3` not found · `4` authentication · `5` unavailable / timed out · `130` cancelled.

## differences from schpet/linear-cli

The MCP server exposes less than Linear's GraphQL API, so some things work differently:

- **No file uploads.** `issue attach` and `comment add --attach` are unavailable.
- **Delete and archive.** These depend on the server offering `delete_issue` / `archive_issue`. If it doesn't, the command says so and suggests moving the issue to a canceled state instead.
- **`linear api` / `linear schema`.** Replaced by `linear mcp call` / `linear mcp tools`.
- **Not ported:** templates, status updates, agent sessions, inline images, and the bundled agent skill.
- **Result shapes.** The MCP returns flatter results than GraphQL (state *names*, assignee *names*). The CLI normalizes them into the original's shapes (`state: {name, type}`, `labels: {nodes: […]}`, `assignee: {name, displayName, initials}`, …), so `--json` scripts keep working. Fields the MCP doesn't return come back as `null`.
- **Tool names.** Where Linear has renamed a tool (e.g. `create_issue` → `save_issue`), the CLI tries the current name first and falls back to the older one.

## development

```sh
npm test    # runs every command against a mock Linear MCP server, over both transports
```

`test/mock-server.js` is an MCP stdio server with Linear-shaped tools. `test/fake-mcp.js` stands in for the mcptools CLI and parses arguments the same way.
