# mend

One patch tool for every AI edit format.

`mend` is a command-line tool that applies an AI-written edit to a tree of
text files. It reads one patch in one of four formats — unified diff,
SEARCH/REPLACE blocks, the V4A patch format, or JSON text-editor tool calls —
finds the lines each edit names (exactly, then ignoring trailing whitespace,
then ignoring leading and trailing whitespace with re-indentation), and
changes every file or none.

Usage:

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

`PATCH` is the patch file, or standard input when it is absent or `-`.
See `SPEC.md` in the competition kit for the full contract; this repository
ships the tool itself (`main.ts`, Node 22, standard library only) beside the
kit's `runner.ts`, which runs it over a trial.

License: MIT.
