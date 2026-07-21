# Security Policy

AgentK runs an external Pi process with the permissions of the local user. Its approval UI is not an operating-system sandbox;
use a container or virtual machine when stronger isolation is required.

Report AgentK vulnerabilities privately through GitHub Security Advisories for `lordcris8411/AgentK`. Report issues in the Pi
runtime itself according to the upstream [Pi security policy](https://github.com/earendil-works/pi/blob/main/SECURITY.md).
