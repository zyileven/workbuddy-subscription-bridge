# HTTP dependency simulation

This fixture was written from the official OpenAI subscription-flow and SSE
documentation, not pulled from an owning team's published mock. It encodes our
selected contract examples and does not establish real eligibility or billing.
No upstream account credentials are used. No Postman cloud resources are needed.

From the deliverable root, terminal A:

```bash
postman simulation run postman/simulations/local/local.sim.yaml --port 4010 --output ndjson --no-history
```

After a `listening` event, terminal B:

```bash
node test/simulation.mjs http://127.0.0.1:4010/openai
```

Stop and restart the simulation before rerunning so inspection starts clean.
The code under test is the real bridge. Only the upstream OpenAI HTTP dependency
is mocked. One-port mode is deliberate: the test explicitly points a fixture-only
bridge instance at the simulation and cannot accidentally contact api.openai.com.
Production CLI endpoints remain fixed to official OpenAI origins.

Read the run's NDJSON request events to confirm member traffic. Do not publish
this fixture or its logs as evidence that real OpenAI or WorkBuddy integration
has passed. Local fixture request records contain only synthetic credentials.
The real service does not expose a request-inspection route.
