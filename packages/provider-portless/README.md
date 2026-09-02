# `@rigkit/provider-portless`

Declare stable, named local URLs for development servers launched through
[Portless](https://github.com/vercel-labs/portless).

The provider creates a route descriptor containing the Portless launch command,
hostname, proxy port, and URL. Run the command in the same environment as the
development server. This works for local workflows and for remote browser
proxies such as a cmux SSH workspace.

```ts
import { portless } from "@rigkit/provider-portless";
import { workflow } from "@rigkit/sdk";

const app = workflow("website");

export const website = app
  .sequence("website")
  .addProvider("portless", portless.provider({
    https: false,
    proxyPort: 80,
    syncHosts: false,
  }))
  .task("route", { version: "v1" }, async ({ providers }) => ({
    ctx: providers.portless.route({
      name: "website",
      appPort: 4321,
      command: "bun run dev -- --port 4321",
    }),
  }));
```

Portless must be installed in the environment where the generated command runs.
The current Portless package requires Node.js 24 or newer:

```bash
npm install -g portless
```

For a root-owned development VM, HTTP on port 80 avoids transporting a
machine-local Portless CA through the remote browser proxy. Local workflows can
keep the provider defaults for HTTPS on port 443.
