# v1 state-park verification for importer retirement

- Verified at: `2026-10-10T05:32:50Z`
- Scope: every project returned by `listProjectIds()` under the default `CLIMIER_HOME` (`/home/yeferson/.climier/projects`).
- Method: read-only scan; classified each `tasks.json` with `classifyStateShape`, validated the matching ledger with `assertValidLedger` and `assertFencedState`, checked that no project lock was present before or after reading, and confirmed both file hashes were stable across a second read. No project files were changed.
- Result: 2 projects checked; 0 pre-canonical projects (forms 2/3/4 or prehistoric); both state files are canonical schema 1. Hashes below cover the raw files verified.

| Project ID | Form | Nodes | State revision | `tasks.json` SHA-256 | `revision-ledger.json` SHA-256 |
|---|---:|---:|---:|---|---|
| `b4e2c579bbb81669` | canonical v1 | 594 | 3063 | `016ccb14e4e8627c5055ac7e96887df68591efc4e234cdc7ece1681d9bfe41da` | `775b85fb2d216c551c91c44a18894cde7a1da88b521848117379929e43c7a725` |
| `c6577f6cf404c54c` | canonical v1 | 138 | 1648 | `b174edbb93c6447f22d18d7af44cd2231f5f4d7bb4bc61b182a1d4fe092e4750` | `a29acdef8ff71be7ae196f14c408ec2e387b3fa63888496806b60a111da8f2a1` |

The orchestrator's task-context note records the completed operational window and the pre-retirement offline detector result. It also records that `climier migrate --all --dry-run` against the remote backend returned `REMOTE_UNSUPPORTED_OPERATION`; this report therefore does not claim that the retired CLI command ran successfully. This verification supplements that record with current canonical-state/ledger checks and raw-file hashes.
