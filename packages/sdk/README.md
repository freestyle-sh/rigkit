# @rigkit/sdk

Project-local rigkit authoring API and runtime daemon package.

Configs should import authoring helpers from this package:

```ts
import { env, workflow } from "@rigkit/sdk";
```

Inside a task handler, `console.log`, `console.info`, `console.debug`, `console.warn`, and `console.error` are intercepted and streamed to the runtime as structured `log.output` events with a level. The CLI renders each level distinctly (debug dim, log default, warn yellow, error red). Set `RIGKIT_NO_CONSOLE_INTERCEPT=1` to disable the intercept and write to the host's terminal instead.
Provider VM commands can also report incremental stdout/stderr through
`ExecOptions.onOutput`; the runtime forwards those chunks over the same run
session and falls back to buffered command output when a provider cannot stream.

Local hosts start the project daemon through the `rigkit-project-runtime` binary
installed by this package.
