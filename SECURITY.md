# Security Policy

AgentK runs an external Pi process with the permissions of the local user. Its approval UI is not an operating-system sandbox;
use a container or virtual machine when stronger isolation is required.

The React renderer is sandboxed and context-isolated. Editor extensions run in unique-origin iframes without Node.js,
Electron IPC, host DOM, or direct filesystem access; all file operations cross a validated preload/main-process boundary.
Native language extensions are different: their workers have Node.js and process privileges, so Agent K discovers them only
from bundled application resources or the trusted application-data installation directory, never from an opened workspace.

Before installing a Skill, Editor extension, or native language extension, review its source and bundled runtime. Skill Hub
previews enforce bounded file counts and sizes and verify that the source hash has not changed between review and installation,
but they are not a substitute for source review. Editor sandboxing does not make the Pi process, shell commands, Skills, Pi
Extensions, or native language workers safe to run when they are untrusted.

Report AgentK vulnerabilities privately through GitHub Security Advisories for `lordcris8411/AgentK`. Report issues in the Pi
runtime itself according to the upstream [Pi security policy](https://github.com/earendil-works/pi/blob/main/SECURITY.md).
