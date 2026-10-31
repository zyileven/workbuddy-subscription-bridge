# Local bridge contract, 2026-10-31

The native CLI defaults to listening on 127.0.0.1. Docker explicitly uses
`--host 0.0.0.0` inside the container; Compose publishes both bridge and OAuth
callback ports on the host's 127.0.0.1 only. The OAuth redirect remains 127.0.0.1.
An opt-in `public` Compose profile adds an ngrok HTTPS ingress to `bridge:8787`.
Its traffic policy rewrites Host to `127.0.0.1:8787`; bridge bearer authentication
and Origin rejection still apply. The OAuth callback port is not tunneled by ngrok.
Its bearer key is a separate randomly generated local secret; an OpenAI credential is never supplied to WorkBuddy.
No OAuth, token-import, or upstream-URL configuration endpoint is exposed by HTTP.
Successful CLI login also prints a WorkBuddy model array containing the bridge
key and connection URL. `connection` queries the account catalog again and prints
the array without signing in or performing inference. Each available Astra, Sol,
Terra and Luna family contributes its highest numeric stable version from the
visible account catalog. Missing families are omitted with a CLI stderr notice;
an account with no supported family produces an explicit error.
Effort lists and defaults come directly from the selected catalog entry's
supported_reasoning_levels[].effort and default_reasoning_level. The CLI does
not invent a fallback list when capability metadata is absent. The bridge checks
effort-name syntax and forwards it unchanged, including ultra; model-specific
support validation remains with OpenAI. Only models listing none allow disabling
thinking in the generated configuration.
`sh config.sh` wraps the connection command. `sh config.sh --update` first
rebuilds the running containers while retaining the login volume, then prints
the same configuration array without performing another browser login.
Public mode reads ngrok's Docker-private GET /api/endpoints
and matches the bridge upstream; --require-public refuses to print a loopback
fallback or an unconfirmed configured public URL when the agent is unavailable.

| Endpoint | Contract |
| --- | --- |
| GET /health | Public readiness, no identities or secrets |
| GET /v1/models | Local bearer required; converts the authorized account's model catalog to Chat Completions list shape |
| POST /v1/chat/completions | Local bearer required; accepts text, user image_url, function tools and full tool-result history; supports stream true or false, n=1 |

Upstream: only public https://api.openai.com/v1/{models,responses}.
Every upstream inference uses store=false, stream=true, an input array and no
previous_response_id. Tools are grouped under the workbuddy namespace.
WorkBuddy executes tools; the bridge never executes tools or shell commands.
Versioned local aliases `gpt-VERSION-{astra,sol,terra,luna}-bridge` request the
canonical slug with the final `-bridge` suffix removed; the Chat Completions
response retains the requested alias. Existing `gpt-6.1-sol-bridge` configurations
remain valid. These IDs allow independent bridge entries alongside direct models.

The bridge preserves developer/system instructions as developer messages in their
original order. Chat tool-call IDs become Responses call_id values; results
become function_call_output. Parallel calls retain distinct indexes and IDs.
Streaming arguments are deltas, never duplicated by a final full-argument event.
Only response.completed yields a successful finish chunk and [DONE].
response.failed, response.incomplete and a premature EOF yield an error and no
successful finish. Upstream HTTP errors retain their HTTP status, error.code,
Retry-After and x-request-id. Inference is not automatically retried.
If the upstream omits Content-Type, the body must still parse as valid Responses
SSE and reach response.completed. An explicit non-SSE Content-Type is rejected.
When a completed response has an empty output array, completed output-item
snapshots supply the final text and tool calls; streamed text must match them.

Sampling/output-budget fields unsupported by the subscription route are removed
and named in x-bridge-ignored-parameters; their semantics are NOT implemented.
Unsupported modalities, tool types, multiple choices, and incompatible constraints
are rejected with 400 before inference. Images may be user-provided HTTPS URLs
or data:image payloads; the bridge does not download them.

OAuth is an interactive CLI operation with state, nonce, PKCE S256, dynamic
registration and signature-validated ID tokens. The issued client ID is persisted
before code exchange, and only a validated identity activates credentials. A
missing chatgpt.tokens.use.direct scope disables inference. Local files are
owner-only; refresh is serialized across processes and rotates tokens atomically.

Limits: single account/data directory; no inference-history cache; no encrypted
reasoning replay; no hosted tools, audio, video, Files upload, structured output,
or arbitrary vendor extension forwarding. Model-specific namespace and reasoning
behavior and actual WorkBuddy compatibility require a live acceptance test.

Primary references:
- https://developers.openai.com/siwc/token-sharing-open-source/sign-in
- https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions
- https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
- https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
- https://developers.openai.com/api/docs/guides/function-calling
- https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Model

This is a personal local integration prototype, not a claim of OpenAI or Tencent
certification. Eligibility and actual quota consumption have not been tested.
