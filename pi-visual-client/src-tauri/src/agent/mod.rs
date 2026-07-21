//! Pi integration boundary.
//!
//! Future modules will own the `pi --mode rpc` child process, strict LF JSONL
//! framing, command correlation, and forwarding validated events to the WebView.
//! Keeping this boundary in Rust prevents the renderer from directly accessing
//! local processes, credentials, or the Pi session directory.

pub mod rpc;
