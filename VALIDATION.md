# Verification record

Date: 2026-10-31, Asia/Shanghai. Node.js 22.23.4, Postman CLI 1.77.0.

## Completed

- `npm test`: 28 tests, 28 passed, 0 failed.
- `postman spec lint openapi.yaml --issueType syntax --no-report-events`: No issues found.
- Real bridge against a separate Postman HTTP simulation: 8 scenarios passed.
  The simulated upstream recorded 7 inference requests, each with `store:false`,
  `stream:true` and an input array. NDJSON member request events were inspected.
  The exercise covered model discovery, streamed text, parallel tool calls,
  second-turn tool results, HTTP 429, in-stream failure, dropped stream and timeout.
- OAuth tests used a real loopback callback and generated RSA-signed ID tokens,
  verified bad state, bad signatures/claims, missing permission and refresh rotation.
- Local listener tests verified authentication, browser-Origin rejection and
  hostile Host rejection. All fixture credentials are synthetic.

The initial Host-header test used Node fetch, which normalizes that header; it
was corrected to use node:http so the actual hostile Host reaches the listener.
The corrected test passes. Postman's schema checker validated syntax only,
not complete behavioral conformance.

The sandbox initially denied the separate simulation's loopback listener. The
same loopback-only commands ran successfully with reviewed execution permission.
No public server or cloud Postman artifact was created. Skills-update checks
could not reach their remote repository; installed local skill instructions
were used. No provider-owned published mock was pulled; the fixture models
the selected examples from the official docs listed in CONTRACT.md.

## Remaining real-environment acceptance

- Browser OAuth and one completed streamed inference now pass; see the live
  validation below. ChatGPT app usage still needs inspection to confirm actual
  quota attribution. Neither a mock nor one response establishes Codex entitlements.
- WorkBuddy selecting the custom model and completing both plain chat and a
  read-only tool workflow. No WorkBuddy settings were changed in this session.
- Model-specific namespace/parameter support, long-session reasoning-state
  behavior and how the client presents SSE errors after HTTP 200.

Do not describe this prototype as a verified production integration until those
acceptance steps have completed.

## Docker validation, 2026-10-31

- `docker compose config --quiet` and `docker compose up -d --build --wait`
  completed successfully on OrbStack, Linux aarch64, Docker 29.8.2 / Compose 5.5.0.
  The runtime image uses Node.js 22.23.4 and no npm dependencies.
- All 29 tests passed inside the built image with `--network none`, including
  OAuth callbacks bound to both 127.0.0.1 and the container's 0.0.0.0 interface.
- A Postman request to the running container's published `/health` passed both
  HTTP 200 and expected JSON assertions, with event reporting disabled.
- A separate fixture listener inside the running container verified the actual
  published 1455 callback port. Wrong state and hostile Host were rejected;
  a valid synthetic callback completed. It saved no account credentials.
- Both published ports bind to the host's 127.0.0.1 only. The process runs as
  UID 1000 with a read-only root filesystem; data directory/file modes are
  0700/0600. The build context allowlists runtime files and excludes local data.
- Forced container recreation passed its health check and retained the same
  local bridge key in the named volume; the key was compared without printing it.
- The existing Postman HTTP simulation was rerun: all 8 scenarios passed,
  and its NDJSON events confirmed model and inference traffic, quota rejection
  and the delayed response. The simulation was stopped after verification.
- From inside the container, OpenAI OIDC discovery returned HTTP 200 and the
  unauthenticated model endpoint returned HTTP 401, confirming network reachability.
  The bridge itself reports `connected: false`; authenticated local model
  discovery correctly returns `login_required`. Real OAuth, inference and
  WorkBuddy acceptance remain pending as described above.

Reproduction and login commands: [Docker guide](docs/Docker.md).

## Live OAuth and inference validation, 2026-10-31

After the user completed browser authorization, container status reported
`connected: true`, `plan_usage_enabled: true`, and `expired: false`. The actual
account model catalog was retrieved successfully.

