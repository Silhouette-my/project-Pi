# Chat instruction presets

Select one of the four built-in presets in the session composer's **Chat
instructions** menu. The built-in texts include the v2 peer-review revisions;
no file installation is needed.

To customize one, copy its editable example from
[`chat-instructions/`](chat-instructions/) into either:

- `<workspace>/.pi/chat-instructions/` for one project.
- `~/.pi/agent/chat-instructions/` for all projects.

Then select its filename stem in the session composer's **Chat instructions**
menu. A project preset takes precedence over a global preset with the same ID;
both take precedence over the built-in text. App updates preserve these custom
overrides, so a same-named custom file continues to supply its own text.
Keep any existing file you want to retain before copying a preset with that name.

| Preset ID | Use |
| --- | --- |
| `technical-discussion` | Architecture choices, measurable trade-offs, risks and counterexamples |
| `q-and-a` | Direct answers with the necessary explanation and uncertainty |
| `casual-chat` | Short, natural everyday conversation |
| `exploration` | New perspectives, evidence-led discovery and creative directions |

These Chinese-language examples follow the user's language. Each is a complete
instruction, not an addition to the built-in default. The loader trims outer
whitespace; the remaining content is sent without interpolation.

**Default** uses the short built-in PI-Desktop chat instruction. **None** sends
no system message. Changing the selection rebuilds the remote conversation and
replays its history on the next message.

Copy only the preset files, not this guide: every `.md` file in a preset
directory is offered in the menu, except the reserved `none.md`.

For collaborative review, open [the standalone review sheet](chat-instructions-review.html).
It includes the four prompt texts, design notes and discussion cases. Edits and
comments stay in that page until exported as a new HTML file; they do not update
these Markdown presets or install them in PI-Desktop.
