import { ClipboardAddon } from "@xterm/addon-clipboard";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "xterm";
import { TransportAddon } from "./addons/transport";

const term = new Terminal({
  fontFamily: '"DejaVu Sans Mono", "Everson Mono", FreeMono, Menlo, Terminal, monospace, "Apple Symbols"',
});
const fitAddon = new FitAddon();

term.loadAddon(fitAddon);
term.loadAddon(new ClipboardAddon());
term.loadAddon(new WebLinksAddon());
term.loadAddon(new WebglAddon());
term.loadAddon(new TransportAddon());

term.open(document.body);

fitAddon.fit();

window.addEventListener('resize', () => {
  fitAddon.fit();
});