Live traffic exposed two differences from the original fixtures: an HTTP 200
Responses SSE body arrived without Content-Type, and completed message snapshots
were delivered in `response.output_item.done` while `response.completed.output`
was empty. One diagnostic request also ended in an upstream server error; that
failure was not counted as successful inference. The bridge now accepts an
omitted Content-Type only through its existing SSE parser, and reconciles empty
terminal output against completed item snapshots. Explicit non-SSE types,
inconsistent text, missing snapshots, failed streams and incomplete streams still
cannot produce a successful finish.

- Rebuilt the image and recreated the container, preserving the authorized session.
- All 34 tests passed inside the built image with external networking disabled.
- The expanded Postman HTTP simulation passed 16 scenarios. Inspection recorded
  15 inference requests; NDJSON member traffic confirmed the new header and
  terminal-output cases. The simulation was stopped after verification.
- A real request from the host to the Docker-published
  `http://127.0.0.1:8787/v1/chat/completions`, using model `gpt-6.1-sol` and
  `stream:true`, returned HTTP 200, text `Bridge OK.`, finish reason `stop`,
  and `[DONE]`. This demonstrates one complete real streamed text request.
- Actual WorkBuddy chat/tool workflows, model-specific capabilities and ChatGPT
  usage-page attribution remain unverified. Credentials and callback codes were
  not printed or stored in this record.

## Independent WorkBuddy model entry, 2026-10-31

Added the local alias `gpt-6.1-sol-bridge`, which routes to upstream
`gpt-6.1-sol` and retains the requested alias in Chat Completions responses.
This avoids reusing the ID of the existing direct model in WorkBuddy. The
container was rebuilt and recreated successfully. The HTTP regression test
checks the actual upstream request model and downstream response identity.
All 35 tests passed inside the rebuilt image with external networking disabled.

Appended a separate entry to the user's requested `~/.workbuddy/models.json`,
preserving all 10 existing entries and their values. The new entry uses the
bridge's full Chat Completions URL, custom protocol and an empty `apiKey` for
the user to fill manually. A private backup was saved beside the file; both
files have mode 0600. Reasoning-summary configuration is omitted because it is
outside the bridge's accepted request fields. Actual WorkBuddy execution with
the new entry remains pending the user's key entry and model selection.

## Test using the user's configured key, 2026-10-31

After the user filled `apiKey`, read it directly from the bridge entry in
`~/.workbuddy/models.json` without printing it. It matched the running bridge's
local key, with no surrounding whitespace. Authenticated model discovery
returned HTTP 200 and 8 models. A streamed request using the configured URL,
`gpt-6.1-sol-bridge`, medium reasoning and the configured output budget returned
HTTP 200, text `WorkBuddy bridge OK.`, finish reason `stop` and `[DONE]`.
The budget field was reported as ignored according to the existing contract.

The user's failed WorkBuddy request did not reach model inference: its CLI log
reported an unresolvable `custom-local:gpt-6.1-sol-bridge` and
`custom_model_config` / missing endpoint URL. The desktop's current product
snapshot contains the new entry and URL, while the failing conversation's CLI
last logged loading custom models before the entry was added. This supports a
stale conversation/runtime configuration diagnosis. WorkBuddy conversation
execution remains unverified until it loads the current configuration; the
configured key and Docker bridge have passed their direct checks.

## Portable source publication, 2026-10-31

Stopped and removed this project's local Compose container and network with
`docker compose down`, retaining the named account-data volume. No bridge or
OAuth listener remained on ports 8787/1455. Added portable clone/deploy,
headless OAuth over SSH forwarding, persistent operation and update instructions,
plus a WorkBuddy model-entry example with an empty key. These remote deployment
instructions have not yet been executed on the user's other computer.

The 27 source/documentation/configuration files passed a credential-pattern scan
and an exact check for the actual local bridge key. The deployment JSON example
parsed with an empty key, Compose configuration validated, and Git ignore checks
confirmed exclusion of local account data, environment secrets and key files.
Runtime source is unchanged since the passing 35-test container run above.
