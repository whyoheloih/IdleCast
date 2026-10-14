# IdleCast repository instructions

## Versioning

Every commit pushed to this repository must increase the application version. The major version stays at `1`.

- Significant feature: increment the middle number and reset the last number to zero. Example: `1.5.4` becomes `1.6.0`.
- Bug fix or minor addition: increment the last number. Example: `1.5.1` becomes `1.5.2`.
- Documentation, workflow, maintenance, and other repository-only commits also require at least a patch increment because the rule applies to every commit.
- Never reuse or decrease a released version.

Each commit must keep these version surfaces consistent:

1. `package.json`
2. `server/version.ts`
3. The newest entry in `server/updates.ts`
4. Release workflow filenames, artifact names, tags, and notes when publishing an EXE

Group related file changes into one commit so one version identifies one complete change set.
