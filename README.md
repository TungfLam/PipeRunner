# Local Workflow Runner

A private personal workflow automation app for running local Python and terminal tools as visual workflows. It stores users, projects, workflows, and runs in MongoDB, keeps files on the local filesystem under `DATA_ROOT`, and streams child process logs to the browser with Socket.IO.

<img width="1364" height="764" alt="image" src="https://github.com/user-attachments/assets/3ce80a0a-585d-44d2-9fe3-c7be0b6bdf87" />

## Stack

- Frontend: React, Vite, TypeScript, MUI, Zustand, TanStack Query, React Hook Form, Zod, Socket.IO Client, `@xyflow/react`
- Backend: Node.js, Express, TypeScript, MongoDB, Mongoose, Socket.IO, JWT, bcrypt, Multer, `child_process.spawn`
- Tools: example Python scripts in `tools/examples`

## Setup

1. Copy env values:

   ```bash
   cp .env.example .env
   ```

2. Start MongoDB:

   ```bash
   docker compose up -d mongo
   ```

3. Install dependencies:

   ```bash
   npm install
   ```

4. Start both apps:

   ```bash
   npm run dev
   ```

5. Open:

   - Frontend: `http://localhost:5173`
   - Backend health: `http://localhost:4000/health`

## First Run

1. Register a user.
2. Create a project.
3. Click `Example` to create the bundled three-step workflow.
4. Open the workflow editor.
5. Click `Run` and choose any small file for the `video` input. The mock extractor accepts any existing file and creates a valid short WAV.
6. Open the run page to see step status, live logs, and output previews.

## Data Layout

Runs are stored under:

```text
DATA_ROOT/users/{userId}/projects/{projectId}/runs/{timestamp}_{runId}/
  input/
  output/
  temp/
  logs/
  manifest.json
```

The database stores metadata and DATA_ROOT-relative paths. File preview/download endpoints reject absolute paths and paths outside the authenticated user prefix.

## Command Model

Commands are stored as a binary plus arguments:

```json
{
  "bin": "python3",
  "args": [
    "../tools/examples/transcribe_mock.py",
    "--input",
    "{{inputs.audio}}",
    "--output",
    "{{outputs.subtitle}}"
  ]
}
```

The backend runs tools with:

```ts
spawn(bin, args, { shell: false, cwd, env })
```

Supported template variables:

- `{{inputs.name}}`
- `{{outputs.name}}`
- `{{params.name}}`
- `{{runDir}}`
- `{{inputDir}}`
- `{{outputDir}}`
- `{{tempDir}}`

## Easier CLI Tool Setup

In the workflow editor, click a tool node and configure it with form fields:

- `Command`: binary name, for example `vocremove`
- `Inputs`: one row per file input, with a CLI flag such as `--mp4-input` and accepted extension such as `mp4`
- `Outputs`: one row per output file, with CLI flags such as `--mp4-output` and `--mav-output`
- `Fixed options`: one argument per line, for example:

  ```text
  --chunk-duration
  10
  --medium
  --device
  cpu
  --verbose
  ```

The UI generates the stored `args` automatically. You can also add a `File Input` node, connect its output handle to the first tool input, and the run dialog will ask you to choose that local file.

## API Summary

- Auth: `POST /api/auth/register`, `POST /api/auth/login`, `GET /api/auth/me`
- Projects: `GET|POST /api/projects`, `GET|PATCH|DELETE /api/projects/:projectId`
- Workflows: `GET|POST /api/projects/:projectId/workflows`, `GET|PATCH|DELETE /api/workflows/:workflowId`
- Runs: `POST /api/workflows/:workflowId/runs`, `GET /api/workflows/:workflowId/runs`, `GET /api/runs/:runId`, `POST /api/runs/:runId/cancel`
- Cancel: `POST /api/runs/:runId/cancel` with `{}` cancels every active job in that run; `{ "itemIds": ["item_001"] }` cancels selected jobs.
- Rerun: `POST /api/runs/:runId/rerun` with `{}` resumes all failed/cancelled jobs; `itemIds` selects jobs. The previous `itemId` + `nodeId` request is also supported. Both actions return `{ run, acceptedItemIds, skipped }`; skipped entries include a reason.
- Logs: `GET /api/runs/:runId/logs?itemId=...&nodeId=...&attemptId=...` returns a bounded tail (at most 256 KiB total), with `startCursor`, `nextCursor`, `totalBytes` and `hasMore`. Pass `cursor=nextCursor` for new bytes or `before=startCursor` for earlier output. Download complete logs using the authenticated file download endpoint.
- Files: `POST /api/projects/:projectId/files/upload`, `GET /api/files/preview?path=...`, `GET /api/files/download?path=...`

## Notes

- The runner validates the graph is acyclic and currently executes nodes sequentially in topological order.
- Multiple input and output handles are supported in the schema and node UI.
- For production use, change `JWT_SECRET`, place `DATA_ROOT` on a persistent disk, and put the backend behind HTTPS.

## Job lifecycle and recovery

- Waiting jobs and steps use `await`; `running` means a tool slot has been granted. A job returns to `await` if its next tool has no free slot.
- Each tool's **Max concurrent runs** applies across every run and rerun of that workflow for the current user. Limits are shared by node ID, with FIFO admission. Changing a limit affects subsequent admissions; reducing it does not kill active commands.
- Individual jobs can be cancelled and rerun while siblings continue. Reruns resume at the first unfinished step, reuse successful upstream outputs, and keep new outputs/logs in separate attempt folders. Missing prerequisite files produce a skipped result instead of an apparently running job.
- New runs retain a workflow snapshot. Legacy runs validate their step IDs against the current workflow before rerunning and retain a snapshot after the first accepted rerun.
- Run **one backend per DATA_ROOT**, on Linux. An owner file rejects a second live backend. On startup, interrupted active jobs are marked `cancelled` before the API opens; successful results are retained. Existing `pending`/`waiting` records are normalized automatically. Recovery does not restart commands; use Rerun.
- Commands run under a supervisor that stops their process group when the backend connection disappears, including after SIGKILL. Cancellation/timeout waits for cleanup before releasing a slot. Process identity is persisted and verified against Linux boot ID/start time before recovery signals a leftover process. Processes started by older versions without ownership metadata cannot be identified safely by recovery.
- The Run page subscribes to state patches and the selected step's log notifications. It reads new log bytes at most four times per second, keeps at most 2,000 lines/1 MiB in the browser, and loads the workflow graph/file previews on demand. Full logs remain on disk.

## Validation

```bash
npm run typecheck
npm run build
npm test
npm run test:e2e
npm run test:performance
```

`test:e2e` requires MongoDB at `mongodb://127.0.0.1:27017` (override with `QA_MONGODB_URI`) and Chromium at `/usr/bin/chromium` (override with `CHROMIUM_PATH`, or install Playwright's browser). It creates a separate temporary database and DATA_ROOT, tests concurrency/cancellation/reruns/crash recovery and desktop/mobile interactions, then drops only its test database. Screenshots and results are written to `.cache/qa`.

`test:performance` needs Chromium and Git. It compares production builds of the committed frontend (`HEAD`) and the working frontend using 50 synthetic jobs, 20 log chunks per job per second and a status event each second. It records renderer CPU, heap, layout time and traffic in `.cache/qa/performance.json`; its regression target is at least 50% lower renderer CPU and at most approximately four log DOM updates per second. It does not connect to MongoDB or execute workflow commands.
