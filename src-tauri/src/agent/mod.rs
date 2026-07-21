//! Pi integration boundary.
//!
//! This module owns the external `pi --mode rpc` child process, strict LF JSONL
//! framing, command correlation, and forwarding validated events to the WebView.
//! Pi is a separately installed runtime; no Pi source is compiled into AgentK.

pub mod rpc;
