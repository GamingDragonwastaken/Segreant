# plugins - bounded adapter contract

## Consumes

- Host-owned plugin manifests, evidence messages, and an explicitly authorized
  executable launch request.
- The process host mediates one bounded newline-delimited stdio exchange; it
  does not consume a plugin loader, socket, credential, or provider response.

## Guarantees

- Plugin categories and consequence metadata are closed, typed, and validated.
- A plugin response is a bounded evidence submission; it cannot contain a
  Fiscus Claim, decision, action, or recommendation envelope.
- The isolation policy requires a separate process and host-mediated `stdio` or
  loopback local-socket transport, with explicit timeouts and resource limits.
- `runPluginProcess` binds the returned evidence to the active request ID,
  scrubs the child environment, and refuses capabilities that need unsupported
  OS-level restrictions.

## Invariants

- Validation happens before a message is accepted by a future host boundary.
- Direct network access, in-process execution, credentials, and destructive
  effects are metadata that require explicit capabilities; they are not
  performed by this module.
- Limits are refusal bounds, not truncation semantics. A message over a bound is
  invalid rather than partial evidence.
- A separate process is not an OS sandbox: filesystem, direct-network,
  credential-access, CPU, memory, and descriptor hard limits remain explicitly
  un-enforced and are never implied by this host.

## Verify

```bash
node --test --experimental-strip-types test/plugins-contract.test.ts test/plugins-isolation.test.ts
node --test --experimental-strip-types test/plugins-host.test.ts
node ./node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
```
