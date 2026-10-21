---
name: latex
description: Build, diagnose, and install LaTeX toolchains. Compile .tex projects with Tectonic or TeX Live, detect missing TeX tools, and optionally install a managed TeX Live runtime. Use for requests to compile, build, render, or regenerate a .tex file, or to check or repair LaTeX toolchain availability.
---

# LaTeX Toolchain

Three scripts live in `scripts/` next to this document (see the Location line
above). Always invoke them by absolute path with `python3`.

## Compile

Use this for any request to build, render, regenerate, or compile a `.tex` file.

```bash
python3 <skill-dir>/scripts/compile_latex.py /absolute/path/to/main.tex
```

Default `auto` mode uses Tectonic first only when the project looks simple
enough not to need a full TeX Live toolchain. It falls back to TeX Live or
MacTeX when Tectonic fails or when the project uses bibliography, shell-escape,
index/glossary, or explicit non-Tectonic engine features.

Common options:

```bash
python3 <skill-dir>/scripts/compile_latex.py /absolute/path/to/main.tex --compiler tectonic
python3 <skill-dir>/scripts/compile_latex.py /absolute/path/to/main.tex --compiler texlive
python3 <skill-dir>/scripts/compile_latex.py /absolute/path/to/main.tex --engine xelatex
python3 <skill-dir>/scripts/compile_latex.py /absolute/path/to/main.tex --output-directory /absolute/path/to/build
python3 <skill-dir>/scripts/compile_latex.py /absolute/path/to/main.tex --json
```

Compile behavior:

- Detects a PATH Tectonic (or one pointed to by `PI_TECTONIC_PATH`) and any
  existing TeX Live or MacTeX.
- Honors a leading `% !TEX root = ...` directive when present.
- Uses `latexmk` for TeX Live builds when available, with SyncTeX enabled.
- Does not install TeX.

If neither Tectonic nor a usable TeX installation is found, stop and run the
doctor, then offer the installer only when the doctor reports `missing`.

## Diagnose

Use this when the user asks whether LaTeX, Tectonic, TeX Live, MacTeX,
`latexmk`, `pdflatex`, `xelatex`, `lualatex`, `biber`, or `kpsewhich` are
installed or working.

```bash
python3 <skill-dir>/scripts/latex_doctor.py --json
```

Interpret the `status` field:

- `ready`: at least one runtime passed a smoke compile; prefer `auto` mode.
- `existing-usable`: use the existing TeX installation; do not install a
  managed TeX Live.
- `existing-partial`: report the gaps; do not install a managed TeX Live
  unless the user explicitly asks to replace or bypass the partial install.
- `missing`: a managed full TeX Live can be offered through the installer.

Summarize detector status, the Tectonic path and smoke-test result when
available, the detected TeX bin directory and `TEXMFROOT` when available,
missing required or recommended tools, and any smoke-test outcome.

## Install (explicit confirmation required)

Default behavior is detect-only:

```bash
python3 <skill-dir>/scripts/install_texlive.py
```

The script exits without installing when it detects an existing TeX Live or
MacTeX installation.

Only run the full managed install after the user explicitly confirms they want
a managed TeX Live download; the install is large and can take a long time.
Ask for confirmation immediately before running it.

```bash
python3 <skill-dir>/scripts/install_texlive.py --install-managed-full
```

The managed runtime is installed under `~/.cache/pi-desktop-runtimes/pi-texlive/full`.
The installer does not use `sudo`, does not write `/Library/TeX` or
`/usr/local/texlive`, and does not modify shell startup files.

If an existing TeX installation is partial or broken and the user still wants
a separate managed runtime, add `--force-managed`; do not use force mode
unless the user explicitly asks for it.
