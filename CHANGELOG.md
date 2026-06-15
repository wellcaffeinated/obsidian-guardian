# Changelog

## [0.2.1](https://github.com/wellcaffeinated/obsidian-guardian/compare/obsidian-guardian-v0.2.0...obsidian-guardian-v0.2.1) (2026-06-15)


### Bug Fixes

* **plugin:** serialize engine ops, add loading/error panel states, refresh deferred leaves ([28178a2](https://github.com/wellcaffeinated/obsidian-guardian/commit/28178a2375ed4daeadb73c5e070cae0530b79679))
* remove unneeded settings ([090d9b9](https://github.com/wellcaffeinated/obsidian-guardian/commit/090d9b9979968c042d1ad3d0d3cd78d19e4e87bb))


### Performance

* **engine,plugin:** defer per-checkpoint diffs + prime index in timeline() ([c3591b0](https://github.com/wellcaffeinated/obsidian-guardian/commit/c3591b061c29d08b5972d44d5285b776a79acd9e))

## [0.2.0](https://github.com/wellcaffeinated/obsidian-guardian/compare/obsidian-guardian-v0.1.0...obsidian-guardian-v0.2.0) (2026-06-13)


### Features

* add screenshot scripts ([ec4d9c7](https://github.com/wellcaffeinated/obsidian-guardian/commit/ec4d9c7de3e88e9a986d66b53c1500181e244cdd))
* add screenshot scripts ([78af565](https://github.com/wellcaffeinated/obsidian-guardian/commit/78af565cd243038a163b22731f40edcf0a3b86a5))
* bless via frontmatter and checkpoints in docker version ([720c93f](https://github.com/wellcaffeinated/obsidian-guardian/commit/720c93f0e100ac7b928b17f074707d4646c2f7dd))
* **cli:** og exec shim + refresh review note after mutations ([9ab75fa](https://github.com/wellcaffeinated/obsidian-guardian/commit/9ab75faddd4aa3c118dcd6601ea2a015939b464d))
* **cli:** thin CLI + chokidar watch adapter over the engine ([6b87d66](https://github.com/wellcaffeinated/obsidian-guardian/commit/6b87d66ac069cac6c10ae2b65eb138e6c1e2f2b2))
* dockerized demo watching an example vault ([f4c0e90](https://github.com/wellcaffeinated/obsidian-guardian/commit/f4c0e9020f7b129a4f5baf07f65f10744c5f4042))
* **engine:** composite routing fs for split worktree/gitdir backends ([6cd1ca0](https://github.com/wellcaffeinated/obsidian-guardian/commit/6cd1ca008583be5eb5a0e7b4dbe638f320d44196))
* **engine:** de-risk + enable the mobile IndexedDB object store ([0a20be0](https://github.com/wellcaffeinated/obsidian-guardian/commit/0a20be0b37a9456b28e01af57f03673f8e6841e0))
* **engine:** event-driven incremental work-tree hashing ([b446d68](https://github.com/wellcaffeinated/obsidian-guardian/commit/b446d683bf64a0d872d4f2a84a51b2b8d082ed84))
* **engine:** per-machine review note name, default folder _OG ([a6a7599](https://github.com/wellcaffeinated/obsidian-guardian/commit/a6a7599828cec11166435cddf59c0296559764d7))
* **engine:** per-path content-gated applyBless + delta bless ([2daa138](https://github.com/wellcaffeinated/obsidian-guardian/commit/2daa138093613d5d99f7bea4ccf2ddfccf5f0f11))
* **engine:** preparation for checkpoint functionality. ([3c4c845](https://github.com/wellcaffeinated/obsidian-guardian/commit/3c4c8455e95c332cd5ee02da6db9244642310489))
* **engine:** preserve pre-bless baseline as a restorable checkpoint ([66f06cd](https://github.com/wellcaffeinated/obsidian-guardian/commit/66f06cd5c494ce22a1daad675f384df3bd82713c))
* **engine:** synced signal store + ingest/recover coordination ([2f2a2d6](https://github.com/wellcaffeinated/obsidian-guardian/commit/2f2a2d625a68b3fd2357f1a6003b0347916e5a43))
* inline per-file diffs + colored stats in the review panel ([8be1388](https://github.com/wellcaffeinated/obsidian-guardian/commit/8be13885622db04923c51790c82a69a5891cddc8))
* obsidian plugin. basic functionality. ([96b57f3](https://github.com/wellcaffeinated/obsidian-guardian/commit/96b57f3358792ff3aeb4924a0a4351fe3bed9786))
* **plugin:** add snip to git diff lines ([7287632](https://github.com/wellcaffeinated/obsidian-guardian/commit/728763296a4d2b325d24094f89c1e678fcf0b393))
* **plugin:** bundle a Buffer polyfill for mobile (isomorphic-git) ([124f3a0](https://github.com/wellcaffeinated/obsidian-guardian/commit/124f3a0fb897a68ddd5e71de94602b7e074f145b))
* **plugin:** confirm-modal gate on destructive actions ([1e553a1](https://github.com/wellcaffeinated/obsidian-guardian/commit/1e553a1d1262a0fae99a545f23ee58863c91b316))
* **plugin:** construct the engine fs via createRoutingFs ([9c14c66](https://github.com/wellcaffeinated/obsidian-guardian/commit/9c14c6672435283180d6354f5b53d755b47b94b0))
* **plugin:** flat current-state header, restorable baseline card, build stamp ([21127c7](https://github.com/wellcaffeinated/obsidian-guardian/commit/21127c7d5959c45a5d3791835135a8a0668a665d))
* **plugin:** per-platform backends + mobile load-safety (isDesktopOnly:false) ([defe654](https://github.com/wellcaffeinated/obsidian-guardian/commit/defe65467658455cc6483dffc750ec13167062ac))
* **plugin:** vault-adapter fs for the mobile working tree ([035b408](https://github.com/wellcaffeinated/obsidian-guardian/commit/035b4088d35079a6c10a028239948c3133620856))
* **plugin:** wire real engine into the review panel (Phase 3 slice 1) ([a6e7a8f](https://github.com/wellcaffeinated/obsidian-guardian/commit/a6e7a8f99e3bf6a414fe462051a8bf7b6af809a7))
* reverse the diff direction in checkpoint history view ([25bfe04](https://github.com/wellcaffeinated/obsidian-guardian/commit/25bfe04ee3dc4b9e9c7f5c56c2764bb5a4379a64))


### Bug Fixes

* add test ([7a3e206](https://github.com/wellcaffeinated/obsidian-guardian/commit/7a3e206ceaf5d8531cfb0e83ee4c19c87b33adb6))
* bless on first activation ([f5d569d](https://github.com/wellcaffeinated/obsidian-guardian/commit/f5d569d8f0f53ecbeece97810945f788092e92d4))
* docker smoke test failing ([f638d9e](https://github.com/wellcaffeinated/obsidian-guardian/commit/f638d9e7d4213e17692a2d61c0f0d6ee46cba72e))
* **engine,plugin:** checkpoint dedup, remote-bless checkpoints, live history ([347f84b](https://github.com/wellcaffeinated/obsidian-guardian/commit/347f84b24a27fc9c414e3354ce0951be2dadf761))
* **engine:** stop ingest() republishing on a no-op (infinite loop) ([fbb8cfb](https://github.com/wellcaffeinated/obsidian-guardian/commit/fbb8cfb9bf1c1399433bc71ca87c8165160216a2))
* ensure tracking is opt-in and replicaId isn't synced ([84e24dc](https://github.com/wellcaffeinated/obsidian-guardian/commit/84e24dc2f4cfbc7395263e8a00e6aa9c1a97e8ea))
* plugin hanging process from workspace.json changes ([7ed2a2d](https://github.com/wellcaffeinated/obsidian-guardian/commit/7ed2a2d22b25fbc0e46263f195c083d67f526dc1))
* **plugin:** avoid returning a value from void diff-render branches ([8d0a104](https://github.com/wellcaffeinated/obsidian-guardian/commit/8d0a1046898ff1e85420a5c7c17521dab6d24e62))
* **plugin:** finally fixed the blank panel bug ([9310477](https://github.com/wellcaffeinated/obsidian-guardian/commit/931047782aeb183af4581a62ac1e7e43b82678ed))
* **plugin:** re-render review panel on active-leaf-change (deferred views) ([69b3acf](https://github.com/wellcaffeinated/obsidian-guardian/commit/69b3acf36d0277a6006bb6260c9543373a8f73cc))
* **plugin:** render the review panel under Obsidian deferred views ([5ba2158](https://github.com/wellcaffeinated/obsidian-guardian/commit/5ba21582d95a9be7cd745693dd6dc84e7eaee6d5))
* **plugin:** restore status bar; drop dead first-slice view-model ([329f4a0](https://github.com/wellcaffeinated/obsidian-guardian/commit/329f4a024bf12ecaed01f2d546c0f8cdb36fb02d))
