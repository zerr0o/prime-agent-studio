"""Studio kernel compatibility overlay: backport upstream PR2372 into NEW venvs only.

Applies the official Prime Agent PR2372 fix (synchronous ``bash.consumed``
frame before the cell ``done`` frame) to the ``rlm/bash.py`` installed inside
a freshly created Studio kernel venv, before validation and marker publication.

Strict safety rules:
- Never touches the shipped engine source, only the venv copy resolved from
  the running interpreter (contained in ``sys.prefix``).
- Exact-match patching only: the unpatched 0.9.5 block must match byte for
  byte (after universal-newline read); any unrecognized form fails closed.
  The fixed section requires module-level functools/uuid imports; a fixed
  section with missing imports is repaired (imports only) or reported.
- Idempotent: an already-fixed file with required imports is left unchanged.
- Read-only probe mode (``--check-only``) never writes.
- External ``PRIME_AGENT_KERNEL_PYTHON`` interpreters are never patched by the
  Studio; use ``--check-only`` with that interpreter to validate.

Upstream: https://github.com/PrimeIntellect-ai/prime-agent/pull/2372
Engine without the fix: 0.9.5 (released before the merge).
"""

from __future__ import annotations

import argparse
import ast
import json
import os
import sys
import textwrap
from pathlib import Path

COMPAT_VERSION = "pr2372-v1"

SECTION_START = "    def _arm_consumed_notice"
SECTION_END = "    async def _wait_reaped"
# Exact unpatched block from prime-agent 0.9.5 (up to but excluding _wait_reaped).
EXPECTED_OLD_BLOCK = '''    def _arm_consumed_notice(self, command: str) -> None:
        # Armed only post-acceptance: the withdrawal can never overtake its notice.
        loop = asyncio.get_running_loop()

        def dispatch() -> None:
            def start() -> None:
                task = loop.create_task(self._notify_result_consumed(command))
                task.add_done_callback(_consume_notice_task)

            try:
                loop.call_soon_threadsafe(start)
            except RuntimeError:
                pass  # notifying loop already closed

        with self._callback_lock:
            if not self._result_consumed:
                self._consumed_notice = dispatch
                return
        dispatch()

    async def _notify_result_consumed(self, command: str) -> None:
        from . import repl

        if not repl.is_active():
            return
        try:
            await repl.host_request(
                {"type": "bash.consumed", "pid": self._pid, "command": command}
            )
        except (OSError, RuntimeError):
            return  # bridge closed at teardown; old hosts error-reply — both fine

'''
# Exact replacement per upstream PR2372 (same span).
EXPECTED_NEW_BLOCK = '''    def _arm_consumed_notice(self, command: str) -> None:
        # Armed only post-acceptance: the withdrawal can never overtake its notice.
        dispatch = functools.partial(self._notify_result_consumed, command)

        with self._callback_lock:
            if not self._result_consumed:
                self._consumed_notice = dispatch
                return
        dispatch()

    def _notify_result_consumed(self, command: str) -> None:
        """Ship the withdrawal inside the read, ahead of the cell's done event.

        The host delivers a queued notice at the reading cell's turn boundary,
        which begins when that cell's done event is processed: a withdrawal
        frame that leaves the kernel after done arrives too late, and the stale
        notice wakes the model anyway. Reads happen inside a live cell, so
        writing the frame right here puts it ahead of done on the wire, where
        the host must withdraw before it can dispatch. The reply never matters
        (unknown reply ids are dropped), so the request is fire-and-forget:
        no future to await, no event-loop hop that could run after the cell.
        """
        from . import repl

        if not repl.is_active():
            return
        repl._send(
            {
                "event": "host_request",
                "id": uuid.uuid4().hex,
                "data": {"type": "bash.consumed", "pid": self._pid, "command": command},
            }
        )

'''


