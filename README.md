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
- Files: `POST /api/projects/:projectId/files/upload`, `GET /api/files/preview?path=...`, `GET /api/files/download?path=...`

## Notes

- The runner validates the graph is acyclic and currently executes nodes sequentially in topological order.
- Multiple input and output handles are supported in the schema and node UI.
- For production use, change `JWT_SECRET`, place `DATA_ROOT` on a persistent disk, and put the backend behind HTTPS.
