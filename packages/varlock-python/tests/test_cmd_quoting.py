"""Windows command-line quoting.

These run on every platform: the functions under test build a string, they don't execute it.
"""

from __future__ import annotations

import subprocess

import pytest

from varlock._cli import build_cmd_shim_command, quote_for_cmd

CMD_METACHARS = ["&", "|", "<", ">", "^", "(", ")"]


@pytest.mark.parametrize("meta", CMD_METACHARS)
def test_metacharacters_end_up_inside_quotes(meta):
    # cmd.exe only treats these specially outside quotes, so quoting neutralizes them
    quoted = quote_for_cmd(f"a{meta}b")
    assert quoted == f'"a{meta}b"'


@pytest.mark.parametrize("meta", CMD_METACHARS)
def test_a_metacharacter_in_an_argument_cannot_start_a_second_command(meta):
    command = build_cmd_shim_command(
        r"C:\shims\varlock.cmd", ["load", "--path", f"a{meta}calc"]
    )
    # the payload is quoted, so cmd.exe reads it as one literal argument
    assert f'"a{meta}calc"' in command
    # and it never appears bare, which is what would have been parsed as a separator
    assert f" a{meta}calc" not in command


def test_a_metacharacter_in_the_binary_path_is_quoted_too():
    # an install path like C:\dev&tools\ is enough on its own, with no user arguments
    command = build_cmd_shim_command(r"C:\dev&tools\varlock.cmd", ["load"])
    assert r'"C:\dev&tools\varlock.cmd"' in command


def test_uses_the_slash_s_form_so_cmd_strips_only_the_outer_quotes():
    command = build_cmd_shim_command(r"C:\shims\varlock.cmd", ["load"], comspec="cmd.exe")
    assert command.startswith('"cmd.exe" /d /s /c "')
    assert command.endswith('"')


def test_respects_comspec():
    command = build_cmd_shim_command("x.cmd", [], comspec=r"C:\Windows\System32\cmd.exe")
    assert command.startswith(r'"C:\Windows\System32\cmd.exe" /d /s /c ')


@pytest.mark.parametrize(
    "arg",
    [
        "plain with space",
        r"C:\Program Files (x86)\varlock\varlock.cmd",
        'has "quotes" inside',
        r"trailing backslash\\",
        r"back\\slash\"quote",
        "",
    ],
)
def test_matches_the_stdlib_algorithm_where_the_stdlib_also_quotes(arg):
    # list2cmdline quotes anything containing whitespace (and the empty string), so for those
    # the two must agree exactly - that pins our escaping to CPython's implementation
    expected = subprocess.list2cmdline([arg])
    if expected.startswith('"'):
        assert quote_for_cmd(arg) == expected


def _parse_msvcrt(command_line: str) -> list:
    """Split a command line the way CommandLineToArgvW does, so quoting can be checked.

    Rules: 2n backslashes before a quote produce n backslashes and toggle quoting; 2n+1
    produce n backslashes and a literal quote; backslashes not before a quote are literal.
    """
    args, current, backslashes, in_quotes, started = [], [], 0, False, False
    for char in command_line:
        if char == "\\":
            backslashes += 1
            continue
        if char == '"':
            current.append("\\" * (backslashes // 2))
            if backslashes % 2:
                current.append('"')
            else:
                in_quotes = not in_quotes
                started = True
            backslashes = 0
            continue
        current.append("\\" * backslashes)
        backslashes = 0
        if char.isspace() and not in_quotes:
            if current or started:
                args.append("".join(current))
            current, started = [], False
            continue
        current.append(char)
    current.append("\\" * backslashes)
    if current or started:
        args.append("".join(current))
    return args


@pytest.mark.parametrize(
    "arg",
    [
        'a"b',
        r"c:\path\\",
        'ends with quote"',
        r"^&|<>()",
        r"C:\Program Files (x86)\a & b\varlock.cmd",
        "--path",
        "",
    ],
)
def test_quoted_arguments_decode_back_to_the_original(arg):
    assert _parse_msvcrt(quote_for_cmd(arg)) == [arg]


def test_the_decoder_agrees_with_the_stdlib_on_multi_argument_lines():
    # sanity-checks the decoder itself before trusting it above
    args = [r"C:\Program Files\x.cmd", "load", 'a"b', r"trail\\"]
    assert _parse_msvcrt(subprocess.list2cmdline(args)) == args


def test_a_full_shim_command_decodes_to_the_intended_argv():
    binary = r"C:\dev&tools\varlock.cmd"
    args = ["load", "--path", "a&calc"]
    command = build_cmd_shim_command(binary, args, comspec="cmd.exe")
    shell, flag_d, flag_s, flag_c, rest = command.split(" ", 4)
    assert (flag_d, flag_s, flag_c) == ("/d", "/s", "/c")
    # cmd /s strips the outer quote pair, leaving the individually quoted tokens
    assert rest.startswith('"') and rest.endswith('"')
    assert _parse_msvcrt(rest[1:-1]) == [binary, *args]