def _section_bounds(text):
    """Locate the consumption-notice section; fail closed when absent."""
    start = text.find(SECTION_START)
    if start < 0:
        raise ValueError("KERNEL_COMPAT_UNRECOGNIZED: _arm_consumed_notice not found")
    end = text.find(SECTION_END, start)
    if end < 0:
        raise ValueError("KERNEL_COMPAT_UNRECOGNIZED: _wait_reaped boundary not found")
    return start, end


def is_patched_section(section):
    if section == EXPECTED_NEW_BLOCK:
        return True
    return _is_structurally_fixed(section)


def _is_structurally_fixed(section):
    """Accept cosmetic changes only, not a different withdrawal mechanism.

    Compare the whole AST with the upstream fix. Checking for marker strings
    would accept an early return or a deferred send that never withdraws the
    notice during result consumption. Comments, whitespace and function
    docstrings do not affect this compatibility check.
    """
    def normalized(source):
        module = ast.parse(textwrap.dedent(source))
        for node in ast.walk(module):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                if (node.body and isinstance(node.body[0], ast.Expr)
                        and isinstance(node.body[0].value, ast.Constant)
                        and isinstance(node.body[0].value.value, str)):
                    node.body = node.body[1:]
        return ast.dump(module, include_attributes=False)

    try:
        return normalized(section) == normalized(EXPECTED_NEW_BLOCK)
    except SyntaxError:
        return False


def is_unpatched_section(section):
    return (
        "async def _notify_result_consumed" in section
        and "loop.call_soon_threadsafe(start)" in section
        and "await repl.host_request(" in section
        and "functools.partial(self._notify_result_consumed, command)" not in section
    )


def classify(text):
    """Return patched or unpatched, else raise on unrecognized form."""
    start, end = _section_bounds(text)
    section = text[start:end]
    if is_patched_section(section):
        return "patched"
    if section == EXPECTED_OLD_BLOCK and is_unpatched_section(section):
        return "unpatched"
    if is_unpatched_section(section):
        raise ValueError(
            "KERNEL_COMPAT_UNRECOGNIZED: _arm_consumed_notice/_notify_result_consumed "
            "differs from the supported 0.9.5 form; refusing blind patch"
        )
    raise ValueError(
        "KERNEL_COMPAT_UNRECOGNIZED: consumption-notice section matches neither "
        "the supported unpatched form nor a fixed form"
    )


def _missing_imports(text):
    """Stdlib imports the fixed section needs at module level."""
    missing = []
    for name in ("functools", "uuid"):
        if "\nimport " + name + "\n" not in text and not text.startswith("import " + name + "\n"):
            missing.append(name)
    return missing


def _ensure_import(text, name):
    if name not in _missing_imports(text):
        return text
    for anchor in ("\nimport time\n", "\nimport sys\n"):
        if anchor in text:
            return text.replace(anchor, anchor[:-1] + "\nimport " + name + "\n", 1)
    raise ValueError("KERNEL_COMPAT_UNRECOGNIZED: no anchor to add missing import " + name)


def _ensure_fixed_imports(text):
    for name in ("functools", "uuid"):
        text = _ensure_import(text, name)
    ast.parse(text)
    return text


def apply_patch(text):
    start, end = _section_bounds(text)
    section = text[start:end]
    if section != EXPECTED_OLD_BLOCK:
        raise ValueError(
            "KERNEL_COMPAT_UNRECOGNIZED: refusing to patch an unrecognized "
            "consumption-notice section"
        )
    patched = text[:start] + EXPECTED_NEW_BLOCK + text[end:]
    patched = _ensure_fixed_imports(patched)
    return patched


