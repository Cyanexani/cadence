# rquickjs-sys 0.9.0 with Android bindings added

Copy of the crates.io release, used through `[patch.crates-io]` in ../../Cargo.toml.

rquickjs-sys ships pre-generated bindings for Linux, macOS and Windows but not Android, so the
Android build failed. The `*-linux-android.rs` files here are copies of the matching
`*-unknown-linux-gnu.rs` bindings: QuickJS's C API only uses fixed-size and pointer types, and the
glibc and musl bindings for the same CPU are already byte-identical, so the C library doesn't
change them. Drop this folder once rustypipe moves to an rquickjs release that ships Android bindings.
