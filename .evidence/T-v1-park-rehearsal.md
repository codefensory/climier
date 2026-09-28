# T-v1-park-rehearsal evidence

- Run copy/home: `/tmp/climier-v1-park-rehearsal-20260928` / `/tmp/climier-v1-park-rehearsal-20260928/home`
- Source commit: `5d7288cb679b41e43fa41d9716157b728deb5106`
- Writers: stopped for the isolated copy (no writer processes started).
- Route guard: every project state path printed and asserted beneath the temporary `CLIMIER_HOME` before the first CLI command.
- Real home guard: all 41 real state and ledger hashes equal the copy baseline (`REAL_HOME_ASSERT projects=41 changed=0`).

## Commands and assertions

- Linked isolated binary: `bin/climier` -> worktree `bin/climier.mjs`; `--version` => `1.0.0`.
- `migrate --all --dry-run`: 41 projects; forms: 27 legacy-v2, 4 legacy-v4, 3 fenced-legacy, 5 pre-release, 1 canonical; all node/log counts recorded.
- `migrate --all`: 41 projects, no errors; all readable canonical v1.
- Per-project read: `status --all` succeeded for all 41.
- Authorized mutation: one `add-note` on populated projects or `add-initiative` on empty projects; 41/41 revisions advanced and ledger high-water matched.
- Second `migrate --all`: state and ledger bytes unchanged for 41/41.
- Backup rollback: 40 migrated projects restored from their latest `home/backups/<project_id>/<timestamp>/`; state bytes and ledger presence/content matched backup. `d8c9827538d709c0` was already canonical and had no migration backup.
- Re-import after rollback: 41/41 no errors; final idempotence run changed 0 state/ledger bytes.

## Per-project report

| project | source form | source nodes/log | post revision | backup restore |
| --- | --- | ---: | ---: | --- |
| `139869a92d470381` | legacy-v2 v2 2/4 | 2/4 | 5 | restored |
| `13bf1aadf3fb5880` | legacy-v2 v2 0/0 | 0/0 | 3 | restored |
| `164f559f2fc74eaa` | legacy-v2 v2 0/0 | 0/0 | 3 | restored |
| `175cb67df16ccf82` | legacy-v2 v2 5/25 | 5/25 | 5 | restored |
| `1e60ebff84fadc83` | legacy-v2 v2 0/0 | 0/0 | 3 | restored |
| `2130e77399a5c52f` | legacy-v2 v2 0/0 | 0/0 | 3 | restored |
| `24da8bbc4aa983f2` | legacy-v2 v2 0/0 | 0/0 | 3 | restored |
| `266aa55977f46709` | legacy-v2 v2 0/0 | 0/0 | 3 | restored |
| `294f34b5d54593ea` | legacy-v2 v2 1/3 | 1/3 | 6 | restored |
| `2c05bae18356d403` | legacy-v2 v2 1/1 | 1/1 | 4 | restored |
| `2ccf2fd71439da0c` | legacy-v2 v2 0/0 | 0/0 | 3 | restored |
| `314e90a11c70fbab` | legacy-v2 v2 1/3 | 1/3 | 6 | restored |
| `31785b5dfa7e46cd` | legacy-v2 v2 1/3 | 1/3 | 6 | restored |
| `354e81afbcb2dd7e` | pre-release v1 0/0 | 0/0 | 3 | restored |
| `45ebde42cde1179c` | pre-release v1 0/0 | 0/0 | 3 | restored |
| `49657afddf3dbe53` | legacy-v2 v2 1/1 | 1/1 | 4 | restored |
| `4a696d4ffbeb0a1d` | legacy-v2 v2 1/1 | 1/1 | 4 | restored |
| `4c774f58117ef42d` | legacy-v2 v2 1/1 | 1/1 | 4 | restored |
| `4d81d39869c09aab` | legacy-v4 v4 6/46 | 6/46 | 49 | restored |
| `4f466ca13f3b818b` | legacy-v2 v2 1/1 | 1/1 | 4 | restored |
| `51b6b7d3c5226123` | legacy-v4 v4 0/0 | 0/0 | 3 | restored |
| `5594846ea493cf71` | legacy-v2 v2 0/0 | 0/0 | 3 | restored |
| `64fe37114350ac23` | legacy-v4 v4 140/1375 | 140/1375 | 1379 | restored |
| `66c49a21c59207c4` | pre-release v1 0/0 | 0/0 | 3 | restored |
| `6ebf55231aa345ea` | legacy-v4 v4 0/0 | 0/0 | 3 | restored |
| `710ea7e03cb88d75` | legacy-v2 v2 1/3 | 1/3 | 6 | restored |
| `91026daf54d00345` | legacy-v2 v2 0/0 | 0/0 | 3 | restored |
| `9e8202dbd8499ca8` | legacy-v2 v2 0/0 | 0/0 | 3 | restored |
| `a576d5fbb37e00ff` | legacy-v2 v2 2/8 | 2/8 | 9 | restored |
| `a73393f14c9e3673` | legacy-v2 v2 0/0 | 0/0 | 3 | restored |
| `abbb4acc-2e38-4105-a609-096d195be29e` | fenced-legacy v5 262/1718 | 262/1718 | 152 | restored |
| `aeb826d103c1a63c` | legacy-v2 v2 1/3 | 1/3 | 6 | restored |
| `b4e2c579bbb81669` | fenced-legacy v5 547/4579 | 547/4579 | 2680 | restored |
| `c6577f6cf404c54c` | fenced-legacy v5 103/1298 | 103/1298 | 1301 | restored |
| `cb26799a981b3869` | legacy-v2 v2 2/3 | 2/3 | 4 | restored |
| `cb416871eca3f761` | legacy-v2 v2 0/0 | 0/0 | 3 | restored |
| `d66d2cd17a0d6081` | legacy-v2 v2 0/0 | 0/0 | 3 | restored |
| `d8c9827538d709c0` | canonical v1 0/0 | 0/0 | 2 | canonical/no-op |
| `f2c5becc98ab2f33` | legacy-v2 v2 1/1 | 1/1 | 4 | restored |
| `f757f8f7a4b61b12` | pre-release v1 0/0 | 0/0 | 3 | restored |
| `ff2a90b291b715c6` | legacy-v2 v2 91/717 | 91/717 | 20 | restored |