def locate_venv_bash():
    try:
        import importlib as _locate_il
        # Never "import rlm.bash as name": rlm/__init__.py re-exports a bash()
        # function that shadows the submodule attribute, so the as-form binds
        # the function instead of the module. import_module returns sys.modules.
        bash_mod = _locate_il.import_module("rlm.bash")
        repl_mod = _locate_il.import_module("rlm.repl")
    except ImportError as error:
        raise RuntimeError("KERNEL_COMPAT_NO_RUNTIME: cannot import rlm.bash: " + str(error)) from error
    if not hasattr(repl_mod, "_send"):
        raise RuntimeError(
            "KERNEL_COMPAT_INCOMPATIBLE: this engine has no repl._send; "
            "the PR2372 backport does not apply"
        )
    raw = getattr(bash_mod, "__file__", None)
    if not raw:
        raise RuntimeError("KERNEL_COMPAT_NO_RUNTIME: rlm.bash has no __file__")
    path = Path(raw).resolve()
    prefix = Path(sys.prefix).resolve()
    try:
        path.relative_to(prefix)
    except ValueError:
        raise RuntimeError(
            "KERNEL_COMPAT_OUTSIDE_VENV: " + str(path) + " is not inside " + str(prefix) + "; "
            "refusing to touch the shipped engine source"
        ) from None
    if path.suffix != ".py":
        raise RuntimeError("KERNEL_COMPAT_UNRECOGNIZED: unexpected runtime file " + str(path))
    return path


def _write_verified(path, text):
    tmp = path.with_name(path.name + '.' + str(os.getpid()) + '.tmp')
    tmp.write_text(text, encoding="utf-8", newline="\n")
    os.replace(tmp, path)
    reread = path.read_text(encoding="utf-8")
    if classify(reread) != "patched" or _missing_imports(reread):
        raise RuntimeError("KERNEL_COMPAT_FAILED: post-patch verification failed")


def patch_file(path, check_only):
    """Patch or probe. Returns (status, detail) with status in already-patched, needs-patch, patched."""
    text = path.read_text(encoding="utf-8")
    status = classify(text)
    if status == "patched":
        missing = _missing_imports(text)
        if not missing:
            ast.parse(text)
            return ("already-patched", "fixed form with required imports")
        if check_only:
            return ("needs-patch", "fixed section but missing imports: " + ",".join(missing))
        _write_verified(path, _ensure_fixed_imports(text))
        return ("patched", "repaired missing imports: " + ",".join(missing))
    if check_only:
        return ("needs-patch", "supported unpatched form, patch required")
    _write_verified(path, apply_patch(text))
    return ("patched", "applied PR2372 backport")


def main(argv=None):
    """Apply the overlay, or probe read-only with --check-only (never writes)."""
    parser = argparse.ArgumentParser(description='Apply/check the PR2372 kernel compat overlay.')
    parser.add_argument('--check-only', action='store_true', help='Read-only probe, never writes.')
    parser.add_argument('--file', default=None, help='Patch an explicit fixture file (tests only).')
    parser.add_argument('--json', action='store_true', help='Print a JSON result line.')
    args = parser.parse_args(argv)
    try:
        path = Path(args.file).resolve() if args.file else locate_venv_bash()
    except (RuntimeError, ValueError) as error:
        print(str(error), file=sys.stderr)
        return 1
    if args.file and not path.is_file():
        print("KERNEL_COMPAT_UNRECOGNIZED: fixture file not found: " + str(path), file=sys.stderr)
        return 1
    try:
        result, detail = patch_file(path, args.check_only)
    except ValueError as error:
        print(str(error), file=sys.stderr)
        return 1
    except (OSError, RuntimeError, SyntaxError) as error:
        print("KERNEL_COMPAT_FAILED: " + str(error), file=sys.stderr)
        return 1
    if result == "needs-patch":
        print("KERNEL_COMPAT_UNPATCHED: " + detail, file=sys.stderr)
        if args.json:
            print(json.dumps({"compat": COMPAT_VERSION, "status": result, "detail": detail, "file": str(path)}))
        return 2
    if args.json:
        print(json.dumps({"compat": COMPAT_VERSION, "status": result, "detail": detail, "file": str(path)}))
    else:
        print("kernel-compat " + COMPAT_VERSION + ": " + result + " " + str(path))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

