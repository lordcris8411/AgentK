import type { ClientSettings } from "./types.js";

export function windowsTerminalInitialization(
  charset: ClientSettings["terminalCharset"],
): string {
  const codePage = charset === "gbk" ? 936 : 65001;
  return [
    `[Console]::InputEncoding=[System.Text.Encoding]::GetEncoding(${codePage})`,
    `[Console]::OutputEncoding=[System.Text.Encoding]::GetEncoding(${codePage})`,
    `$OutputEncoding=[System.Text.Encoding]::GetEncoding(${codePage})`,
    `chcp ${codePage} > $null`,
  ].join("; ");
}

/**
 * Agent K's Starship profile uses an Agent K-reserved indexed accent and ANSI
 * color names rather than literal RGB values. xterm can then map every prompt
 * segment through the active theme instead of inheriting fixed host colors.
 */
export const agentKStarshipConfig = `command_timeout = 3000

format = """
[░▒▓](fg:16)\\
$os\\
$directory\\
[](fg:16 bg:bright-black)\\
$git_branch\\
$git_status\\
[](fg:bright-black)\\
$fill\\
$status\\
$cmd_duration
$character"""

[fill]
symbol = " "

[directory]
style = "fg:17 bg:16"
format = "[ $path ]($style)"
truncation_length = 4
truncation_symbol = "…/"

[git_branch]
symbol = " "
style = "fg:16 bg:bright-black"
format = "[ $symbol$branch ]($style)"

[git_status]
style = "fg:bright-yellow bg:bright-black"
format = "[ $all_status$ahead_behind ]($style)"

[status]
disabled = false
style = "fg:bright-white bg:black"
success_symbol = "  "
symbol = "  "
not_executable_symbol = "  "
not_found_symbol = "  "
map_symbol = true
format = "[$symbol]($style)"

[cmd_duration]
disabled = false
min_time = 0
show_milliseconds = true
style = "fg:bright-white bg:black"
format = "[ $duration ]($style)"

[character]
success_symbol = "[ ](bold fg:16)"
error_symbol = "[ ](bold bright-red)"

[os]
disabled = false
style = "fg:17 bg:16"
format = "[ $symbol]($style)"

[os.symbols]
Linux = " "
Fedora = " "
Nobara = " "
Ubuntu = " "
Debian = " "
Arch = " "
Windows = "󰍲 "
Macos = " "
Unknown = " "
`;

/**
 * Bash normally receives LS_COLORS from the host distribution after it starts,
 * which can hard-code directory blue. Source the user's normal configuration
 * first, then change only the directory entry to an ANSI color controlled by
 * Agent K's terminal palette. USER_LS_COLORS preserves it in nested shells on
 * distributions whose /etc/profile.d/colorls.sh honours that convention.
 */
export const agentKBashRcConfig = `if [ -r "\${HOME}/.bashrc" ]; then
  . "\${HOME}/.bashrc"
fi

_agent_k_ls_colors=""
_agent_k_has_directory_color=""
IFS=: read -r -a _agent_k_color_entries <<< "\${LS_COLORS:-}"
for _agent_k_color_entry in "\${_agent_k_color_entries[@]}"; do
  [ -n "\${_agent_k_color_entry}" ] || continue
  case "\${_agent_k_color_entry}" in
    di=*)
      _agent_k_color_entry="di=01;38;5;16"
      _agent_k_has_directory_color=1
      ;;
  esac
  _agent_k_ls_colors="\${_agent_k_ls_colors:+\${_agent_k_ls_colors}:}\${_agent_k_color_entry}"
done
if [ -z "\${_agent_k_has_directory_color}" ]; then
  _agent_k_ls_colors="\${_agent_k_ls_colors:+\${_agent_k_ls_colors}:}di=01;38;5;16"
fi
export LS_COLORS="\${_agent_k_ls_colors}"
export USER_LS_COLORS=1
unset _agent_k_color_entries _agent_k_color_entry _agent_k_has_directory_color _agent_k_ls_colors
`;
