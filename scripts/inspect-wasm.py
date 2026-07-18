#!/usr/bin/env python3
"""List wasm section IDs and sizes.

MVP sections are IDs 0-11. Anything > 11 is post-MVP and Chromium 68 rejects
it. Common offenders: 12=DataCount (bulk memory), 13=Tag (exception handling).

Usage: inspect-wasm.py <path/to/file.wasm>
"""
import os
import sys

NAMES = {
    0: "Custom", 1: "Type", 2: "Import", 3: "Function",
    4: "Table", 5: "Memory", 6: "Global", 7: "Export",
    8: "Start", 9: "Element", 10: "Code", 11: "Data",
    12: "DataCount", 13: "Tag",
}


def read_leb(fp):
    value = 0
    shift = 0
    result = 0
    done = False
    while not done:
        byte = fp.read(1)
        if not byte:
            result = value
            done = True
        else:
            b = byte[0]
            value |= (b & 0x7F) << shift
            shift += 7
            if not (b & 0x80):
                result = value
                done = True
    return result


def read_custom_name(fp, section_size):
    name_len = read_leb(fp)
    consumed = 0
    name = ""
    if name_len <= section_size:
        raw = fp.read(name_len)
        name = raw.decode("utf-8", errors="replace")
        consumed = name_len
    return name, consumed


def main(argv):
    exit_code = 0
    if len(argv) != 2:
        sys.stderr.write("usage: inspect-wasm.py <file.wasm>\n")
        exit_code = 2
    else:
        path = argv[1]
        size = os.path.getsize(path)
        print(f"file: {path} ({size} bytes)")
        with open(path, "rb") as f:
            header = f.read(8)
            if header[:4] != b"\x00asm":
                sys.stderr.write("not a wasm file\n")
                exit_code = 1
            else:
                keep_going = True
                while keep_going:
                    marker = f.tell()
                    sid_byte = f.read(1)
                    if not sid_byte:
                        keep_going = False
                    else:
                        sid = sid_byte[0]
                        sz = read_leb(f)
                        body_start = f.tell()
                        label = NAMES.get(sid, f"unknown({sid})")
                        tag = "" if sid <= 11 else "  <-- POST-MVP"
                        extra = ""
                        if sid == 0:
                            name, consumed = read_custom_name(f, sz)
                            extra = f"  name='{name}'"
                            remaining = sz - consumed
                            f.seek(remaining, 1)
                        else:
                            f.seek(sz, 1)
                        print(
                            f"  @{marker:>7}  id={sid:>2}  {label:<10}"
                            f"  size={sz}{extra}{tag}"
                        )
    sys.exit(exit_code)


if __name__ == "__main__":
    main(sys.argv)
