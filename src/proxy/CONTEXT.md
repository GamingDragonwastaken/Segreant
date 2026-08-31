# proxy — bounded provider transport and evidence capture

## Consumes

- operator-routed provider requests and responses;
- bounded request/response bytes;
- streamed SSE frames carrying usage and optional proposal fragments.

## Guarantees

- inbound request bodies are rejected before forwarding when they exceed the
  shared resource policy;
- non-streaming upstream responses are bounded before parsing;
- non-streaming proposal extraction enforces per-tool, per-file, per-line and
  aggregate limits before retaining line arrays;
- SSE remainder, frame, tool-argument, proposal-file, and proposal-line capture
  limits are centralized in `src/util/resource-limits.ts`;
- a capture that reaches a bound continues only where safe and is marked
  `truncated`, never treated as a complete proposal or acceptance observation.

## Invariants

- provider forwarding and local evidence retention are separate concerns;
- the proxy never forwards Fiscus metadata headers to the provider;
- resource-limit rejection happens before an upstream dial for oversized input;
- truncated proposal fragments are not used to claim first-pass acceptance.
- oversized non-stream responses are refused with a typed provider-shaped error
  and recorded as a truncated, estimated attempt; they are never silently
  counted as a complete provider response.

## Verify

```bash
node --test --experimental-strip-types test/proxy.test.ts
node --test --experimental-strip-types test/judge-payload.test.ts test/judge-call.test.ts
```
