import esbuild from "esbuild";
import { builtinModules } from "module";

const prod = process.argv.includes("production");

const context = await esbuild.context({
  entryPoints: ["main.ts"],
  bundle: true,
  // CodeMirror has to come from Obsidian's own instance: a bundled second copy
  // carries its own state system, and decorations built against it never land.
  external: ["obsidian", "electron", "@codemirror/state", "@codemirror/view", ...builtinModules],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
});

if (prod) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
