# Altbase Tron module

Independent module repository for Tron. Releases are published here, separately from the wallet application. The wallet source includes this repository as a Git submodule.

## Version 0.1.6

The archive includes Linux x64 `.so`, Windows x64 `.dll` and universal macOS x64/ARM64 `.dylib` programs, manifests and icons. macOS programs have certificate-free ad-hoc signatures. No owner wallet source or private credentials are included.

Native balances and added tokens use the account SDK distributed in the parent wallet. Token contracts or mints can be added manually; icons are fetched on demand and spam tokens remain hidden until enabled. Public RPC limitations can prevent complete automatic token discovery; an unavailable query must not be reported as a verified zero balance.

Build the parent wallet account packages on Linux with one CPU using `node scripts/build-account-modules.mjs --macos`. This repository contains the adapter source; shared SDK and package tooling are in the parent wallet repository.
