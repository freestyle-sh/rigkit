# Freestyle Website Next Example

This example builds a Freestyle-backed workflow for `freestyle-sh/freestyle-website-next`.
It is intentionally split into `rigkit/lib/*` and `rigkit/tasks/*` so larger
workflows can keep provider setup, shell commands, VM helpers, and task handlers
separate from the top-level workflow definition.

The workflow:

- installs Git, GitHub CLI, Node.js 24, Bun, Portless, and build tools
- installs Codex CLI
- runs the GitHub login flow in a browser terminal
- configures Git commit author identity from the authenticated GitHub account
- clones `https://github.com/freestyle-sh/freestyle-website-next`
- runs `bun install`
- initializes Codex CLI from inside the cloned repo so its workspace trust and login prompts apply to the project folder
- snapshots the warm VM with dependencies installed and Codex configured
- passes Freestyle VM snapshot refs through JSON workflow context
- on workspace creation, forks the snapshot, starts the website dev server through Portless as a detached background process, and waits for the named route to return HTML
- opens the created workspace in cmux at `http://freestyle-website.localhost`, with Codex and a tab tailing the dev-server log
- can run Codex on a task, push the workspace branch, and open a pull request
- opens the created workspace in VS Code from the `open-vscode` workspace operation

Run from this directory:

```bash
rig plan
rig apply
rig create website-workspace
rig run website-workspace open-cmux
rig run website-workspace open-vscode
```

Freestyle auth is handled by the provider. By default Rigkit opens the Freestyle browser login.
