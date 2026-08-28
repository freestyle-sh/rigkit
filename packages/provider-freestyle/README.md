# @rigkit/provider-freestyle

Freestyle provider integration for `rig`.

This package supplies:

- `freestyle.provider(...)` for host Freestyle authentication
- `freestyle.terminal()` for provider-owned browser terminal sessions targeting Freestyle VMs
- `providers.freestyle.client` for direct access to the authenticated Freestyle SDK client
- `providers.freestyle.terminal.open(...)` for interactive browser terminals backed directly by the VM PTY API
- `providers.freestyle.createSSHOptions(...)` for VM SSH connection options with provider-owned auth handled internally
- `providers.freestyle.cmux.createSshOptions(...)` and `providers.freestyle.vscode.createUrl(...)` adapter helpers
- Freestyle-specific JSON state helpers backed by Rigkit provider storage

Use `vm.exec(...)` inside workflow tasks to install VM dependencies before taking a snapshot. Console output inside a task handler is intercepted by the Rigkit runtime and emitted as leveled `log.output` events.

Built against the Freestyle v2 SDK (`freestyle@^0.2`): VM creates require an explicit `firewall` block, SSH goes through `beta-ssh.freestyle.sh` with identity-scoped access tokens, and browser-authenticated sessions talk to the API directly with a Stack access token scoped by team.

By default the provider authenticates through a browser login and stores Freestyle credentials in Rigkit's provider host storage, outside project `.rigkit/state.sqlite`. Pass `freestyle.provider({ apiKey })` or `freestyle.provider(apiKey)` to use API-key auth instead.
