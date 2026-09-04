# plugins - bounded adapter contract

## Consumes

- Host-owned plugin manifests and evidence messages.
- No plugin implementation, loader, child process, socket, credential, or
  provider response is consumed here.

## Guarantees

- Plugin categories and consequence metadata are closed, typed, and validated.
- A plugin response is a bounded evidence submission; it cannot contain a
  Fiscus Claim, decision, action, or recommendation envelope.
- The isolation policy requires a separate process and host-mediated `stdio` or
  loopback local-socket transport, with explicit timeouts and resource limits.

## Invariants

- Validation happens before a message is accepted by a future host boundary.
- Direct network access, in-process execution, credentials, and destructive
  effects are metadata that require explicit capabilities; they are not
  performed by this module.
- Limits are refusal bounds, not truncation semantics. A message over a bound is
  invalid rather than partial evidence.

## Verify

```bash
node --test --experimental-strip-types test/plugins-contract.test.ts test/plugins-isolation.test.ts
node ./node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
```
