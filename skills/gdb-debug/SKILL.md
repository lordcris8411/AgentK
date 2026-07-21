---
name: gdb-debug
description: Debug C/C++ programs using GDB (GNU Debugger). Use when debugging segfaults, infinite loops, logic errors, memory corruption, or when stepping through native code. Supports breakpoints, watches, backtrace, register inspection, and core dump analysis.
---

# GDB Debug Skill

Debug C/C++ programs with GDB. This skill provides structured workflows for common debugging scenarios.

## Prerequisites

- `gdb` installed (`sudo apt install gdb` on Debian/Ubuntu)
- Binary compiled with `-g -O0` flags for debug symbols

## Quick Start

### Launch and run to crash

```bash
cd <project-dir> && ./scripts/gdb-run.sh <binary> [args...]
```

### Analyze a core dump

```bash
cd <project-dir> && ./scripts/gdb-core.sh <binary> <core-file>
```

### Common debugging with a helper script

```bash
cd <project-dir> && ./scripts/gdb-debug.sh <action> <binary> [args...]
```

## Debug Workflows

### 1. Find the crash location

```bash
gdb ./binary
(gdb) run [args]
(gdb) bt              # full backtrace
(gdb) bt 50           # deeper backtrace
```

Key info to extract:
- Signal that caused the crash (`SIGSEGV`, `SIGABRT`, etc.)
- Top frame function and file:line
- Register state at crash point

### 2. Set breakpoints and step through

```bash
gdb ./binary
(gdb) break main                          # by function name
(gdb) break file.c:42                     # by file:line
(gdb) break MyClass::method               # by C++ method
(gdb) break *0x4005a0                      # by address
(gdb) run
(gdb) next                                # step over (skip into functions)
(gdb) step                                # step into
(gdb) finish                              # run until current function returns
(gdb) continue                            # run to next breakpoint
(gdb) display var                         # auto-print var each step
(gdb) info locals                         # show local variables
(gdb) info args                           # show function arguments
```

### 3. Inspect memory and variables

```bash
(gdb) print var                  # print variable
(gdb) print *ptr                 # dereference pointer
(gdb) print arr[0]@10            # print 10 array elements
(gdb) x/10xw 0x7fff1234          # examine 10 words as hex at address
(gdb) x/s 0x7fff1234             # examine as string
(gdb) whatis var                 # show type
(gdb) info registers             # show all registers
(gdb) info registers rax         # show specific register
```

### 4. Watch variables

```bash
(gdb) watch var                          # data breakpoint on variable
(gdb) rwatch var                         # watch reads
(gdb) awatch var                         # watch reads and writes
(gdb) info watchpoints                   # list active watches
```

### 5. Conditional breakpoints

```bash
(gdb) break loop.c:10 if i == 42
(gdb) break process_data if strlen(data) > 1000
```

### 6. Thread debugging

```bash
(gdb) info threads          # list threads
(gdb) thread 2              # switch to thread 2
(gdb) thread apply all bt   # backtrace all threads
(gdb) break thread_func thread 2   # breakpoint on specific thread
```

### 7. Core dump analysis

```bash
gdb ./binary core.dump
(gdb) bt                    # backtrace at crash
(gdb) info locals           # local variables at crash
(gdb) list                  # source at crash point
```

### 8. Analyze heap issues

```bash
# With valgrind integration
valgrind --leak-check=full --show-leak-kinds=all ./binary [args]
```

## GDB Script Mode

For automated debugging, write a `.gdbinit` or script file:

```gdb
# debug.gdb
break main
run arg1 arg2
bt
quit
```

Execute with:
```bash
gdb -x debug.gdb ./binary
```

## Troubleshooting Checklist

| Symptom | Likely Cause | Command |
|---------|-------------|---------|
| Segfault | Null/dangling pointer | `bt`, `print *ptr` |
| Wrong output | Logic error | Set BP, `step`, inspect vars |
| Infinite loop | Bad loop condition | `bt`, `display i`, `step` |
| Heap corruption | Buffer overflow | `valgrind`, check array bounds |
| Race condition | Thread issue | `thread apply all bt` |
| Memory leak | Missing free/delete | `valgrind --leak-check=full` |

## Tips

- Compile with `-g -O0 -fsanitize=address` for AddressSanitizer (better than GDB for memory bugs)
- Use `catch throw` to catch C++ exceptions
- Use `info breakpoints` to list all breakpoints
- Use `delete` to remove breakpoints by number
- Use `set print pretty on` for formatted output
- Use `layout src` for TUI mode (source + console split)
