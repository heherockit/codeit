# codit

An automation agent that picks up work items from Azure DevOps, uses Augment AI to implement the required code changes, and raises pull requests — all driven by plain-text job files.

## How it works

1. Fetches active work items from Azure DevOps.
2. Identifies which local repositories need changes.
3. Uses the Augment CLI to analyse repositories and implement changes.
4. Creates feature branches, commits, pushes, and opens pull requests.
5. Updates work item state throughout.

Each step is a **technique** belonging to a **skill**. Techniques are composed into **jobs** using a simple text format.

## Prerequisites

- Node.js 18+
- Git
- [Augment CLI](https://www.augmentcode.com/) available on `PATH` (or configured via `augment.cliPath`)
- An Azure DevOps account with a Personal Access Token

## Setup

```sh
npm install
npm run build
```

Copy the example config and fill in your credentials:

```sh
cp config/config.example.json config/config.json
```

`config.json` is gitignored — never commit it.

## Configuration (`config/config.json`)

| Key | Description |
|---|---|
| `logLevel` | `debug` / `info` / `warn` / `error` |
| `logFile` | Path to the log file (optional) |
| `dryRun` | `true` to skip all writes (git, ADO) |
| `azureDevOps.organization` | ADO organisation name |
| `azureDevOps.project` | ADO project name |
| `azureDevOps.personalAccessToken` | PAT with Work Items + Code read/write |
| `azureDevOps.workItemType` | Work item type to fetch (e.g. `Task`) |
| `azureDevOps.workItemState` | State filter (e.g. `Active`) |
| `azureDevOps.inProgressState` | State to set when work begins |
| `azureDevOps.completedState` | State to set when PRs are raised |
| `git.workSpacePath` | Root directory containing your repositories |
| `augment.cliPath` | Path to the Augment CLI executable |
| `augment.timeoutSeconds` | Per-invocation timeout (default `1800`) |

## Running

```sh
# Run the default job (main — loops continuously)
codit

# Run the mission job (single pass, full pipeline)
codit --job=mission

# Use a custom config file
codit --config=path/to/config.json
```

`codit.cmd` runs `node dist/index.js` with all arguments forwarded.

## Introspection

List all registered skills and their techniques:

```sh
codit --skills
```

List techniques for a specific skill:

```sh
codit --skill=git
codit --skill=azure-devops
codit --skill=augment
```

## Jobs

Jobs live in the `jobs/` directory. Each file uses a simple DSL:

```
JOB <name>
[LOOP]
<technique title>
<technique title>
...
```

- `LOOP` causes the job to repeat indefinitely.
- Lines starting with `#` are comments.
- Technique titles must exactly match a registered technique.

### Built-in jobs

| Job | Description |
|---|---|
| `main` | Full pipeline, loops continuously |
| `mission` | Full pipeline, single pass |

## Skills

| Skill | Techniques |
|---|---|
| `git` | identify affected repositories, create feature branches, commit and push changes |
| `azure-devops` | fetch work items, fetch work item details, update work item state, create pull requests |
| `augment` | analyze repositories with Augment, implement changes with Augment |
| `telegram` | notify job status, await telegram command |

## Development

```sh
npm run dev              # run via tsx (no build needed)
npm run dev:mission      # run the mission job via tsx
npm test                 # run all tests
npm run test:watch       # watch mode
npm run lint             # type-check only
```

